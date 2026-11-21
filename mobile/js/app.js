/*
 * CastOS Connect — pairs a phone with a CastOS screen over ntfy.sh.
 *
 * 1. Type the screen's 11-digit code and choose a pairing password.
 * 2. The screen shows a 4-digit password; type it here to pair.
 * 3. Send messages to the screen.
 */
(function (global) {
  "use strict";

  var HTTP = "https://ntfy.sh/";
  var WS = "wss://ntfy.sh/";
  var APP = "castos";
  var WAIT_MS = 25000;

  var els = {
    tag: document.getElementById("topbar-tag"),
    stepConnect: document.getElementById("step-connect"),
    stepVerify: document.getElementById("step-verify"),
    stepPaired: document.getElementById("step-paired"),
    code: document.getElementById("code"),
    password: document.getElementById("password"),
    connect: document.getElementById("connect"),
    error: document.getElementById("error"),
    challenge: document.getElementById("challenge"),
    verify: document.getElementById("verify"),
    errorVerify: document.getElementById("error-verify"),
    pairedTo: document.getElementById("paired-to"),
    composer: document.getElementById("composer"),
    message: document.getElementById("message"),
    sent: document.getElementById("sent")
  };

  var state = {
    code: "",
    password: "",
    session: "",
    socket: null,
    timer: 0,
    step: "connect"
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
      password: payload.password || "",
      challenge: payload.challenge || "",
      text: payload.text || "",
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

  function openSocket() {
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
      sendPair();
    };

    socket.onmessage = function (event) {
      receive(event.data);
    };

    socket.onerror = function () {};

    socket.onclose = function () {
      if (state.step !== "connect") return;
      stopConnecting("Lost the connection to that screen. Try again.");
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

    publish({ type: "pair", password: state.password }).catch(function () {
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
    else if (message.type === "paired") onPaired();
    else if (message.type === "denied") onDenied();
    else if (message.type === "cancel") onCancel();
  }

  function onChallenge() {
    global.clearTimeout(state.timer);
    els.challenge.value = "";
    fail(els.errorVerify, "");
    els.verify.disabled = false;
    show("verify");
    els.challenge.focus();
  }

  function onPaired() {
    global.clearTimeout(state.timer);
    closeSocket();
    els.pairedTo.textContent = "This phone is connected to screen " + groupCode(state.code) + ".";
    show("paired");
    els.message.focus();
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

  function connect(event) {
    var code;
    var password;

    if (event) event.preventDefault();

    code = digits(els.code.value);
    password = digits(els.password.value);

    if (code.length !== 11) {
      fail(els.error, "Enter the 11-digit code shown on your screen.");
      return;
    }

    if (password.length < 4) {
      fail(els.error, "Choose a pairing password of at least 4 digits.");
      return;
    }

    fail(els.error, "");
    state.code = code;
    state.password = password;
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

  function appendBubble(text, isError) {
    var item = document.createElement("li");

    item.textContent = text;
    if (isError) item.className = "is-error";
    els.sent.appendChild(item);

    while (els.sent.children.length > 6) els.sent.removeChild(els.sent.firstChild);
  }

  function send(event) {
    var text;

    if (event) event.preventDefault();

    text = els.message.value.trim();
    if (!text) return;

    els.message.value = "";
    appendBubble(text);

    publish({ type: "message", text: text.slice(0, 280), password: state.password }).catch(function () {
      appendBubble("Not sent — check your connection.", true);
    });
  }

  function onlyDigits(input) {
    input.addEventListener("input", function () {
      var cleaned = digits(input.value).slice(0, input.maxLength > 0 ? input.maxLength : 32);
      if (input.value !== cleaned) input.value = cleaned;
    });
  }

  onlyDigits(els.code);
  onlyDigits(els.password);
  onlyDigits(els.challenge);

  els.stepConnect.addEventListener("submit", connect);
  els.stepVerify.addEventListener("submit", verify);
  els.composer.addEventListener("submit", send);

  show("connect");
})(window);
