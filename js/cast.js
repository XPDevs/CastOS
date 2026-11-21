/*
 * Cast — the Chromecast-style badge, pairing flow and message panel.
 *
 * The 11-digit code shown on screen is also the ntfy.sh topic. A phone sends
 * a pairing request carrying its own password; this screen answers with a
 * 4-digit password the phone has to repeat, and only then pairs. Paired
 * messages are shown in a panel and dismissed on their own: the TV has no
 * mouse or keyboard controls.
 *
 * Exposes window.Ambient.Cast.
 */
(function (global) {
  "use strict";

  var HTTP = "https://ntfy.sh/";
  var WS = "wss://ntfy.sh/";
  var APP = "castos";
  var CODE_LENGTH = 11;
  var CHALLENGE_MS = 60000;
  var MESSAGE_MS = 12000;
  var TOAST_MS = 4500;
  var RETRY_MS = 3000;

  function randomDigits(count) {
    var digits = "";
    var values;
    var i;

    if (global.crypto && global.crypto.getRandomValues) {
      values = new Uint32Array(count);
      global.crypto.getRandomValues(values);
      for (i = 0; i < count; i++) digits += String(values[i] % 10);
      return digits;
    }

    for (i = 0; i < count; i++) digits += String(Math.floor(Math.random() * 10));
    return digits;
  }

  function groupCode(code) {
    return code.slice(0, 3) + " " + code.slice(3, 7) + " " + code.slice(7);
  }

  function spaceDigits(value) {
    return value.split("").join(" ");
  }

  function Cast(els) {
    this.els = els;
    this.code = randomDigits(CODE_LENGTH);
    this.topic = this.code;
    this.session = "";
    this.password = "";
    this.pending = null;
    this.paired = false;
    this.socket = null;
    this.challengeTimer = 0;
    this.panelTimer = 0;
    this.retryTimer = 0;
  }

  Cast.prototype.start = function () {
    this.els.code.textContent = groupCode(this.code);
    this.els.badge.classList.add("is-visible");
    this.connect();
  };

  Cast.prototype.connect = function () {
    var self = this;
    var socket;

    try {
      socket = new WebSocket(WS + this.topic + "/ws");
    } catch (error) {
      this.retry();
      return;
    }

    this.socket = socket;

    socket.onmessage = function (event) {
      self.receive(event.data);
    };

    socket.onclose = function () {
      if (self.socket === socket) self.socket = null;
      self.retry();
    };

    socket.onerror = function () {};
  };

  Cast.prototype.retry = function () {
    var self = this;

    if (this.retryTimer) return;

    this.retryTimer = global.setTimeout(function () {
      self.retryTimer = 0;
      self.connect();
    }, RETRY_MS);
  };

  Cast.prototype.receive = function (raw) {
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

    if (!message || message.app !== APP || message.from !== "phone") return;

    if (message.type === "pair") this.requestPair(message);
    else if (message.type === "verify") this.verify(message);
    else if (message.type === "message") this.showMessage(message);
  };

  Cast.prototype.requestPair = function (message) {
    var self = this;
    var session;

    if (!message.session || !message.password) return;

    this.pending = {
      session: String(message.session),
      password: String(message.password),
      challenge: randomDigits(4)
    };

    session = this.pending.session;

    this.showPanel(
      "Pairing request",
      spaceDigits(this.pending.challenge),
      "Enter this password on your phone to connect",
      true
    );

    this.publish({ type: "challenge", session: session });

    global.clearTimeout(this.challengeTimer);
    this.challengeTimer = global.setTimeout(function () {
      if (!self.pending || self.pending.session !== session) return;

      self.pending = null;
      self.hidePanel();
      self.publish({ type: "cancel", session: session });
    }, CHALLENGE_MS);
  };

  Cast.prototype.verify = function (message) {
    var pending = this.pending;

    if (!pending || String(message.session) !== pending.session) return;

    if (String(message.challenge) === pending.challenge) {
      global.clearTimeout(this.challengeTimer);
      this.challengeTimer = 0;
      this.pending = null;
      this.session = pending.session;
      this.password = pending.password;
      this.paired = true;

      this.els.badge.classList.add("is-paired");
      this.showPanel("Connected", "This phone can send messages here", "", false, TOAST_MS);
      this.publish({ type: "paired", session: this.session });
    } else {
      this.publish({ type: "denied", session: pending.session });
      this.showPanel(
        "Pairing failed",
        "The password did not match",
        "Check the password shown on this screen",
        false,
        TOAST_MS
      );
    }
  };

  Cast.prototype.showMessage = function (message) {
    var text = typeof message.text === "string" ? message.text.trim() : "";

    if (!this.paired || String(message.session) !== this.session) return;
    if (String(message.password) !== this.password || !text) return;

    this.showPanel("Message from your phone", text.slice(0, 280), "", false, MESSAGE_MS);
  };

  Cast.prototype.publish = function (payload) {
    var body = {
      app: APP,
      v: 1,
      from: "tv",
      type: payload.type,
      session: payload.session || "",
      at: Date.now()
    };

    return global.fetch(HTTP + this.topic, {
      method: "POST",
      body: JSON.stringify(body)
    }).catch(function () {});
  };

  Cast.prototype.showPanel = function (eyebrow, headline, sub, isCode, duration) {
    var self = this;
    var els = this.els;

    global.clearTimeout(this.panelTimer);

    els.eyebrow.textContent = eyebrow;
    els.headline.textContent = headline;
    els.headline.classList.toggle("is-code", !!isCode);
    els.sub.textContent = sub;
    els.panel.hidden = false;

    /* Force a reflow so the fade restarts for back-to-back panels. */
    els.panel.offsetWidth;
    els.panel.classList.add("is-visible");

    if (duration) {
      this.panelTimer = global.setTimeout(function () {
        self.hidePanel();
      }, duration);
    }
  };

  Cast.prototype.hidePanel = function () {
    var els = this.els;

    global.clearTimeout(this.panelTimer);
    els.panel.classList.remove("is-visible");

    global.setTimeout(function () {
      if (!els.panel.classList.contains("is-visible")) els.panel.hidden = true;
    }, 500);
  };

  global.Ambient = global.Ambient || {};
  global.Ambient.Cast = Cast;
})(window);
