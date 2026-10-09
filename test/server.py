#!/usr/bin/env python3
import base64
import hashlib
import json
import os
import queue
import socket
import struct
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
}

MAX_BODY = 4 * 1024 * 1024
ROOM_TTL = 3600
INBOX_TTL = 300
POLL_WAIT = 25.0
BLOCKED_FILES = {"server.py", "start.cmd", "start.sh", ".env", "package-lock.json"}


def log(msg):
    sys.stdout.write("[castos] %s\n" % msg)
    sys.stdout.flush()


class Peer:
    __slots__ = ("pid", "room", "ws", "send_lock", "inbox", "joined_at", "closing")

    def __init__(self, pid, room):
        self.pid = pid
        self.room = room
        self.ws = None
        self.send_lock = threading.Lock()
        self.inbox = []
        self.joined_at = time.time()
        self.closing = False


class Room:
    __slots__ = ("code", "peers", "created_at")

    def __init__(self, code):
        self.code = code
        self.peers = {}
        self.created_at = time.time()

    def others(self, pid):
        return [p for p in self.peers.values() if p.pid != pid]

    def touch(self):
        self.created_at = time.time()


class Hub:
    def __init__(self):
        self.rooms = {}
        self.lock = threading.RLock()

    def new_code(self):
        with self.lock:
            for _ in range(200):
                code = "".join(CODE_ALPHABET[b % len(CODE_ALPHABET)]
                               for b in os.urandom(6))
                if code not in self.rooms:
                    return code
            return uuid.uuid4().hex[:6].upper()

    def join(self, code):
        code = (code or "").strip().upper()
        if not code:
            raise ValueError("missing code")
        with self.lock:
            room = self.rooms.get(code)
            if room is None:
                room = Room(code)
                self.rooms[code] = room
            peer = Peer(uuid.uuid4().hex[:10], room)
            room.peers[peer.pid] = peer
            room.touch()
            self.sweep()
            return peer

    def leave(self, peer):
        with self.lock:
            room = peer.room
            if room and peer.pid in room.peers:
                del room.peers[peer.pid]
            if room and not room.peers:
                self.rooms.pop(room.code, None)
            elif room:
                room.touch()

    def relay(self, peer, data):
        with self.lock:
            room = peer.room
            if room is None:
                return 0
            targets = room.others(peer.pid)
            room.touch()
        sent = 0
        for target in targets:
            envelope = {"op": "relay", "data": data, "from": peer.pid}
            if target.ws is not None:
                ok = ws_send(target, envelope)
                if ok:
                    sent += 1
                else:
                    target.inbox.append({"data": data, "from": peer.pid})
                    target.inbox = target.inbox[-200:]
                    sent += 1
            else:
                target.inbox.append({"data": data, "from": peer.pid})
                if len(target.inbox) > 200:
                    del target.inbox[:-200]
                sent += 1
        return sent

    def broadcast_room(self, room, payload, skip=None):
        with self.lock:
            peers = [p for p in room.peers.values() if p.pid != skip]
        for p in peers:
            if p.ws is not None:
                ws_send(p, payload)

    def count(self, room):
        with self.lock:
            return len(room.peers)

    def sweep(self):
        now = time.time()
        dead = [code for code, room in self.rooms.items()
                if not room.peers or now - room.created_at > ROOM_TTL]
        for code in dead:
            self.rooms.pop(code, None)


HUB = Hub()


def ws_accept_key(key):
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def ws_send(peer, obj):
    payload = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    frame = encode_frame(1, payload)
    sock = peer.ws
    if sock is None:
        return False
    with peer.send_lock:
        try:
            sock.sendall(frame)
            return True
        except OSError:
            return False


def ws_send_raw(sock, lock, opcode, payload):
    frame = encode_frame(opcode, payload)
    with lock:
        try:
            sock.sendall(frame)
            return True
        except OSError:
            return False


def encode_frame(opcode, payload):
    header = bytearray()
    header.append(0x80 | opcode)
    n = len(payload)
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", n))
    return bytes(header) + payload


