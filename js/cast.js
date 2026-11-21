/*
 * Cast — the Chromecast-style badge, pairing flow and message panel.
 *
 * The 11-digit device code is generated once, kept across reloads and used
 * as the ntfy.sh topic. A phone that knows the code asks to pair; this screen
 * invents a 4-digit pairing code and shows it. Only a phone that types that
 * code back is paired, and it then receives a session token that every later
 * message must carry.
 *
 * Everything runs on its own: there are no mouse or keyboard controls.
 *
 * Exposes window.Ambient.Cast.
 */
(function (global) {
  "use strict";

  var HTTP = "https://ntfy.sh/";
  var WS = "wss://ntfy.sh/";
  var APP = "castos";
  var CODE_KEY = "castos.device-code";
  var CODE_LENGTH = 11;
  var CHALLENGE_MS = 60000;
  var MESSAGE_MS = 12000;
  var TOAST_MS = 4500;
  var RETRY_MS = 3000;

  /* Apps the phone may launch on this screen. Only these URLs are allowed. */
  var APPS = {
    youtube: "https://www.youtube.com/tv",
    "youtube-music": "https://music.youtube.com/",
    twitch: "https://www.twitch.tv/"
  };

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

  function randomToken() {
    var token = "";
    var values;
    var i;

    if (global.crypto && global.crypto.getRandomValues) {
      values = new Uint8Array(16);
      global.crypto.getRandomValues(values);
      for (i = 0; i < values.length; i++) {
        token += (values[i] < 16 ? "0" : "") + values[i].toString(16);
      }
      return token;
    }

    for (i = 0; i < 32; i++) token += Math.floor(Math.random() * 16).toString(16);
    return token;
  }

  function groupCode(code) {
    return code.slice(0, 3) + " " + code.slice(3, 7) + " " + code.slice(7);
  }

  function spaceDigits(value) {
    return value.split("").join(" ");
  }

  function storedCode() {
    try {
      var code = global.localStorage.getItem(CODE_KEY);
      return code && /^\d{11}$/.test(code) ? code : "";
    } catch (error) {
      return "";
    }
  }

  function saveCode(code) {
    try {
      global.localStorage.setItem(CODE_KEY, code);
    } catch (error) {}
  }

  /* The device code stays the same across reloads, so the topic does too. */
  function deviceCode() {
    var code = storedCode();

    if (code) return code;

    code = randomDigits(CODE_LENGTH);
    saveCode(code);
    return code;
  }

  function Cast(els) {
    this.els = els;
    this.player = els.player || null;
    this.code = deviceCode();
    this.topic = this.code;
    this.session = "";
    this.token = "";
    this.pending = null;
    this.paired = false;
    this.socket = null;
    this.challengeTimer = 0;
    this.panelTimer = 0;
    this.retryTimer = 0;
  }

  Cast.prototype.start = function () {
    var self = this;

    this.els.code.textContent = groupCode(this.code);
    this.els.badge.classList.add("is-visible");
    this.connect();

    if (this.player) {
      this.player.onUpdate = function (update) {
        self.publishPlayback(update);
      };
    }
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
    else if (message.type === "media") this.playMedia(message);
    else if (message.type === "control") this.control(message);
    else if (message.type === "app") this.launchApp(message);
    else if (message.type === "unpair") this.unpair(message);
  };

  /* The screen invents the pairing code; the phone only has to read it. */
  Cast.prototype.requestPair = function (message) {
    var self = this;
    var session;

    if (!message.session) return;

    this.pending = {
      session: String(message.session),
      challenge: randomDigits(4)
    };

    session = this.pending.session;

    this.showPanel(
      "Pairing request",
      spaceDigits(this.pending.challenge),
      "Type this password on your phone to connect",
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
      this.token = randomToken();
      this.paired = true;

      this.els.badge.classList.add("is-paired");
      this.showPanel("Connected", "This phone can send messages here", "", false, TOAST_MS);
      this.publish({ type: "paired", session: this.session, token: this.token });
    } else {
      this.publish({ type: "denied", session: pending.session });
      this.showPanel(
        "Pairing failed",
        "That password did not match",
        "Use the password shown on this screen",
        false,
        TOAST_MS
      );
    }
  };

  Cast.prototype.showMessage = function (message) {
    var text = typeof message.text === "string" ? message.text.trim() : "";

    if (!this.paired || String(message.session) !== this.session) return;
    if (!this.token || String(message.token) !== this.token || !text) return;

    this.showPanel("Message from your phone", text.slice(0, 280), "", false, MESSAGE_MS);
  };

  Cast.prototype.playMedia = function (message) {
    if (!this.paired || String(message.session) !== this.session) return;
    if (!this.token || String(message.token) !== this.token) return;
    if (!this.player || typeof message.url !== "string") return;

    if (!this.player.open(message.url)) {
      this.showPanel(
        "Can't open that link",
        "Send a YouTube or direct video URL",
        "",
        false,
        TOAST_MS
      );
    }
  };

  /* Playback controls come from the paired phone only. */
  Cast.prototype.control = function (message) {
    var action = String(message.action || "");

    if (!this.authorised(message) || !this.player) return;

    if (action === "pause") this.player.pause();
    else if (action === "play") this.player.play();
    else if (action === "stop") this.player.stop();
    else if (action === "seek") this.player.seek(Number(message.position));
    else if (action === "status") this.publishPlayback(this.player.status());
  };

  Cast.prototype.launchApp = function (message) {
    var url = APPS[String(message.appId || "")];
    var self = this;

    if (!this.authorised(message) || !url) return;

    this.showPanel("Opening", "Starting the app on this screen", "", false, TOAST_MS);

    global.setTimeout(function () {
      global.location.href = url;
    }, 700);
  };

  Cast.prototype.authorised = function (message) {
    if (!this.paired || !this.token) return false;
    if (String(message.session) !== this.session) return false;

    return String(message.token) === this.token;
  };

  Cast.prototype.publishPlayback = function (update) {
    if (!this.paired || !this.token) return;

    this.publish({
      type: "playback",
      session: this.session,
      token: this.token,
      state: update.state,
      position: update.position,
      duration: update.duration,
      title: update.title
    });
  };

  /* The phone's reset clears the pairing here too, so the next phone starts
     from a clean screen. */
  Cast.prototype.unpair = function (message) {
    if (!this.paired || !this.token) return;
    if (String(message.session) !== this.session) return;
    if (String(message.token) !== this.token) return;

    this.paired = false;
    this.session = "";
    this.token = "";
    this.pending = null;

    this.els.badge.classList.remove("is-paired");
    this.showPanel("Disconnected", "This phone is no longer connected", "", false, TOAST_MS);
  };

  Cast.prototype.publish = function (payload) {
    var body = {
      app: APP,
      v: 1,
      from: "tv",
      type: payload.type,
      session: payload.session || "",
      token: payload.token || "",
      state: payload.state || "",
      position: payload.position || 0,
      duration: payload.duration || 0,
      title: payload.title || "",
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
