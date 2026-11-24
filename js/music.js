/*
 * Music — the Spotless music player for CastOS.
 *
 * A CastOS screen is not a Chromecast. A phone pairs with it over ntfy.sh (see js/cast.js) and
 * then sends "music" messages: the track that should play plus the ones after it. This module
 * turns those messages into real audio on the TV and keeps the queue, artwork and progress on
 * screen. Playback state is reported back on every real event, so the phone's player mirrors the
 * TV instead of guessing.
 *
 * Audio only: there is no video element involved, no YouTube, no fake progress. If a stream
 * fails, the failure comes from the <audio> element.
 *
 * Exposes window.Ambient.Music.
 */
(function (global) {
  "use strict";

  var TICK_MS = 250;

  var LABELS = {
    playing: "Playing",
    paused: "Paused",
    buffering: "Buffering",
    loading: "Loading",
    ended: "Ended",
    error: "Can't play this track",
    closed: "Stopped"
  };

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

  function Music(els) {
    this.els = els;
    this.audio = els.audio;
    this.queue = [];
    this.index = 0;
    this.active = false;
    this.playing = false;
    this.state = "closed";
    this.onUpdate = null;
    this.seekTo = 0;
    this.bind();
  }

  Music.prototype.bind = function () {
    var self = this;
    var audio = this.audio;

    audio.addEventListener("playing", function () {
      if (!self.active) return;
      self.playing = true;
      self.els.overlay.classList.add("is-playing");
      self.label("playing");
      self.render();
      self.emit("playing");
    });

    audio.addEventListener("pause", function () {
      if (!self.active) return;
      /* A pause while loading is the browser starting the element, not the listener. */
      if (self.state === "loading") return;
      self.playing = false;
      self.els.overlay.classList.remove("is-playing");
      self.label("paused");
      self.render();
      self.emit("paused");
    });

    audio.addEventListener("waiting", function () {
      if (!self.active) return;
      self.label("buffering");
      self.emit("buffering");
    });

    audio.addEventListener("ended", function () {
      if (!self.active) return;
      self.next(true);
    });

    audio.addEventListener("loadedmetadata", function () {
      if (!self.active) return;
      if (self.seekTo > 0) {
        try {
          audio.currentTime = Math.min(self.seekTo, isFinite(audio.duration) ? audio.duration : self.seekTo);
        } catch (error) {}
        self.seekTo = 0;
      }
      self.render();
      self.emit(self.playing ? "playing" : "loading");
    });

    audio.addEventListener("error", function () {
      if (!self.active) return;
      self.label("error");
      self.emit("error");
    });

    global.setInterval(function () {
      if (self.active) self.render();
    }, TICK_MS);
  };

  /* The phone sends the track and the ones after it, so the TV can keep playing if the socket
     hiccups. */
  Music.prototype.open = function (payload) {
    var track = payload && payload.track;

    if (!track || typeof track.url !== "string" || !track.url) return false;

    this.active = true;
    this.queue = [track].concat(Array.isArray(payload.queue) ? payload.queue : []);
    this.index = 0;
    this.playing = false;
    this.els.overlay.hidden = false;
    this.els.overlay.setAttribute("aria-hidden", "false");
    this.els.overlay.classList.add("is-visible");
    this.label("loading");
    this.load(0, Number(payload.position) || 0);
    return true;
  };

  Music.prototype.load = function (index, position) {
    var track = this.queue[index];

    if (!track || !track.url) return;

    this.index = index;
    this.seekTo = Math.max(0, Number(position) || 0);
    this.paint(track);
    this.label("loading");
    this.els.overlay.classList.add("is-visible");
    this.audio.src = track.url;
    this.audio.load();
    this.play();
  };

  Music.prototype.paint = function (track) {
    var art = typeof track.art === "string" ? track.art : "";

    this.els.title.textContent = track.title || "Untitled";
    this.els.artist.textContent = track.artist || "Internet Archive";
    this.els.album.textContent = track.album || "";

    if (art) {
      if (this.els.art.getAttribute("src") !== art) this.els.art.setAttribute("src", art);
      this.els.art.classList.remove("is-empty");
      this.els.backdrop.style.backgroundImage = 'url("' + art.replace(/["\\]/g, "") + '")';
    } else {
      this.els.art.removeAttribute("src");
      this.els.art.classList.add("is-empty");
      this.els.backdrop.style.backgroundImage = "none";
    }

    this.els.next.textContent = this.upNext();
  };

  Music.prototype.upNext = function () {
    var next = this.queue[this.index + 1];

    if (!next) return "";
    return "Up next · " + (next.title || "") + (next.artist ? " — " + next.artist : "");
  };

  Music.prototype.render = function () {
    var duration = isFinite(this.audio.duration) ? this.audio.duration : 0;
    var position = this.audio.currentTime || 0;

    this.els.fill.style.width = duration > 0 ? Math.min(100, (position / duration) * 100) + "%" : "0%";
    this.els.elapsed.textContent = clock(position);
    this.els.total.textContent = clock(duration);
  };

  Music.prototype.label = function (state) {
    this.state = state;
    this.els.status.textContent = LABELS[state] || state;
    this.els.dot.className = "music__dot" + (state === "playing" ? "" : " is-off");
  };

  Music.prototype.emit = function (state) {
    var track = this.queue[this.index] || {};

    if (!this.onUpdate) return;

    this.onUpdate({
      state: state,
      position: this.audio.currentTime || 0,
      duration: isFinite(this.audio.duration) ? this.audio.duration : 0,
      title: track.title || "",
      trackId: track.id || "",
      index: this.index
    });
  };

  /* -------- transport -------- */

  Music.prototype.play = function () {
    if (!this.active) return;

    var self = this;
    var requested = this.audio.play();

    if (requested && requested.catch) {
      requested.catch(function () {
        /* Browsers block audio until a gesture; the kiosk launcher passes
           --autoplay-policy=no-user-gesture-required and a tap also lifts it. */
        if (self.active && self.state !== "playing") self.label("paused");
      });
    }
  };

  Music.prototype.pause = function () {
    if (this.active) this.audio.pause();
  };

  Music.prototype.seek = function (position) {
    var duration;

    if (!this.active || !isFinite(position) || position < 0) return;

    duration = this.audio.duration;
    this.audio.currentTime = isFinite(duration) && duration > 0 ? Math.min(position, duration) : position;
    this.render();
  };

  Music.prototype.next = function (fromEnd) {
    if (!this.active) return;

    if (this.index + 1 >= this.queue.length) {
      if (fromEnd) {
        this.label("ended");
        this.emit("ended");
      }
      return;
    }

    this.load(this.index + 1, 0);
  };

  Music.prototype.previous = function () {
    if (!this.active) return;

    if (this.audio.currentTime > 4) {
      this.seek(0);
      return;
    }

    if (this.index > 0) this.load(this.index - 1, 0);
    else this.seek(0);
  };

  Music.prototype.jump = function (index, trackId) {
    var at = Number(index);

    if (!this.active) return;

    if (!(at >= 0 && at < this.queue.length)) {
      at = -1;
      for (var i = 0; i < this.queue.length; i++) {
        if (this.queue[i].id === trackId) {
          at = i;
          break;
        }
      }
    }

    if (at < 0) return;
    this.load(at, 0);
  };

  Music.prototype.control = function (payload) {
    var action = String((payload && payload.action) || "");

    if (action === "play") this.play();
    else if (action === "pause") this.pause();
    else if (action === "toggle") this.playing ? this.pause() : this.play();
    else if (action === "next") this.next(false);
    else if (action === "prev") this.previous();
    else if (action === "seek") this.seek(Number(payload.position));
    else if (action === "play-index") this.jump(payload.index, payload.trackId);
    else if (action === "stop") this.stop();
  };

  Music.prototype.add = function (items, next) {
    if (!Array.isArray(items) || !items.length) return;

    if (!this.active) {
      this.queue = items.slice();
      return;
    }

    if (next) {
      Array.prototype.splice.apply(this.queue, [this.index + 1, 0].concat(items));
    } else {
      this.queue = this.queue.concat(items);
    }

    this.els.next.textContent = this.upNext();
  };

  Music.prototype.stop = function () {
    var self = this;

    if (!this.active) return;

    this.active = false;
    this.playing = false;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.queue = [];
    this.index = 0;
    this.label("closed");
    this.els.overlay.classList.remove("is-visible", "is-playing");

    global.setTimeout(function () {
      if (!self.active) {
        self.els.overlay.hidden = true;
        self.els.overlay.setAttribute("aria-hidden", "true");
      }
    }, 420);

    this.emit("closed");
  };

  Music.prototype.status = function () {
    var track = this.queue[this.index] || {};

    return {
      state: this.active ? this.state : "closed",
      position: this.audio.currentTime || 0,
      duration: isFinite(this.audio.duration) ? this.audio.duration : 0,
      title: track.title || "",
      trackId: track.id || "",
      index: this.index
    };
  };

  /* Chrome only allows audio after a gesture. The first tap on the screen lifts the block; a
     kiosk launched with tools/kiosk.sh never needs it. */
  Music.prototype.unlockAudio = function () {
    if (this.active && this.playing && this.audio.paused) this.play();
  };

  global.Ambient = global.Ambient || {};
  global.Ambient.Music = Music;
})(window);
