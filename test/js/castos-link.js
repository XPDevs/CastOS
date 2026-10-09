(function (global) {
  "use strict";

  var CastOS = global.CastOS;

  function deviceName() {
    var ua = navigator.userAgent;
    var name = "Remote";
    if (/Android/i.test(ua)) name = "Android device";
    else if (/iPhone|iPad|iPod/i.test(ua)) name = "iOS device";
    else if (/Windows/i.test(ua)) name = "Windows PC";
    else if (/Macintosh|Mac OS X/i.test(ua)) name = "Mac";
    else if (/Linux/i.test(ua)) name = "Linux PC";
    else if (/SmartTV|Tizen|Web0S|WebOS/i.test(ua)) name = "TV";
    return name;
  }

  CastOS.deviceName = deviceName;

  function postJSON(path, body, timeout) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", path, true);
      xhr.timeout = timeout || 8000;
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText || "{}")); }
          catch (err) { reject(new Error("bad response")); }
        } else {
          reject(new Error("http " + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error("network error")); };
      xhr.ontimeout = function () { reject(new Error("timeout")); };
      xhr.send(JSON.stringify(body || {}));
    });
  }

  CastOS.postJSON = postJSON;

  function Session(role, opts) {
    opts = opts || {};
    this.role = role;
    this.onOpen = opts.onOpen || function () {};
    this.onMessage = opts.onMessage || function () {};
    this.onClose = opts.onClose || function () {};
    this.onState = opts.onState || function () {};
    this.onInfo = opts.onInfo || function () {};
    this.pc = null;
    this.dc = null;
    this.opened = false;
    this.disposed = false;
    this.lastState = "new";
  }

  Session.prototype.setState = function (state) {
    if (this.lastState === state) return;
    this.lastState = state;
    this.onState(state);
  };

  Session.prototype.createPeer = function () {
    var self = this;
    var pc = CastOS.peerConnection();
    this.pc = pc;
    pc.onconnectionstatechange = function () {
      var s = pc.connectionState;
      if (s === "connected") self.setState("open");
      else if (s === "connecting") self.setState("connecting");
      else if (s === "disconnected") self.setState("unstable");
      else if (s === "failed") { self.setState("failed"); self.onClose("failed"); }
      else if (s === "closed") { self.setState("closed"); }
    };
    pc.oniceconnectionstatechange = function () {
      var s = pc.iceConnectionState;
      if (s === "failed") self.setState("failed");
      else if (s === "checking") self.setState("checking");
      else if (s === "disconnected") self.setState("unstable");
    };
    return pc;
  };

  Session.prototype.attachChannel = function (dc) {
    var self = this;
    this.dc = dc;
    dc.onopen = function () {
      self.opened = true;
      self.setState("open");
      self.onOpen();
    };
    dc.onclose = function () {
      self.opened = false;
      self.setState("closed");
      self.onClose("closed");
    };
    dc.onerror = function (ev) {
      self.onClose((ev && ev.error && ev.error.message) || "channel error");
    };
    dc.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (err) { return; }
      if (data && data.t === "hello") {
        self.onInfo(data.i || {});
        return;
      }
      self.onMessage(data);
    };
  };

  Session.prototype.send = function (obj) {
    if (!this.dc || this.dc.readyState !== "open") return false;
    try {
      this.dc.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      return false;
    }
  };

  Session.prototype.greet = function (info) {
    this.send(CastOS.msg.hello(info));
  };

  Session.prototype.close = function (reason) {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this.dc) this.dc.close(); } catch (err) { /* ignore */ }
    try { if (this.pc) this.pc.close(); } catch (err) { /* ignore */ }
    this.opened = false;
    this.onClose(reason || "closed");
  };

  CastOS.Session = Session;

  async function manualHost(opts) {
    var session = new Session("host", opts);
    var pc = session.createPeer();
    var dc = pc.createDataChannel("castos", { ordered: true });
    session.attachChannel(dc);
    session.setState("preparing");

    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await CastOS.waitIce(pc, 5000);

    var blob = await CastOS.pack({
      o: pc.localDescription.sdp,
      n: deviceName(),
      v: CastOS.version
    });

    return {
      session: session,
      blob: blob,
      url: CastOS.remoteUrl({ o: blob }),
      finish: async function (answerBlob) {
        var data = await CastOS.unpack(String(answerBlob || "").trim());
        if (!data || !data.a) throw new Error("That answer code is not valid.");
        await pc.setRemoteDescription({ type: "answer", sdp: data.a });
        session.onInfo({ name: data.n || "Remote" });
        return data.n || "Remote";
      }
    };
  }

  async function manualGuest(offerBlob, opts) {
    var data = await CastOS.unpack(String(offerBlob || "").trim());
    if (!data || !data.o) throw new Error("That pairing code is not valid.");

    var session = new Session("guest", opts);
    var pc = session.createPeer();
    pc.ondatachannel = function (ev) { session.attachChannel(ev.channel); };
    session.setState("preparing");

    await pc.setRemoteDescription({ type: "offer", sdp: data.o });
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await CastOS.waitIce(pc, 5000);

    var blob = await CastOS.pack({
      a: pc.localDescription.sdp,
      n: deviceName()
    });

    return {
      session: session,
      blob: blob,
      url: CastOS.receiverUrl({ a: blob }),
      hostName: data.n || "CastOS device"
    };
  }

  CastOS.manualHost = manualHost;
  CastOS.manualGuest = manualGuest;

  function RelayTransport(code, pid, handlers) {
    this.code = code;
    this.pid = pid;
    this.onMessage = handlers.onMessage || function () {};
    this.onState = handlers.onState || function () {};
    this.onOpen = handlers.onOpen || function () {};
    this.onPeers = handlers.onPeers || function () {};
    this.mode = "idle";
    this.ws = null;
    this.seq = 0;
    this.closed = false;
    this.reconnect = 0;
    this.timer = null;
    this.origin = global.location.origin;
  }

  RelayTransport.prototype.setState = function (mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onState(mode);
  };

  RelayTransport.prototype.start = function () {
    var self = this;
    this.setState("connecting");
    var wsUrl = (this.origin.replace(/^http/, "ws")) + "/signal?room=" +
      encodeURIComponent(this.code) + "&peer=" + encodeURIComponent(this.pid);
    var failed = false;
    try {
      var ws = new WebSocket(wsUrl);
      this.ws = ws;
      var opened = false;
      ws.onopen = function () {
        opened = true;
        self.setState("ws");
        self.onOpen();
      };
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        self.handle(msg);
      };
      ws.onerror = function () { failed = true; };
      ws.onclose = function () {
        self.ws = null;
        if (self.closed) { self.setState("closed"); return; }
        if (opened) {
          self.reconnect += 1;
          if (self.reconnect <= 20) setTimeout(function () { self.start(); }, 900);
          else self.setState("failed");
        } else {
          self.startPolling();
        }
      };
    } catch (err) {
      failed = true;
    }
    setTimeout(function () {
      if (!opened && !self.closed && self.mode === "connecting") self.startPolling();
    }, 2500);
  };

  RelayTransport.prototype.startPolling = function () {
    var self = this;
    if (this.closed) return;
    this.setState("poll");
    this.onOpen();
    var loop = function () {
      if (self.closed) return;
      var url = self.origin + "/api/poll?room=" + encodeURIComponent(self.code) +
        "&from=" + encodeURIComponent(self.pid) + "&since=" + self.seq + "&wait=25";
      fetch(url).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.ok) {
          self.seq = res.since || self.seq;
          if (res.msgs && res.msgs.length) {
            res.msgs.forEach(function (m) { self.handle({ op: "relay", data: m.data }); });
          }
        }
        self.timer = setTimeout(loop, 50);
      }).catch(function () {
        self.timer = setTimeout(loop, 1500);
      });
    };
    loop();
  };

  RelayTransport.prototype.handle = function (msg) {
    if (!msg) return;
    if (msg.op === "relay") {
      this.onMessage(msg.data, msg.from);
      return;
    }
    if (msg.op === "peer") { this.onPeers(msg.peers || 1); return; }
    if (msg.op === "joined") { this.onPeers(msg.peers || 1); return; }
    if (msg.op === "pong") return;
  };

  RelayTransport.prototype.send = function (data) {
    var body = JSON.stringify({ room: this.code, from: this.pid, data: data });
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ op: "relay", data: data }));
      return;
    }
    if (this.mode === "poll" || this.mode === "ws") {
      postJSON("/api/push", JSON.parse(body)).catch(function () { /* ignore */ });
    }
  };

  RelayTransport.prototype.close = function () {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch (err) { /* ignore */ } }
    this.ws = null;
    this.setState("closed");
  };

  CastOS.RelayTransport = RelayTransport;

  async function relayHost(opts) {
    var res = await postJSON("/api/room", {});
    var code = res.code;
    var pid = res.you;
    var session = new Session("host", opts);
    var pc = session.createPeer();
    var dc = pc.createDataChannel("castos", { ordered: true });
    session.attachChannel(dc);
    session.setState("preparing");

    var relay = new RelayTransport(code, pid, {
      onMessage: function (data) {
        if (!data) return;
        if (data.t === "desc") {
          pc.setRemoteDescription({ type: "answer", sdp: data.d.sdp }).catch(function () {});
        } else if (data.t === "ice") {
          if (data.c) pc.addIceCandidate(data.c).catch(function () {});
        } else {
          session.onMessage(data);
        }
      },
      onPeers: function () {},
      onOpen: function () {}
    });
    relay.start();

    var pending = [];
    pc.onicecandidate = function (ev) {
      if (ev.candidate) relay.send({ t: "ice", c: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
      else if (pending.length) {
        pending.forEach(function (c) { relay.send({ t: "ice", c: c }); });
        pending = [];
      }
    };
    pc.onicegatheringstatechange = function () {
      if (pc.iceGatheringState === "complete" && pending.length) {
        pending.forEach(function (c) { relay.send({ t: "ice", c: c }); });
        pending = [];
      }
    };

    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    setTimeout(function () {
      if (pending.length) {
        pending.forEach(function (c) { relay.send({ t: "ice", c: c }); });
        pending = [];
      }
    }, 3000);

    return {
      session: session,
      relay: relay,
      code: code,
      send: function (obj) { relay.send(obj); },
      close: function () { relay.close(); session.close("closed"); }
    };
  }

  async function relayGuest(code, opts) {
    var res = await postJSON("/api/join", { room: code });
    var pid = res.you;
    var session = new Session("guest", opts);
    var pc = session.createPeer();
    pc.ondatachannel = function (ev) { session.attachChannel(ev.channel); };
    session.setState("preparing");

    var relay = new RelayTransport(code, pid, {
      onMessage: function (data) {
        if (!data) return;
        if (data.t === "desc") {
          pc.setRemoteDescription({ type: "offer", sdp: data.d.sdp }).catch(function () {});
        } else if (data.t === "ice") {
          if (data.c) pc.addIceCandidate(data.c).catch(function () {});
        } else {
          session.onMessage(data);
        }
      }
    });
    relay.start();

    pc.onicecandidate = function (ev) {
      if (ev.candidate) relay.send({ t: "ice", c: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate });
    };

    return {
      session: session,
      relay: relay,
      code: code,
      send: function (obj) { relay.send(obj); },
      close: function () { relay.close(); session.close("closed"); }
    };
  }

  CastOS.relayHost = relayHost;
  CastOS.relayGuest = relayGuest;
})(window);
