#!/usr/bin/env python3
"""Static server for the ambient screensaver.

Everything it serves is same-origin: the page loads local wallpapers, local
fonts and local scripts, so any static server works. This one is convenient
because it serves the project root with the right MIME types.

    python3 tools/serve.py --port 8080
    open http://localhost:8080/
"""
import argparse
import mimetypes
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(BaseHTTPRequestHandler):
    server_version = "Ambient/1.0"

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path.endswith("/"):
            path += "index.html"

        resolved = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if resolved != ROOT and not resolved.startswith(ROOT + os.sep):
            self.respond(403, "text/plain; charset=utf-8", b"forbidden")
            return
        if not os.path.isfile(resolved):
            self.respond(404, "text/plain; charset=utf-8", b"not found")
            return

        content_type = mimetypes.guess_type(resolved)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "application/json",
        ):
            content_type += "; charset=utf-8"

        with open(resolved, "rb") as handle:
            self.respond(200, content_type, handle.read())

    def respond(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Serve the ambient screensaver.")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Ambient screensaver on http://%s:%d/" % (args.host, args.port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