def read_exact(sock, n):
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def ws_reader(sock, peer, lock):
    sock.settimeout(120)
    fragments = []
    frag_opcode = None
    try:
        while not peer.closing:
            try:
                header = read_exact(sock, 2)
            except socket.timeout:
                if not ws_send_raw(sock, lock, 9, b""):
                    break
                continue
            if header is None:
                break
            b1, b2 = header[0], header[1]
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                ext = read_exact(sock, 2)
                if ext is None:
                    break
                length = struct.unpack("!H", ext)[0]
            elif length == 127:
                ext = read_exact(sock, 8)
                if ext is None:
                    break
                length = struct.unpack("!Q", ext)[0]
            if length > MAX_BODY:
                break
            mask = read_exact(sock, 4) if masked else None
            payload = read_exact(sock, length) if length else b""
            if payload is None:
                break
            if mask:
                payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))

            if opcode == 8:
                break
            if opcode == 9:
                ws_send_raw(sock, lock, 10, payload)
                continue
            if opcode == 10:
                continue
            if opcode in (1, 2):
                fragments = [payload]
                frag_opcode = opcode
            elif opcode == 0:
                fragments.append(payload)
            else:
                continue

            if not fin:
                continue
            data = b"".join(fragments)
            fragments = []
            opcode = frag_opcode
            frag_opcode = None
            if opcode == 1:
                handle_ws_message(peer, data)
    except OSError:
        pass
    finally:
        peer.closing = True
        peer.ws = None
        HUB.leave(peer)


def handle_ws_message(peer, data):
    try:
        msg = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return
    if not isinstance(msg, dict):
        return
    op = msg.get("op")

    if op == "relay":
        HUB.relay(peer, msg.get("data"))
        return
    if op == "ping":
        ws_send(peer, {"op": "pong", "ts": msg.get("ts")})
        return
    if op == "count":
        ws_send(peer, {"op": "count", "peers": HUB.count(peer.room)})
        return
    if op == "close":
        peer.closing = True
        return


def ws_upgrade(handler, peer):
    sock = handler.connection
    lock = threading.Lock()
    peer.ws = sock
    peer.send_lock = lock
    peer.inbox = []
    ws_send(peer, {"op": "joined", "you": peer.pid,
                   "peers": HUB.count(peer.room)})
    HUB.broadcast_room(peer.room, {"op": "peer", "state": "join",
                                   "peers": HUB.count(peer.room),
                                   "pid": peer.pid}, skip=peer.pid)
    ws_reader(sock, peer, lock)
    HUB.broadcast_room(peer.room, {"op": "peer", "state": "leave",
                                   "peers": HUB.count(peer.room),
                                   "pid": peer.pid}, skip=peer.pid)


def read_body(handler):
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0:
        return b""
    if length > MAX_BODY:
        raise ValueError("body too large")
    return handler.rfile.read(length)


def send_json(handler, obj, status=200):
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def wait_for_inbox(peer, since, wait=None):
    deadline = time.time() + (POLL_WAIT if wait is None else wait)
    while True:
        with HUB.lock:
            peer.room.touch() if peer.room else None
            inbox = peer.inbox
            if len(inbox) > since:
                return inbox[since:]
        if time.time() >= deadline:
            return []
        time.sleep(0.1)


