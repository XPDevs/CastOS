(function () {
  "use strict";

  var C = window.CastOS;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    session: null,
    transport: null,
    guest: null,
    tab: "pad",
    connected: false,
    ping: 0,
    volume: 50,
    app: "home",
    answer: "",
    wakeLock: null,
    cursor: { x: 0.5, y: 0.5 }
  };

  function setStatus(text, kind) {
    var el = $("a-status");
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function setDot(cls) {
    $("r-dot").className = "dot " + (cls || "off");
  }

  function setTitle(text) {
    $("r-title").textContent = text;
  }

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (err) { /* ignore */ }
  }

  /* ---------- screens ---------- */

  function showScreen(name) {
    $("screen-pair").hidden = name !== "pair";
    $("screen-pad").hidden = name !== "pad";
    $("r-tabs").hidden = name !== "pad";
  }

  function showTab(tab) {
    state.tab = tab;
    ["pad", "touch", "keys", "apps"].forEach(function (name) {
      $(name + "-panel").hidden = name !== tab;
    });
    document.querySelectorAll("#r-tabs .tab").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
    });
    if (tab === "keys") setTimeout(function () { $("k-text").focus(); }, 40);
  }

  /* ---------- pairing ---------- */

  function pairHandlers() {
    return {
      onOpen: function () {
        state.connected = true;
        setDot("live");
        setTitle("connected");
        $("p-ping") && ($("p-ping").textContent = "");
        showScreen("pad");
        showTab("pad");
        requestWakeLock();
        startPing();
      },
      onMessage: function (data) {
        if (!data) return;
        if (data.t === "pong") {
          state.ping = Math.max(1, Date.now() - data.ts);
          $("r-ping").textContent = state.ping + "ms";
        } else if (data.t === "state" && data.s) {
          var s = data.s;
          if (typeof s.v === "number") {
            state.volume = s.v;
            $("vol-label").textContent = (s.m ? "muted" : s.v + "%");
          }
          if (s.a) state.app = s.a;
        } else if (data.t === "ping") {
          state.session && state.session.send({ t: "pong", ts: data.ts });
        }
      },
      onInfo: function () {},
      onClose: function (reason) {
        state.connected = false;
        setDot("bad");
        setTitle("disconnected");
        stopPing();
        releaseWakeLock();
        if (!reason) return;
        showScreen("pair");
        $("card-answer").hidden = true;
        setStatus("link lost - pair again", "err");
        buzz(60);
      },
      onState: function (s) {
        setDot(s === "open" ? "live" : s === "failed" ? "bad" : "wait");
      }
    };
  }

  async function startManualPair(offerBlob) {
    var blob = String(offerBlob || "").trim();
    if (!blob) {
      setStatus("paste the pairing code from the screen", "err");
      return;
    }
    if (blob.indexOf("#") !== -1) {
      var params = C.hashParams();
      if (params.o) blob = params.o;
    }
    setStatus("linking to the screen...");
    setDot("wait");
    try {
      var res = await C.manualGuest(blob, pairHandlers());
      state.session = res.session;
      state.answer = res.blob;
      $("card-answer").hidden = false;
      setStatus("show this code to the screen (camera scan or copy)", "");
      try {
        await C.renderQR($("a-qr"), res.url, 240);
      } catch (err) {
        setStatus("qr unavailable - copy the code instead", "err");
      }
      window.__castosAnswer = res.blob;
    } catch (err) {
      setStatus("pairing failed: " + C.describeError(err), "err");
      setDot("bad");
    }
  }

  async function startRelayPair(code) {
    var clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (clean.length !== 6) {
      setStatus("code must be 6 characters", "err");
      return;
    }
    setStatus("looking for code " + clean + "...");
    setDot("wait");
    try {
      var res = await C.relayGuest(clean, pairHandlers());
      state.session = res.session;
      state.transport = res.relay;
      setStatus("waiting for the screen to answer...", "");
    } catch (err) {
      setStatus("could not reach the local relay: " + C.describeError(err), "err");
      setDot("bad");
    }
  }

  /* ---------- sending ---------- */

  function send(obj) {
    if (!state.session) return false;
    if (!state.session.send(obj)) return false;
    return true;
  }

  function sendKey(key) {
    buzz();
    send(C.msg.key(key));
  }

  function sendCmd(cmd, value) {
    buzz();
    send(C.msg.cmd(cmd, value));
  }

  /* ---------- trackpad ---------- */

  function initTrackpad() {
    var pad = $("trackpad");
    var pointers = [];
    var longTimer = null;
    var scrollMode = false;
    var lastY = 0;
    var moved = 0;
    var startTime = 0;

    function cancelLong() {
      if (longTimer) clearTimeout(longTimer);
      longTimer = null;
    }

    pad.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      pad.setPointerCapture(ev.pointerId);
      pointers.push(ev.pointerId);
      pad.classList.add("pressing");
      if (pointers.length === 2) {
        cancelLong();
        scrollMode = true;
        lastY = ev.clientY;
        return;
      }
      moved = 0;
      startTime = Date.now();
      longTimer = setTimeout(function () {
        longTimer = null;
        buzz(18);
        send(C.msg.click("right"));
      }, 520);
    });

    pad.addEventListener("pointermove", function (ev) {
      if (pointers.indexOf(ev.pointerId) === -1) return;
      ev.preventDefault();
      if (scrollMode) {
        var dy = ev.clientY - lastY;
        lastY = ev.clientY;
        if (Math.abs(dy) > 1) send(C.msg.scroll(Math.round(dy * 1.4)));
        return;
      }
      var dx = ev.movementX || 0;
      var dy2 = ev.movementY || 0;
      if (!dx && !dy2) return;
      moved += Math.abs(dx) + Math.abs(dy2);
      if (moved > 6) cancelLong();
      state.cursor.x = Math.max(0, Math.min(1, state.cursor.x + dx / window.innerWidth));
      state.cursor.y = Math.max(0, Math.min(1, state.cursor.y + dy2 / window.innerHeight));
      send(C.msg.move(state.cursor.x, state.cursor.y));
    });

    function release(ev) {
      var idx = pointers.indexOf(ev.pointerId);
      if (idx !== -1) pointers.splice(idx, 1);
      if (pointers.length === 0) {
        pad.classList.remove("pressing");
        scrollMode = false;
        cancelLong();
        var quick = Date.now() - startTime < 320;
        if (moved < 8 && quick) {
          buzz();
          send(C.msg.click("left"));
        }
      }
    }

    pad.addEventListener("pointerup", release);
    pad.addEventListener("pointercancel", release);
    pad.addEventListener("lostpointercapture", release);
    pad.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

    $("tp-left").addEventListener("click", function () { buzz(); send(C.msg.click("left")); });
    $("tp-right").addEventListener("click", function () { buzz(); send(C.msg.click("right")); });
    $("tp-up").addEventListener("click", function () { buzz(); send(C.msg.scroll(-260)); });
    $("tp-down").addEventListener("click", function () { buzz(); send(C.msg.scroll(260)); });
    $("tp-center").addEventListener("click", function () {
      state.cursor.x = 0.5;
      state.cursor.y = 0.5;
      send(C.msg.move(0.5, 0.5));
    });
  }

  /* ---------- keys + apps panels ---------- */

  var QUICK_KEYS = ["Escape", "Backspace", "Tab", "Enter", " ", "ArrowUp", "ArrowDown",
    "ArrowLeft", "ArrowRight", "Home", "End", "-", "+", "*", "/"];

  function buildKeys() {
    var host = $("k-keys");
    QUICK_KEYS.forEach(function (key) {
      var btn = document.createElement("button");
      btn.className = "btn";
      btn.setAttribute("data-key", key);
      btn.textContent = key.trim() === "" ? "Space" : key;
      host.appendChild(btn);
    });
  }

  var APPS = [
    { id: "home", label: "Home", icon: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>' },
    { id: "browser", label: "Web", icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18"/>' },
    { id: "media", label: "Media", icon: '<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9l5 3-5 3z"/>' },
    { id: "notes", label: "Notes", icon: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>' },
    { id: "photos", label: "Photos", icon: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="8.5" cy="10" r="1.8"/><path d="M4 18l5.5-5 4 3.5L17 12l3 3.5"/>' },
    { id: "settings", label: "Setup", icon: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.2 7.2l2.2 1.3M17.6 15.5l2.2 1.3"/>' }
  ];

  var ACTIONS = [
    { cmd: "pair", label: "Pair", icon: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/>' },
    { cmd: "fullscreen", label: "Full", icon: '<path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/>' },
    { cmd: "reload", label: "Reload", icon: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>' },
    { cmd: "mute", label: "Mute", icon: '<path d="M4 9v6h3l5 4V5L7 9z"/><path d="M17 9l4 6M21 9l-4 6"/>' },
    { cmd: "playpause", label: "Play", icon: '<path d="M8 5l11 7-11 7z"/>' },
    { cmd: "power", label: "Power", icon: '<path d="M12 3v9"/><path d="M7 6.5a7 7 0 1 0 10 0"/>' }
  ];

  function buildApps() {
    var host = $("app-grid");
    host.innerHTML = "";
    APPS.concat(ACTIONS).forEach(function (item) {
      var btn = document.createElement("button");
      btn.className = "app-btn";
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
        item.icon + "</svg><span>" + item.label + "</span>";
      if (item.id) btn.setAttribute("data-app", item.id);
      else btn.setAttribute("data-cmd", item.cmd);
      host.appendChild(btn);
    });
  }

  /* ---------- keep alive ---------- */

  var pingTimer = null;

  function startPing() {
    stopPing();
    var tick = function () {
      send(C.msg.ping(Date.now()));
    };
    tick();
    pingTimer = setInterval(tick, 2500);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator) {
        state.wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (err) { /* ignore */ }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      try { state.wakeLock.release(); } catch (err) { /* ignore */ }
      state.wakeLock = null;
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.connected) requestWakeLock();
  });

  function readBattery() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(function (battery) {
      var render = function () {
        var pct = Math.round(battery.level * 100);
        var el = $("r-batt");
        el.hidden = false;
        el.textContent = pct + "%" + (battery.charging ? "+" : "");
      };
      battery.addEventListener("levelchange", render);
      battery.addEventListener("chargingchange", render);
      render();
    }).catch(function () { /* ignore */ });
  }

  /* ---------- camera scan of the TV code ---------- */

  var scanStream = null;
  var scanLoop = null;

  function canScan() {
    return typeof window.BarcodeDetector === "function" &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  }

  async function startScan() {
    if (!canScan()) {
      setStatus("camera scanning is not supported here - paste the code", "err");
      return;
    }
    try {
      var formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.indexOf("qr_code") === -1) {
        setStatus("qr scanning is unavailable in this browser", "err");
        return;
      }
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      $("scan-overlay").hidden = false;
      var video = $("scan-video");
      video.srcObject = scanStream;
      await video.play();
      var detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      scanLoop = setInterval(async function () {
        try {
          var found = await detector.detect(video);
          if (found && found.length) {
            var raw = found[0].rawValue || "";
            stopScan();
            startManualPair(raw);
          }
        } catch (err) { /* keep scanning */ }
      }, 300);
    } catch (err) {
      stopScan();
      setStatus("camera error: " + C.describeError(err), "err");
    }
  }

  function stopScan() {
    if (scanLoop) clearInterval(scanLoop);
    scanLoop = null;
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
    }
    $("scan-overlay").hidden = true;
  }

  /* ---------- wiring ---------- */

  function wire() {
    document.querySelectorAll("#r-tabs .tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        buzz();
        showTab(btn.getAttribute("data-tab"));
      });
    });

    document.addEventListener("click", function (ev) {
      var keyBtn = ev.target.closest && ev.target.closest("[data-key]");
      if (keyBtn) { sendKey(keyBtn.getAttribute("data-key")); return; }
      var cmdBtn = ev.target.closest && ev.target.closest("[data-cmd]");
      if (cmdBtn) { sendCmd(cmdBtn.getAttribute("data-cmd")); return; }
      var appBtn = ev.target.closest && ev.target.closest("[data-app]");
      if (appBtn) { sendCmd("app", appBtn.getAttribute("data-app")); return; }
    });

    $("p-go").addEventListener("click", function () {
      startManualPair($("p-code").value);
    });
    $("p-scan").addEventListener("click", startScan);
    $("scan-cancel").addEventListener("click", stopScan);
    $("r-go").addEventListener("click", function () {
      startRelayPair($("r-code").value);
    });
    $("r-code").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") startRelayPair($("r-code").value);
    });

    $("a-copy").addEventListener("click", function () {
      var blob = window.__castosAnswer || "";
      if (!blob) { setStatus("no code yet", "err"); return; }
      C.copy(blob).then(function (ok) {
        setStatus(ok ? "code copied - paste it on the screen" : "copy failed", ok ? "ok" : "err");
      });
    });
    $("a-share").addEventListener("click", function () {
      var blob = window.__castosAnswer || "";
      if (navigator.share && blob) {
        navigator.share({ title: "CastOS answer code", text: blob }).catch(function () { /* ignore */ });
      } else {
        C.copy(blob).then(function (ok) {
          setStatus(ok ? "code copied" : "sharing is not supported here", ok ? "ok" : "err");
        });
      }
    });

    $("k-send").addEventListener("click", function () {
      var text = $("k-text").value;
      if (!text) return;
      send(C.msg.text(text));
      buzz();
      $("k-text").value = "";
    });
    $("k-text").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        $("k-send").click();
      }
    });
    $("k-open").addEventListener("click", function () {
      var value = $("k-url").value.trim();
      if (!value) return;
      var youtube = value.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
      if (youtube) sendCmd("media", youtube[1]);
      else sendCmd("open", value);
      buzz();
    });
    $("k-play").addEventListener("click", function () {
      var value = $("k-url").value.trim();
      if (value) sendCmd("media", value);
      buzz();
    });

    $("r-menu").addEventListener("click", function () {
      if (state.connected) {
        showScreen("pair");
        $("card-answer").hidden = false;
        setStatus("linked - keep this page open");
      } else {
        showScreen("pair");
      }
    });
  }

  /* ---------- init ---------- */

  function init() {
    buildKeys();
    buildApps();
    initTrackpad();
    wire();
    readBattery();
    showScreen("pair");

    var params = C.hashParams();
    if (params.o) {
      setStatus("pairing code found in link");
      startManualPair(params.o);
    } else if (params.c) {
      startRelayPair(params.c);
    } else {
      setStatus("scan the code shown on the CastOS screen", "");
    }

    setDot("wait");
    setTitle("CastOS remote");
    try { document.body.addEventListener("touchmove", function (e) { e.preventDefault(); }, { passive: false }); }
    catch (err) { /* ignore */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CastOSRemote = { state: state, send: send, showTab: showTab };
})();
