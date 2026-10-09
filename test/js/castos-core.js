(function (global) {
  "use strict";

  var ICE_SERVERS = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302",
             "stun:stun2.l.google.com:19302"] },
    { urls: ["stun:stun.cloudflare.com:3478"] },
    { urls: ["stun:global.stun.twilio.com:3478"] }
  ];

  var CastOS = {
    version: 3,
    iceServers: ICE_SERVERS,
    chunk: 0x8000
  };

  function base64urlEncode(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i += CastOS.chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CastOS.chunk));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlDecode(text) {
    var normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    var raw = atob(normalized);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function pack(obj) {
    var text = JSON.stringify(obj);
    var bytes = new TextEncoder().encode(text);
    if (typeof CompressionStream === "function") {
      try {
        var stream = new Blob([bytes]).stream()
          .pipeThrough(new CompressionStream("deflate-raw"));
        var compressed = new Uint8Array(await new Response(stream).arrayBuffer());
        if (compressed.length < bytes.length) return base64urlEncode(compressed);
      } catch (err) { /* fall through to plain */ }
    }
    return base64urlEncode(bytes);
  }

  async function unpack(text) {
    var bytes = base64urlDecode(text);
    if (typeof DecompressionStream === "function") {
      try {
        var stream = new Blob([bytes]).stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));
        var json = await new Response(stream).text();
        return JSON.parse(json);
      } catch (err) { /* fall through to plain */ }
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  CastOS.pack = pack;
  CastOS.unpack = unpack;

  function qrAvailable() {
    return typeof global.QRCode === "function";
  }

  function renderQR(el, text, size) {
    if (!el) return Promise.reject(new Error("missing target"));
    if (!qrAvailable()) {
      return Promise.reject(new Error("QR generator missing"));
    }
    return new Promise(function (resolve, reject) {
      try {
        var px = size || 260;
        var opts = {
          text: text,
          width: px,
          height: px,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: global.QRCode.CorrectLevel.L
        };
        if (text.length > 1200) opts.correctLevel = global.QRCode.CorrectLevel.M;
        el.innerHTML = "";
        var instance = new global.QRCode(el, opts);
        var canvas = el.querySelector("canvas");
        var img = el.querySelector("img");
        [canvas, img].forEach(function (node) {
          if (!node) return;
          node.style.width = "100%";
          node.style.height = "auto";
          node.style.display = "block";
          node.style.imageRendering = "pixelated";
        });
        resolve(instance);
      } catch (err) {
        reject(err);
      }
    });
  }

  CastOS.renderQR = renderQR;
  CastOS.qrAvailable = qrAvailable;

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; });
    }
    return new Promise(function (resolve) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      document.body.removeChild(ta);
      resolve(ok);
    });
  }

  CastOS.copy = copyText;

  function hashParams() {
    var hash = global.location.hash.replace(/^#/, "");
    var out = {};
    hash.split("&").forEach(function (part) {
      if (!part) return;
      var idx = part.indexOf("=");
      var key = idx === -1 ? part : part.slice(0, idx);
      var value = idx === -1 ? "" : part.slice(idx + 1);
      try { out[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " ")); }
      catch (err) { out[key] = value; }
    });
    return out;
  }

  CastOS.hashParams = hashParams;

  function baseDir() {
    var path = global.location.pathname.replace(/[^/]*$/, "");
    return global.location.origin + path;
  }

  CastOS.baseDir = baseDir;

  CastOS.remoteUrl = function (params) {
    var parts = [];
    Object.keys(params).forEach(function (key) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
    });
    return baseDir() + "remote.html#" + parts.join("&");
  };

  CastOS.receiverUrl = function (params) {
    var parts = [];
    Object.keys(params).forEach(function (key) {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(params[key]));
    });
    return baseDir() + "receiver.html#" + parts.join("&");
  };

  function waitIce(pc, timeout) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve();
      }, timeout || 5000);
      function check() {
        if (pc.iceGatheringState === "complete" && !done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      }
      pc.onicegatheringstatechange = check;
      pc.onicecandidate = function (ev) {
        if (!ev.candidate) check();
      };
      setTimeout(check, 60);
    });
  }

  function peerConnection(config) {
    return new RTCPeerConnection(config || { iceServers: ICE_SERVERS });
  }

  CastOS.peerConnection = peerConnection;
  CastOS.waitIce = waitIce;

  CastOS.msg = {
    key: function (k) { return { t: "key", k: k }; },
    move: function (x, y) { return { t: "move", x: x, y: y }; },
    click: function (button) { return { t: "click", b: button || "left" }; },
    scroll: function (dy) { return { t: "scroll", dy: dy }; },
    text: function (s) { return { t: "text", s: s }; },
    vol: function (delta) { return { t: "vol", d: delta }; },
    cmd: function (c, value) { return { t: "cmd", c: c, v: value }; },
    ping: function (ts) { return { t: "ping", ts: ts }; },
    hello: function (info) { return { t: "hello", i: info }; },
    state: function (state) { return { t: "state", s: state }; },
    log: function (line) { return { t: "log", l: line }; }
  };

  function describeError(err) {
    if (!err) return "unknown error";
    if (typeof err === "string") return err;
    return err.message || err.name || String(err);
  }

  CastOS.describeError = describeError;

  global.CastOS = CastOS;
})(window);
