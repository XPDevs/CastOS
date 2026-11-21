/*
 * CastOS Connect — pairs a phone with a CastOS screen over ntfy.sh.
 *
 * 1. Type the screen's 11-digit device code.
 * 2. The screen shows a password of its own; type it here to pair.
 * 3. Send links, control playback and open apps.
 */
(function (global) {
  "use strict";

  var HTTP = "https://ntfy.sh/";
  var WS = "wss://ntfy.sh/";
  var APP = "castos";
  var WAIT_MS = 25000;

  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 5l11 7-11 7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>';

  var STATE_LABELS = {
    playing: "Playing",
    paused: "Paused",
    buffering: "Buffering",
    loading: "Loading",
    ended: "Ended",
    error: "Can't play",
    closed: "Stopped"
  };

  var els = {
    tag: document.getElementById("topbar-tag"),
    stepConnect: document.getElementById("step-connect"),
    stepVerify: document.getElementById("step-verify"),
    stepPaired: document.getElementById("step-paired"),
    code: document.getElementById("code"),
    connect: document.getElementById("connect"),
    error: document.getElementById("error"),
    challenge: document.getElementById("challenge"),
    verify: document.getElementById("verify"),
    errorVerify: document.getElementById("error-verify"),
    pairedTo: document.getElementById("paired-to"),
    controller: document.getElementById("controller"),
    controllerTitle: document.getElementById("controller-title"),
    controllerState: document.getElementById("controller-state"),
    seek: document.getElementById("seek"),
    position: document.getElementById("position"),
    duration: document.getElementById("duration"),
    toggle: document.getElementById("control-toggle"),
    stop: document.getElementById("control-stop"),
    composer: document.getElementById("composer"),
    message: document.getElementById("message"),
    sent: document.getElementById("sent")
  };

  var state = {
    code: "",
    session: "",
    token: "",
    socket: null,
    timer: 0,
    step: "connect"
  };

  var media = {
    active: false,
    state: "",
    position: 0,
    duration: 0,
    title: "",
    stamp: 0,
    seeking: false
  };

  function digits(value) {
    return String(value || "").replace(/\D+/g, "");
  }

  function groupCode(code) {
    return code.slice(0, 3) + " " + code.slice(3, 7) + " " + code.slice(7);
  }

  function randomId() {
    var id = "";
    var values;
    var i;

    if (global.crypto && global.crypto.getRandomValues) {
      values = new Uint8Array(8);
      global.crypto.getRandomValues(values);
      for (i = 0; i < values.length; i++) {
        id += (values[i] < 16 ? "0" : "") + values[i].toString(16);
      }
      return id;
    }

    return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  function clock(seconds) {
    var total = Math.max(0, Math.floor(Number(seconds) || 0));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var secs = total % 60;
    var pad = function (value) {
      return value < 10 ? "0" + value : String(value);
    };

    if (hours) return hours + ":" + pad(minutes) + ":" + pad(secs);
    return minutes + ":" + pad(secs);
  }

  function show(step) {
    state.step = step;
    els.stepConnect.hidden = step !== "connect";
    els.stepVerify.hidden = step !== "verify";
    els.stepPaired.hidden = step !== "paired";
    els.tag.textContent = step === "paired" ? "Connected" : step === "verify" ? "Verify" : "Connect";
  }

  function fail(element, text) {
    element.textContent = text;
  }

  function publish(payload) {
    var body = {
      app: APP,
      v: 1,
      from: "phone",
      type: payload.type,
      session: state.session,
      challenge: payload.challenge || "",
      token: state.token,
      text: payload.text || "",
      url: payload.url || "",
      action: payload.action || "",
      appId: payload.app || "",
      position: payload.position || 0,
      at: Date.now()
    };

    return global.fetch(HTTP + state.code, {
      method: "POST",
      body: JSON.stringify(body)
    }).then(function (response) {
      if (!response.ok) throw new Error("ntfy " + response.status);
    });
  }

  function closeSocket() {
    if (!state.socket) return;

    state.socket.onclose = null;
    state.socket.onmessage = null;
    state.socket.onopen = null;
    try {
      state.socket.close();
    } catch (error) {}
    state.socket = null;
  }

  /* The socket stays open after pairing: playback state arrives on it. A
     dropped socket is reopened without sending a new pairing request. */
  function openSocket(rejoin) {
    var socket;

    closeSocket();

    try {
      socket = new WebSocket(WS + state.code + "/ws");
    } catch (error) {
      stopConnecting("Could not open a connection. Try again.");
      return;
    }

    state.socket = socket;

    socket.onopen = function () {
      if (!rejoin) sendPair();
    };

    socket.onmessage = function (event) {
      receive(event.data);
    };

    socket.onerror = function () {};

    socket.onclose = function () {
      if (state.step === "connect") {
        stopConnecting("Lost the connection to that screen. Try again.");
        return;
      }

      if (state.step !== "paired") return;

      global.setTimeout(function () {
        if (state.step === "paired" && !state.socket) openSocket(true);
      }, 2000);
    };
  }

  function startTimer() {
    global.clearTimeout(state.timer);
    state.timer = global.setTimeout(function () {
      if (state.step !== "connect") return;
      stopConnecting("No response from that screen. Check the code and try again.");
    }, WAIT_MS);
  }

  function stopConnecting(message) {
    global.clearTimeout(state.timer);
    closeSocket();
    els.connect.disabled = false;
    els.connect.textContent = "Connect";
    fail(els.error, message);
  }

  function sendPair() {
    startTimer();

    publish({ type: "pair" }).catch(function () {
      stopConnecting("Could not reach the screen. Check your connection and try again.");
    });
  }

  function receive(raw) {
    var event;
    var message;

    try {
      event = JSON.parse(raw);
    } catch (error) {
      return;
    }

    if (!event || event.event !== "message" || typeof event.message !== "string") return;

    try {
      message = JSON.parse(event.message);
    } catch (error) {
      return;
    }

    if (!message || message.app !== APP || message.from !== "tv") return;
    if (message.session !== state.session) return;

    if (message.type === "challenge") onChallenge();
    else if (message.type === "paired") onPaired(message);
    else if (message.type === "denied") onDenied();
    else if (message.type === "cancel") onCancel();
    else if (message.type === "playback") onPlayback(message);
  }

  function onChallenge() {
    global.clearTimeout(state.timer);
    els.challenge.value = "";
    fail(els.errorVerify, "");
    els.verify.disabled = false;
    show("verify");
    els.challenge.focus();
  }

  function onPaired(message) {
    if (!message.token) return;

    global.clearTimeout(state.timer);
    state.token = String(message.token);
    els.pairedTo.textContent = "This phone is connected to screen " + groupCode(state.code) + ".";
    show("paired");
    els.message.focus();

    /* Ask what is already on screen so the controller starts in sync. */
    publish({ type: "control", action: "status" }).catch(function () {});
  }

  function onDenied() {
    els.verify.disabled = false;
    fail(els.errorVerify, "That password did not match. Check your TV and try again.");
    els.challenge.focus();
  }

  function onCancel() {
    global.clearTimeout(state.timer);
    closeSocket();
    els.connect.disabled = false;
    els.connect.textContent = "Connect";
    show("connect");
    fail(els.error, "The screen cancelled the pairing. Try again.");
  }

  /* ---- playback controller ---- */

  function currentPosition() {
    if (media.state === "playing" && media.stamp) {
      return Math.min(media.duration || Infinity, media.position + (Date.now() - media.stamp) / 1000);
    }

    return media.position;
  }

  function renderMedia() {
    var position;

    els.controller.hidden = !media.active;
    if (!media.active) return;

    position = currentPosition();

    els.controllerTitle.textContent = media.title || "Media";
    els.controllerState.textContent = STATE_LABELS[media.state] || "Ready";
    els.toggle.innerHTML = media.state === "playing" ? ICON_PAUSE : ICON_PLAY;
    els.toggle.setAttribute("aria-label", media.state === "playing" ? "Pause" : "Play");

    els.seek.max = String(Math.max(media.duration, 1));
    if (!media.seeking) els.seek.value = String(position);
    els.position.textContent = clock(position);
    els.duration.textContent = clock(media.duration);
  }

  function onPlayback(message) {
    media.state = String(message.state || "");
    media.title = String(message.title || "") || media.title;
    media.position = Number(message.position) || 0;
    media.duration = Number(message.duration) || 0;
    media.stamp = Date.now();
    media.active = media.state !== "closed" && media.state !== "ended";

    if (!media.active) media.position = 0;

    renderMedia();
  }

  function togglePlayback() {
    if (!media.active) return;

    publish({
      type: "control",
      action: media.state === "playing" ? "pause" : "play"
    }).catch(function () {
      appendBubble("Control didn't reach the screen.", true);
    });
  }

  function stopPlayback() {
    if (!media.active) return;

    publish({ type: "control", action: "stop" }).catch(function () {});
    media.active = false;
    renderMedia();
  }

  global.setInterval(function () {
    var position;

    if (!media.active) return;

    position = currentPosition();
    if (!media.seeking) els.seek.value = String(Math.min(position, Number(els.seek.max)));
    els.position.textContent = clock(position);
  }, 1000);

  /* ---- pairing ---- */

  function connect(event) {
    var code;

    if (event) event.preventDefault();

    code = digits(els.code.value);

    if (code.length !== 11) {
      fail(els.error, "Enter the 11-digit code shown on your screen.");
      return;
    }

    fail(els.error, "");
    state.code = code;
    state.session = randomId();
    els.connect.disabled = true;
    els.connect.textContent = "Connecting…";

    openSocket();
  }

  function verify(event) {
    var value;

    if (event) event.preventDefault();

    value = digits(els.challenge.value);

    if (value.length !== 4) {
      fail(els.errorVerify, "Enter the 4-digit password shown on your TV.");
      return;
    }

    fail(els.errorVerify, "");
    els.verify.disabled = true;

    publish({ type: "verify", challenge: value }).catch(function () {
      els.verify.disabled = false;
      fail(els.errorVerify, "Could not send the password. Try again.");
    });
  }

  /* Reset returns the phone to the connect screen and, when paired, tells the
     screen to forget this phone. */
  function reset() {
    if (state.token) {
      publish({ type: "unpair" }).catch(function () {});
    }

    global.clearTimeout(state.timer);
    closeSocket();

    state.session = "";
    state.token = "";
    media.active = false;
    els.code.value = "";
    els.challenge.value = "";
    els.message.value = "";
    els.sent.innerHTML = "";
    els.connect.disabled = false;
    els.connect.textContent = "Connect";
    fail(els.error, "");
    fail(els.errorVerify, "");

    renderMedia();
    show("connect");
    els.code.focus();
  }

  /* ---- links, messages and apps ---- */

  function appendBubble(text, isError) {
    var item = document.createElement("li");

    item.textContent = text;
    if (isError) item.className = "is-error";
    els.sent.appendChild(item);

    while (els.sent.children.length > 6) els.sent.removeChild(els.sent.firstChild);
  }

  /* "hi" is a message; "youtube.com/watch?v=…" or "https://…/clip.mp4" is
     a link. Bare domains get https:// so phoned-in links still work. */
  function asLink(text) {
    var candidate = text;
    var url;

    if (!/^https?:\/\//i.test(candidate)) {
      if (!/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(candidate)) return "";
      candidate = "https://" + candidate;
    }

    try {
      url = new URL(candidate);
    } catch (error) {
      return "";
    }

    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  }

  function send(event) {
    var text;
    var link;

    if (event) event.preventDefault();

    text = els.message.value.trim();
    if (!text) return;

    link = asLink(text);

    els.message.value = "";
    appendBubble(text);

    if (link) {
      media.active = true;
      media.state = "loading";
      media.title = link;
      media.position = 0;
      media.duration = 0;
      media.stamp = 0;
      renderMedia();
    }

    publish(
      link
        ? { type: "media", url: link }
        : { type: "message", text: text.slice(0, 280) }
    ).catch(function () {
      appendBubble("Not sent — check your connection.", true);
    });
  }

  function launchApp(button) {
    var id = button.getAttribute("data-app");
    var name = button.textContent;

    appendBubble("Opening " + name + " on your TV");

    publish({ type: "app", app: id }).catch(function () {
      appendBubble("Couldn't open " + name + ".", true);
    });
  }

  function onlyDigits(input) {
    input.addEventListener("input", function () {
      var limit = input.maxLength > 0 ? input.maxLength : 32;
      var cleaned = digits(input.value).slice(0, limit);

      if (input.value !== cleaned) input.value = cleaned;
    });
  }

  onlyDigits(els.code);
  onlyDigits(els.challenge);

  els.stepConnect.addEventListener("submit", connect);
  els.stepVerify.addEventListener("submit", verify);
  els.composer.addEventListener("submit", send);
  document.getElementById("start-over").addEventListener("click", reset);
  document.getElementById("reset").addEventListener("click", reset);

  els.toggle.addEventListener("click", togglePlayback);
  els.stop.addEventListener("click", stopPlayback);
  els.toggle.innerHTML = ICON_PLAY;
  els.stop.innerHTML = ICON_STOP;

  els.seek.addEventListener("input", function () {
    media.seeking = true;
    els.position.textContent = clock(Number(els.seek.value));
  });

  els.seek.addEventListener("change", function () {
    var position = Number(els.seek.value);

    media.seeking = false;
    media.position = position;
    media.stamp = Date.now();
    publish({ type: "control", action: "seek", position: position }).catch(function () {
      appendBubble("Seek didn't reach the screen.", true);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-app]"), function (button) {
    button.addEventListener("click", function () {
      launchApp(button);
    });
  });

  show("connect");
})(window);