class Handler(BaseHTTPRequestHandler):
    server_version = "CastOS/2"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/health":
            send_json(self, {"ok": True, "app": "castos", "rooms": len(HUB.rooms)})
            return
        if path == "/api/room":
            send_json(self, {"code": HUB.new_code()})
            return
        if path == "/api/info":
            send_json(self, {"ok": True, "app": "castos",
                             "origin": self.origin(), "rooms": len(HUB.rooms)})
            return
        if path == "/api/poll":
            self.handle_poll(query)
            return
        if path == "/signal":
            self.handle_signal(query)
            return
        self.serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            raw = read_body(self)
        except ValueError:
            send_json(self, {"ok": False, "error": "body too large"}, status=413)
            return
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(body, dict):
                body = {}
        except (ValueError, UnicodeDecodeError):
            send_json(self, {"ok": False, "error": "invalid json"}, status=400)
            return

        if path == "/api/room":
            code = HUB.new_code()
            peer = HUB.join(code)
            send_json(self, {"ok": True, "code": code, "you": peer.pid,
                             "peers": HUB.count(peer.room)})
            return
        if path == "/api/join":
            peer = HUB.join(body.get("room"))
            send_json(self, {"ok": True, "you": peer.pid,
                             "peers": HUB.count(peer.room)})
            return
        if path == "/api/push":
            room_code = (body.get("room") or "").strip().upper()
            peer = HUB.join(room_code)
            HUB.relay(peer, body.get("data"))
            send_json(self, {"ok": True, "peers": HUB.count(peer.room)})
            return
        send_json(self, {"ok": False, "error": "not found"}, status=404)

    def handle_poll(self, query):
        room_code = (query.get("room", [""])[0] or "").strip().upper()
        pid = (query.get("from", [""])[0] or "").strip()
        try:
            since = int(query.get("since", ["0"])[0])
        except ValueError:
            since = 0
        try:
            wait = float(query.get("wait", [str(POLL_WAIT)])[0])
        except ValueError:
            wait = POLL_WAIT
        wait = min(max(wait, 0.0), 30.0)
        peer = HUB.join(room_code)
        peer.pid = pid or peer.pid
        if peer.ws is None:
            peer.inbox = []
        msgs = wait_for_inbox(peer, since, wait)
        send_json(self, {"ok": True, "peers": HUB.count(peer.room),
                         "msgs": msgs, "since": since + len(msgs)})

    def handle_signal(self, query):
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if upgrade != "websocket":
            send_json(self, {"ok": False, "error": "websocket required"}, status=426)
            return
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            send_json(self, {"ok": False, "error": "bad handshake"}, status=400)
            return

        room_code = (query.get("room", [""])[0] or "").strip().upper()
        pid = (query.get("peer", [""])[0] or "").strip()
        try:
            peer = HUB.join(room_code)
        except ValueError:
            send_json(self, {"ok": False, "error": "missing code"}, status=400)
            return
        if pid:
            peer.pid = pid

        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", ws_accept_key(key))
        self.end_headers()
        self.close_connection = True
        log("ws peer %s joined room %s (peers=%d)" % (peer.pid, room_code,
                                                      HUB.count(peer.room)))
        ws_upgrade(self, peer)

    def origin(self):
        host = self.headers.get("Host")
        if host:
            return "http://%s" % host
        return "http://%s:%d" % (self.server.server_name, self.server.server_port)

    def serve_static(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean in ("", "/"):
            clean = "/index.html"
        clean = os.path.normpath(clean).replace("\\", "/")
        if clean.startswith("/"):
            clean = clean[1:]
        if clean.startswith("..") or os.path.isabs(clean):
            self.send_error(403)
            return
        parts = [p for p in clean.split("/") if p not in ("", ".")]
        if any(p.startswith(".") for p in parts):
            self.send_error(403)
            return
        if parts and parts[0] in (".git", "server.py"):
            self.send_error(403)
            return
        full = os.path.join(ROOT, *parts) if parts else ROOT
        if not os.path.abspath(full).startswith(os.path.abspath(ROOT)):
            self.send_error(403)
            return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            fallback = os.path.join(ROOT, "404.html")
            if os.path.isfile(fallback):
                self.serve_file(fallback, 404)
            else:
                self.send_error(404)
            return
        base = os.path.basename(full).lower()
        if base in BLOCKED_FILES or base.startswith("."):
            self.send_error(403)
            return
        self.serve_file(full, 200)

    def serve_file(self, full, status):
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            size = os.path.getsize(full)
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def lan_addresses():
    found = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        found.append(sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addr = info[4][0]
            if addr not in found and not addr.startswith("127."):
                found.append(addr)
    except OSError:
        pass
    return found


def default_port():
    env = os.environ.get("CASTOS_PORT")
    if env and env.isdigit():
        return int(env)
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg.isdigit():
            return int(arg)
        if arg.startswith("--port=") and arg.split("=", 1)[1].isdigit():
            return int(arg.split("=", 1)[1])
    return 8000


def main():
    port = default_port()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    log("CastOS host listening on port %d" % port)
    log("open  http://127.0.0.1:%d  on this computer" % port)
    for addr in lan_addresses():
        log("phone http://%s:%d  (same wifi)" % (addr, port))
    log("different network: put this computer on a public address (router port")
    log("forward %d, or a tunnel) and open that URL from the phone." % port)
    log("press ctrl+c to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
