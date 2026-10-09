(function () {
  "use strict";

  var C = window.CastOS;
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    volume: 0.5,
    muted: false,
    app: "home",
    name: "CastOS Screen",
    connected: false,
    remoteName: "",
    link: null,
    session: null,
    offer: null,
    startedAt: Date.now(),
    ping: 0
  };

  var prefs = {
    name: "CastOS Screen",
    wallpaper: "assets/wallpaper.jpg"
  };

  function loadPrefs() {
    try {
      var raw = localStorage.getItem("castos.prefs");
      if (raw) prefs = Object.assign(prefs, JSON.parse(raw));
    } catch (err) { /* defaults */ }
    prefs.name = prefs.name || "CastOS Screen";
    state.name = prefs.name;
    $("device-name").textContent = prefs.name;
    $("set-name").value = prefs.name;
    applyWallpaper(prefs.wallpaper);
    $("set-wall").value = prefs.wallpaper;
  }

  function savePrefs() {
    try { localStorage.setItem("castos.prefs", JSON.stringify(prefs)); } catch (err) { /* ignore */ }
  }

  var WALLPAPERS = {
    "assets/wallpaper.jpg": "url('assets/wallpaper.jpg')",
    "gradient-1": "linear-gradient(135deg, #4c2a8f, #1a1040 60%, #05070d)",
    "gradient-2": "linear-gradient(135deg, #0b3a52, #0a1a2e 55%, #05070d)",
    "gradient-3": "linear-gradient(135deg, #7a2d4f, #3a1330 55%, #05070d)",
    "black": "#000"
  };

  function applyWallpaper(key) {
    var value = WALLPAPERS[key] || WALLPAPERS["assets/wallpaper.jpg"];
    $("wallpaper").style.backgroundImage = value.indexOf("linear") === 0 ? "none" : value;
    $("wallpaper").style.background = value.indexOf("linear") === 0 ? value : "#05070d";
    if (value.indexOf("url") === 0) {
      $("wallpaper").style.backgroundImage = value;
      $("wallpaper").style.backgroundSize = "cover";
      $("wallpaper").style.backgroundPosition = "center";
    }
  }

  /* ---------- boot ---------- */

  var FRAME_COUNT = 60;
  var frames = [];

  function buildFrames() {
    var host = $("boot-frame");
    for (var i = 0; i < FRAME_COUNT; i += 1) {
      var img = document.createElement("img");
      img.src = "boot/animation/" + String(i).padStart(3, "0") + ".png";
      img.alt = "";
      img.draggable = false;
      host.appendChild(img);
      frames.push(img);
    }
  }

  function preload() {
    var done = 0;
    return Promise.all(frames.map(function (img) {
      return new Promise(function (resolve) {
        if (img.complete) { done += 1; resolve(); return; }
        img.onload = img.onerror = function () { done += 1; resolve(); };
      });
    }));
  }

  function playBoot() {
    return preload().then(function () {
      var i = 0;
      var fill = $("boot-bar").firstElementChild;
      return new Promise(function (resolve) {
        var timer = setInterval(function () {
          frames.forEach(function (f) { f.classList.remove("on"); });
          if (frames[i]) frames[i].classList.add("on");
          fill.style.width = Math.round((i / (FRAME_COUNT - 1)) * 100) + "%";
          i += 1;
          if (i >= FRAME_COUNT) {
            clearInterval(timer);
            fill.style.width = "100%";
            setTimeout(resolve, 220);
          }
        }, 42);
      });
    });
  }

  function finishBoot() {
    var boot = $("boot");
    boot.style.transition = "opacity 420ms ease";
    boot.style.opacity = "0";
    setTimeout(function () {
      boot.hidden = true;
      $("desktop").hidden = false;
      openPair();
    }, 430);
  }

  /* ---------- clock ---------- */

  function tickClock() {
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, "0");
    var mm = String(now.getMinutes()).padStart(2, "0");
    $("clock").textContent = hh + ":" + mm;
    $("date").textContent = now.toLocaleDateString(undefined, {
      weekday: "long", month: "short", day: "numeric"
    });
  }

  /* ---------- toasts + hud ---------- */

  function toast(text, kind) {
    var host = $("toasts");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = text;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = "opacity 300ms ease, transform 300ms ease";
      el.style.opacity = "0";
      el.style.transform = "translateY(-8px)";
      setTimeout(function () { el.remove(); }, 320);
    }, 2400);
  }

  var hudTimer = null;

  function showHud() {
    var hud = $("hud");
    hud.hidden = false;
    var pct = Math.round(state.muted ? 0 : state.volume * 100);
    $("hud-bar").firstElementChild.style.width = pct + "%";
    $("hud-label").textContent = (state.muted ? "muted" : "volume " + pct + "%");
    $("vol-chip").textContent = state.muted ? "muted" : "vol " + pct + "%";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { hud.hidden = true; }, 1800);
  }

  /* ---------- apps ---------- */

  var APPS = [
    { id: "home", title: "Home", sub: "start here" },
    { id: "browser", title: "Web", sub: "browse any site" },
    { id: "media", title: "Media", sub: "watch video" },
    { id: "notes", title: "Notes", sub: "type from remote" },
    { id: "photos", title: "Photos", sub: "slideshow" },
    { id: "settings", title: "Settings", sub: "screen setup" }
  ];

  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>',
    media: '<rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M10 9l5 3-5 3z"/>',
    notes: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
    photos: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="8.5" cy="10" r="1.8"/><path d="M4 18l5.5-5 4 3.5L17 12l3 3.5"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.2 7.2l2.2 1.3M17.6 15.5l2.2 1.3M4.2 16.8l2.2-1.3M17.6 8.5l2.2-1.3"/>'
  };

  function buildHomeTiles() {
    var host = $("home-tiles");
    host.innerHTML = "";
    APPS.forEach(function (app) {
      var btn = document.createElement("button");
      btn.className = "tile";
      btn.setAttribute("data-focus", "");
      btn.setAttribute("data-app", app.id);
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
        ICONS[app.id] + "</svg><b>" + app.title + "</b><small>" + app.sub + "</small>";
      host.appendChild(btn);
    });
  }

  function openApp(id) {
    if (!ICONS[id] && id !== "home") return;
    state.app = id;
    document.querySelectorAll(".window").forEach(function (w) {
      w.classList.toggle("open", w.id === "win-" + id);
    });
    document.querySelectorAll(".dock-btn[data-app]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-app") === id);
    });
    sendState();
    if (id === "settings") updateStats();
    if (id === "photos") startSlideshow();
    else stopSlideshow();
  }

  function goHome() { openApp("home"); }

  /* ---------- browser ---------- */

  function openUrl(raw) {
    var url = String(raw || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url)) url = "https://" + url;
      else url = "https://duckduckgo.com/?q=" + encodeURIComponent(url);
    }
    $("browser-url").value = url;
    $("browser-frame").src = url;
    openApp("browser");
    toast("opening " + url.replace(/^https?:\/\//, "").slice(0, 42));
  }

  /* ---------- media ---------- */

  var MEDIA = [
    { id: "aqz-KE-bpKQ", title: "Big Buck Bunny" },
    { id: "LXb3EKWsInQ", title: "Costa Rica 4K" },
    { id: "jZj2ZLBKlDE", title: "Nature in 4K" },
    { id: "5qap5aO4i9A", title: "lofi radio" }
  ];

  function youtubeId(value) {
    var text = String(value || "").trim();
    if (!text) return null;
    var match = text.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
    if (match) return match[1];
    if (/^[\w-]{6,}$/.test(text)) return text;
    return null;
  }

  function playMedia(value) {
    var id = youtubeId(value);
    if (!id) { toast("that is not a youtube link", "warn"); return; }
    $("media-url").value = value;
    $("media-frame").src = "https://www.youtube-nocookie.com/embed/" + id +
      "?autoplay=1&rel=0&modestbranding=1";
    openApp("media");
    toast("playing " + id);
  }

  function buildMediaList() {
    var host = $("media-list");
    host.innerHTML = "";
    MEDIA.forEach(function (item) {
      var card = document.createElement("div");
      card.className = "media-card";
      card.setAttribute("data-focus", "");
      card.setAttribute("data-media", item.id);
      card.innerHTML = '<div class="thumb">&#9654;</div><div class="cap">' + item.title + "</div>";
      host.appendChild(card);
    });
  }

  /* ---------- photos ---------- */

  var PHOTOS = [
    "url('assets/wallpaper.jpg')",
    "linear-gradient(135deg, #2b1b5a, #0b0d18)",
    "linear-gradient(135deg, #0d3b4a, #08131f)",
    "linear-gradient(135deg, #5a1f42, #170a14)",
    "linear-gradient(135deg, #1f3a5a, #0a0f18)"
  ];
  var photoIndex = 0;
  var photoTimer = null;

  function renderPhoto() {
    var stage = $("photo-stage");
    stage.style.backgroundImage = PHOTOS[photoIndex].indexOf("linear") === 0 ? "none" : PHOTOS[photoIndex];
    stage.style.background = PHOTOS[photoIndex];
    stage.style.backgroundSize = "cover";
    stage.style.backgroundPosition = "center";
    $("photo-count").textContent = (photoIndex + 1) + " / " + PHOTOS.length;
  }

  function nextPhoto(step) {
    photoIndex = (photoIndex + (step || 1) + PHOTOS.length) % PHOTOS.length;
    renderPhoto();
  }

  function startSlideshow() {
    stopSlideshow();
    renderPhoto();
    photoTimer = setInterval(function () { nextPhoto(1); }, 4200);
  }

  function stopSlideshow() {
    if (photoTimer) clearInterval(photoTimer);
    photoTimer = null;
  }

  /* ---------- notes ---------- */

  function loadNotes() {
    try { $("notes-area").value = localStorage.getItem("castos.notes") || ""; } catch (err) { /* ignore */ }
  }

  /* ---------- settings ---------- */

  function updateStats() {
    $("st-screen").textContent = window.innerWidth + "x" + window.innerHeight;
    $("st-link").textContent = state.connected ? "live" : "offline";
    $("st-ping").textContent = state.ping ? state.ping + "ms" : "-";
    var secs = Math.round((Date.now() - state.startedAt) / 1000);
    $("st-uptime").textContent = secs > 90 ? Math.round(secs / 60) + "m" : secs + "s";
  }

  setInterval(updateStats, 1000);

  /* ---------- cursor + hover ---------- */

  var hoverEl = null;
  var cursorPos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  function moveCursor(nx, ny) {
    var px = Math.max(0, Math.min(1, nx)) * window.innerWidth;
    var py = Math.max(0, Math.min(1, ny)) * window.innerHeight;
    cursorPos.x = px;
    cursorPos.y = py;
    var cur = $("cursor");
    cur.hidden = false;
    cur.style.transform = "translate(" + px + "px," + py + "px)";
    var el = document.elementFromPoint(px, py);
    var clickable = el && el.closest && el.closest(
      "button, a, input, select, textarea, [data-focus], .tile, .media-card, .dock-btn, summary"
    );
    if (el !== hoverEl) {
      if (hoverEl) hoverEl.classList.remove("castos-hover");
      hoverEl = el && clickable ? el : null;
      if (hoverEl) hoverEl.classList.add("castos-hover");
    }
    cur.style.backgroundImage = clickable
      ? "url(\"assets/pointer.svg\")"
      : "url(\"assets/cursor.svg\")";
  }

  function clickAt(button) {
    var el = document.elementFromPoint(cursorPos.x, cursorPos.y);
    if (!el) return;
    var target = el.closest && el.closest(
      "button, a, input, select, textarea, summary, .tile, .media-card"
    );
    if (!target) return;
    if (target.tagName === "SUMMARY") { target.click(); return; }
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
      target.focus();
      return;
    }
    hoverEl = null;
    target.click();
  }

  function scrollAt(dy) {
    var open = document.querySelector(".window.open");
    var scroller = open ? open.querySelector(".win-body") : null;
    if (scroller) scroller.scrollTop += dy;
    else window.scrollBy(0, dy);
  }

  /* ---------- text entry ---------- */

  function editable() {
    var el = document.activeElement;
    if (!el) return null;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return el;
    if (el.isContentEditable) return el;
    return null;
  }

  function insertText(text) {
    var el = editable();
    if (!el || el.tagName === "SELECT") {
      if (state.app === "browser") {
        $("browser-url").focus();
        el = $("browser-url");
      } else {
        return;
      }
    }
    var start = el.selectionStart;
    var end = el.selectionEnd;
    var value = el.value || "";
    el.value = value.slice(0, start) + text + value.slice(end);
    var pos = start + text.length;
    el.selectionStart = pos;
    el.selectionEnd = pos;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function eraseChar() {
    var el = editable();
    if (!el || el.tagName === "SELECT") return;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    if (start === 0 && end === 0) return;
    var value = el.value || "";
    if (start === end) {
      el.value = value.slice(0, start - 1) + value.slice(end);
      el.selectionStart = el.selectionEnd = start - 1;
    } else {
      el.value = value.slice(0, start) + value.slice(end);
      el.selectionStart = el.selectionEnd = start;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* ---------- focus navigation ---------- */

  function focusables() {
    var win = document.querySelector(".window.open") || document;
    var nodes = Array.prototype.slice.call(win.querySelectorAll("[data-focus], button, input, select, textarea, a[href]"));
    return nodes.filter(function (n) {
      return n.offsetParent !== null && !n.disabled && n.type !== "hidden";
    });
  }

  function focusMove(dir) {
    var list = focusables();
    if (!list.length) return;
    var current = document.activeElement;
    var idx = list.indexOf(current);
    if (idx === -1) { list[0].focus(); return; }
    var rect = current.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var best = -1;
    var bestScore = Infinity;
    list.forEach(function (n, i) {
      if (i === idx) return;
      var r = n.getBoundingClientRect();
      var nx = r.left + r.width / 2;
      var ny = r.top + r.height / 2;
      var dx = nx - cx;
      var dy = ny - cy;
      var along = dir === "up" || dir === "down" ? dy : dx;
      var across = dir === "up" || dir === "down" ? dx : dy;
      if (along <= 0) return;
      var score = Math.abs(along) + Math.abs(across) * 2.2;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) list[best].focus();
  }

  /* ---------- control dispatch ---------- */

  function setVolume(delta) {
    state.muted = false;
    state.volume = Math.max(0, Math.min(1, state.volume + delta));
    $("set-volume").value = Math.round(state.volume * 100);
    showHud();
    sendState();
  }

  function toggleMute() {
    state.muted = !state.muted;
    showHud();
    sendState();
  }

  function runCommand(cmd, value) {
    switch (cmd) {
      case "home": goHome(); break;
      case "back": goHome(); break;
      case "menu": openApp("settings"); break;
      case "pair": openPair(); break;
      case "fullscreen":
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
        break;
      case "reload": location.reload(); break;
      case "power": location.reload(); break;
      case "mute": toggleMute(); break;
      case "volup": setVolume(0.1); break;
      case "voldown": setVolume(-0.1); break;
      case "play": case "pause": case "playpause": togglePlay(); break;
      case "next": nextPhoto(1); break;
      case "prev": nextPhoto(-1); break;
      case "open": openUrl(value); break;
      case "media": playMedia(value); break;
      case "app": openApp(value); break;
      case "toast": toast(String(value || "")); break;
      default: break;
    }
  }

  function togglePlay() {
    var frame = $("media-frame");
    if (frame && frame.src && state.app === "media") {
      frame.src = frame.src.indexOf("autoplay=1") !== -1
        ? frame.src.replace("autoplay=1", "autoplay=0")
        : frame.src.replace("autoplay=0", "autoplay=1");
    } else if (state.app === "photos") {
      if (photoTimer) stopSlideshow(); else startSlideshow();
    } else {
      toast("nothing is playing", "warn");
    }
  }

  function handleKey(key) {
    var el = editable();
    if (el && el.tagName !== "SELECT") {
      if (key === "Backspace") { eraseChar(); return; }
      if (key === "Enter") { el.blur(); return; }
      if (key === "Escape") { el.blur(); return; }
      if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") return;
      if (key.length === 1) insertText(key);
      return;
    }
    switch (key) {
      case "ArrowUp": focusMove("up"); break;
      case "ArrowDown": focusMove("down"); break;
      case "ArrowLeft": focusMove("left"); break;
      case "ArrowRight": focusMove("right"); break;
      case "Enter": case " ":
        if (document.activeElement && document.activeElement.click) document.activeElement.click();
        else clickAt("left");
        break;
      case "Escape": case "Backspace": goHome(); break;
      case "Tab": focusMove("right"); break;
      default:
        if (key.length === 1) insertText(key);
        break;
    }
  }

  function handleMessage(data) {
    if (!data || typeof data !== "object") return;
    if (data.t === "ping") {
      state.session && state.session.send({ t: "pong", ts: data.ts, at: Date.now() });
      return;
    }
    if (data.t === "key") handleKey(data.k);
    else if (data.t === "move") moveCursor(data.x, data.y);
    else if (data.t === "click") clickAt(data.b);
    else if (data.t === "scroll") scrollAt(data.dy);
    else if (data.t === "text") insertText(String(data.s || ""));
    else if (data.t === "vol") setVolume(data.d);
    else if (data.t === "cmd") runCommand(data.c, data.v);
  }

  /* ---------- pairing (serverless) ---------- */

  function setPairStatus(text, kind) {
    var el = $("pair-status");
    el.textContent = text;
    el.className = kind || "";
  }

  function setConnPill() {
    var pill = $("conn-pill");
    if (state.connected) {
      pill.textContent = "linked" + (state.remoteName ? " - " + state.remoteName : "");
      pill.className = "pill live";
      $("remote-name").hidden = false;
      $("remote-name").textContent = state.remoteName || "remote";
      $("st-link").textContent = "live";
    } else {
      pill.textContent = "not connected";
      pill.className = "pill off";
      $("remote-name").hidden = true;
      $("st-link").textContent = "offline";
    }
  }

  function sendState() {
    if (!state.session) return;
    state.session.send(C.msg.state({
      v: Math.round(state.volume * 100),
      m: state.muted,
      a: state.app,
      n: state.name,
      p: state.ping
    }));
  }

  async function startManualPair() {
    setPairStatus("building a pairing code...");
    try {
      var res = await C.manualHost({
        onOpen: function () {
          state.connected = true;
          setConnPill();
          setPairStatus("connected - use your phone as a remote", "ok");
          $("pair").hidden = true;
          toast("phone linked", "ok");
          sendState();
        },
        onMessage: handleMessage,
        onInfo: function (info) { state.remoteName = info.name || "remote"; setConnPill(); },
        onClose: function () {
          state.connected = false;
          setConnPill();
          if (!$("pair").hidden) setPairStatus("link dropped - generate a new code", "err");
          else openPair();
        },
        onState: function () {}
      });
      state.session = res.session;
      state.offer = res;
      var url = res.url;
      $("pair-sub").innerHTML = "Scan with your phone camera. It opens the remote and links straight to this screen - no account, no server, any network.";
      await C.renderQR($("pair-qr"), url, 260);
      setPairStatus("waiting for phone - scan the code or share the link");
      window.__castosLink = url;
    } catch (err) {
      setPairStatus("could not build a pairing code: " + C.describeError(err), "err");
    }
  }

  async function acceptAnswer() {
    var raw = $("answer-input").value.trim();
    if (!raw) { setPairStatus("paste the answer code from the phone first", "err"); return; }
    if (!state.offer) { setPairStatus("generate a pairing code first", "err"); return; }
    setPairStatus("linking...");
    try {
      var name = await state.offer.finish(raw);
      state.remoteName = name;
      setConnPill();
    } catch (err) {
      setPairStatus("link failed: " + C.describeError(err), "err");
    }
  }

  function openPair() {
    $("pair").hidden = false;
    if (!state.offer) startManualPair();
  }

  function closePair() {
    $("pair").hidden = true;
    if (!state.connected) toast("not connected - open pair to link a phone", "warn");
  }

  /* ---------- camera scan ---------- */

  var scanStream = null;
  var scanLoop = null;

  function canScan() {
    return typeof window.BarcodeDetector === "function" &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  }

  async function startScan() {
    if (!canScan()) {
      toast("camera scanning is not supported here - paste the answer code instead", "warn");
      return;
    }
    try {
      var formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.indexOf("qr_code") === -1) {
        toast("no qr support in this browser camera", "warn");
        return;
      }
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }
      });
      var video = $("scan-video");
      video.srcObject = scanStream;
      video.hidden = false;
      $("scan-frame").hidden = false;
      $("scan-cancel").hidden = false;
      await video.play();
      var detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      scanLoop = setInterval(async function () {
        try {
          var found = await detector.detect(video);
          if (found && found.length) {
            var value = found[0].rawValue || "";
            var id = extractAnswer(value);
            if (id) {
              stopScan();
              $("answer-input").value = id;
              await acceptAnswer();
            }
          }
        } catch (err) { /* keep scanning */ }
      }, 350);
    } catch (err) {
      stopScan();
      toast("camera unavailable: " + C.describeError(err), "warn");
    }
  }

  function extractAnswer(value) {
    var text = String(value || "");
    var hash = text.indexOf("#");
    if (hash !== -1) {
      var params = C.hashParams();
      if (params.a) return params.a;
    }
    if (text.indexOf("receiver.html") !== -1 || text.length > 60) return text.trim();
    return null;
  }

  function stopScan() {
    if (scanLoop) clearInterval(scanLoop);
    scanLoop = null;
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
    }
    $("scan-video").hidden = true;
    $("scan-frame").hidden = true;
    $("scan-cancel").hidden = true;
  }

  /* ---------- wiring ---------- */

  function wire() {
    document.addEventListener("click", function (ev) {
      var dock = ev.target.closest && ev.target.closest(".dock-btn[data-app]");
      if (dock) { openApp(dock.getAttribute("data-app")); return; }
      var tile = ev.target.closest && ev.target.closest("[data-app]");
      if (tile) { openApp(tile.getAttribute("data-app")); return; }
      var card = ev.target.closest && ev.target.closest("[data-media]");
      if (card) { playMedia(card.getAttribute("data-media")); return; }
    });

    $("pair-btn").addEventListener("click", openPair);
    $("home-pair").addEventListener("click", openPair);
    $("set-pair").addEventListener("click", openPair);
    $("btn-close-pair").addEventListener("click", closePair);
    $("btn-copy-link").addEventListener("click", function () {
      var url = window.__castosLink || "";
      if (!url) { toast("no pairing link yet", "warn"); return; }
      C.copy(url).then(function (ok) {
        toast(ok ? "link copied" : "copy failed - long press the qr", ok ? "ok" : "warn");
      });
    });
    $("btn-new-code").addEventListener("click", function () {
      if (state.session) { state.session.close("restart"); }
      state.offer = null;
      state.session = null;
      state.connected = false;
      setConnPill();
      startManualPair();
    });
    $("btn-camera").addEventListener("click", startScan);
    $("scan-cancel").addEventListener("click", stopScan);
    $("btn-answer").addEventListener("click", acceptAnswer);

    $("browser-go").addEventListener("click", function () {
      openUrl($("browser-url").value);
    });
    $("browser-url").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") openUrl($("browser-url").value);
    });

    $("media-play").addEventListener("click", function () {
      playMedia($("media-url").value);
    });
    $("media-url").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") playMedia($("media-url").value);
    });

    $("notes-area").addEventListener("input", function () {
      try { localStorage.setItem("castos.notes", $("notes-area").value); } catch (err) { /* ignore */ }
    });
    $("notes-clear").addEventListener("click", function () {
      $("notes-area").value = "";
      try { localStorage.removeItem("castos.notes"); } catch (err) { /* ignore */ }
    });

    $("set-name-save").addEventListener("click", function () {
      prefs.name = $("set-name").value.trim() || "CastOS Screen";
      state.name = prefs.name;
      $("device-name").textContent = prefs.name;
      savePrefs();
      sendState();
      toast("renamed to " + prefs.name, "ok");
    });

    $("set-wall").addEventListener("change", function () {
      prefs.wallpaper = $("set-wall").value;
      applyWallpaper(prefs.wallpaper);
      savePrefs();
    });

    $("set-volume").addEventListener("input", function () {
      state.volume = Number($("set-volume").value) / 100;
      state.muted = false;
      showHud();
      sendState();
    });

    $("set-restart").addEventListener("click", function () { location.reload(); });
    $("home-full").addEventListener("click", function () {
      runCommand("fullscreen");
    });

    window.addEventListener("resize", function () {
      if ($("win-home")) moveCursor(0.5, 0.5);
    });

    document.addEventListener("keydown", function (ev) {
      if (!$("pair").hidden) return;
      if (ev.key === "Escape") runCommand("home");
    });
  }

  function init() {
    loadPrefs();
    buildHomeTiles();
    buildMediaList();
    loadNotes();
    wire();
    tickClock();
    setInterval(tickClock, 15000);
    setConnPill();
    if (!$("pair").hidden) setConnPill();
    playBoot().then(finishBoot);
    $("set-volume").value = Math.round(state.volume * 100);
    openApp("home");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.CastOSReceiver = { state: state, openApp: openApp, handleMessage: handleMessage };
})();
