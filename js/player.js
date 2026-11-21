/*
 * Player — plays a link full screen: YouTube embeds, direct video/audio files.
 *
 * The loading screen is driven by real events (media element progress, the
 * YouTube player's state), never by a timer. Nothing is simulated: if a link
 * fails, the failure comes from the element or the player itself.
 *
 * The phone controls playback through the Cast module: pause, play, stop and
 * seek. Playback state is reported back on every real state change.
 *
 * Browsers require a gesture before audio may play; the page unlocks sound on
 * the first interaction it gets, and the kiosk launcher passes Chromium's
 * --autoplay-policy flag so a wall-mounted screen starts with sound.
 *
 * Exposes window.Ambient.Player.
 */
(function (global) {
  "use strict";

  var YT_API = "https://www.youtube.com/iframe_api";
  var ERROR_MS = 12000;
  var LOAD_TIMEOUT_MS = 30000;

  var MEDIA_ERRORS = {
    1: "Playback was aborted.",
    2: "The network dropped while loading.",
    3: "This device could not decode the video.",
    4: "This link is not a video this browser can play."
  };

  var YT_QUALITY = {
    "480p": "large",
    "720p": "hd720",
    "1080p": "hd1080",
    "2160p": "hd2160"
  };

  var apiPromise = null;

  function seconds(value) {
    var text = String(value || "").trim();
    var plain = /^(\d+)$/.exec(text);
    var hours;
    var minutes;
    var secs;

    if (!text) return 0;
    if (plain) return parseInt(plain[1], 10);

    hours = /(\d+)h/.exec(text);
    minutes = /(\d+)m/.exec(text);
    secs = /(\d+)s/.exec(text);

    return (hours ? parseInt(hours[1], 10) * 3600 : 0) +
      (minutes ? parseInt(minutes[1], 10) * 60 : 0) +
      (secs ? parseInt(secs[1], 10) : 0);
  }

  function parse(value) {
    var url;
    var host;
    var id = "";
    var match;

    try {
      url = new URL(String(value || "").trim());
    } catch (error) {
      return null;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      id = url.pathname.slice(1).split("/")[0];
    } else if (host === "youtube.com" || host === "m.youtube.com" ||
        host === "music.youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") {
        id = url.searchParams.get("v") || "";
      } else {
        match = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
        if (match) id = match[1];
      }
    }

    if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
      return {
        kind: "youtube",
        id: id,
        start: seconds(url.searchParams.get("t") || url.searchParams.get("start"))
      };
    }

    if (/\.m3u8($|\?)/i.test(url.pathname) || /\.m3u8/i.test(url.href)) {
      return { kind: "hls" };
    }

    return {
      kind: "media",
      url: url.href,
      start: seconds(url.searchParams.get("t")) || seconds(String(url.hash).replace(/^#t=/, ""))
    };
  }

  function loadYouTubeApi() {
    if (global.YT && global.YT.Player) return Promise.resolve();
    if (apiPromise) return apiPromise;

    apiPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var timer = global.setTimeout(function () {
        reject(new Error("youtube api timeout"));
      }, 15000);

      global.onYouTubeIframeAPIReady = function () {
        global.clearTimeout(timer);
        resolve();
      };

      script.src = YT_API;
      script.onerror = function () {
        global.clearTimeout(timer);
        reject(new Error("youtube api failed"));
      };

      document.head.appendChild(script);
    });

    return apiPromise;
  }

  function Player(els) {
    var device = global.Ambient.Device || {};

    this.els = els;
    this.quality = device.quality || "1080p";
    this.maxHeight = device.maxHeight || 1080;
    this.active = false;
    this.started = false;
    this.title = "";
    this.yt = null;
    this.onUpdate = null;
    this.timeout = 0;
    this.errorTimer = 0;

    this.bind();
  }

  Player.prototype.bind = function () {
    var self = this;
    var video = this.els.video;

    video.addEventListener("loadstart", function () {
      if (self.active) self.loadingView("Video", "Connecting…", -1, self.qualityNote());
    });

    video.addEventListener("loadedmetadata", function () {
      var name;
      var path;

      if (!self.active) return;

      path = String(video.currentSrc || video.src).split("/").pop().split("?")[0];

      try {
        name = decodeURIComponent(path) || "Video";
      } catch (error) {
        name = "Video";
      }

      self.title = name;

      if (isFinite(video.duration) && video.duration > 0) {
        self.els.title.textContent = name;
        self.loadingView(name, "Loading…", self.buffered(), self.qualityNote());
      }

      if (video.videoHeight && video.videoHeight > self.maxHeight) {
        self.els.note.textContent =
          video.videoHeight + "p source · " + self.quality + " device limit";
      }
    });

    video.addEventListener("progress", function () {
      if (!self.active) return;
      self.fill(self.buffered());
    });

    video.addEventListener("canplay", function () {
      if (self.active && !self.started) self.els.status.textContent = "Starting…";
    });

    video.addEventListener("playing", function () {
      if (!self.active) return;
      self.started = true;
      global.clearTimeout(self.timeout);
      self.els.loading.hidden = true;
      self.emit("playing");
    });

    video.addEventListener("waiting", function () {
      if (self.active && self.started) {
        self.loadingView(self.title || "Video", "Buffering…", self.buffered(), self.qualityNote());
        self.emit("buffering");
      }
    });

    video.addEventListener("play", function () {
      if (self.active) self.emit("playing");
    });

    video.addEventListener("pause", function () {
      if (self.active && !self.closing) self.emit("paused");
    });

    video.addEventListener("ended", function () {
      if (!self.active) return;
      self.emit("ended");
      self.close();
    });

    video.addEventListener("error", function () {
      var code = video.error ? video.error.code : 0;

      if (self.active) self.fail(MEDIA_ERRORS[code] || "This video could not be played.");
    });
  };

  Player.prototype.qualityNote = function () {
    return this.quality + " max on this device";
  };

  Player.prototype.position = function () {
    if (!this.active) return 0;

    if (this.yt && this.yt.getCurrentTime) {
      try {
        return this.yt.getCurrentTime() || 0;
      } catch (error) {
        return 0;
      }
    }

    return this.els.video.currentTime || 0;
  };

  Player.prototype.duration = function () {
    if (!this.active) return 0;

    if (this.yt && this.yt.getDuration) {
      try {
        return this.yt.getDuration() || 0;
      } catch (error) {
        return 0;
      }
    }

    return isFinite(this.els.video.duration) ? this.els.video.duration : 0;
  };

  Player.prototype.emit = function (state) {
    if (!this.onUpdate) return;

    this.onUpdate({
      state: state,
      position: this.position(),
      duration: this.duration(),
      title: this.title || ""
    });
  };

  Player.prototype.open = function (value) {
    var info = parse(value);

    if (!info) return false;

    this.close();
    this.active = true;
    this.started = false;
    this.title = "";

    this.els.video.muted = false;
    this.els.video.hidden = true;
    this.els.frame.hidden = true;
    this.els.frame.innerHTML = "";
    this.els.loading.hidden = false;
    this.els.loading.classList.remove("is-error");
    this.els.overlay.hidden = false;
    this.els.overlay.offsetWidth;
    this.els.overlay.classList.add("is-visible");

    this.watchdog();
    this.emit("loading");

    if (info.kind === "youtube") this.openYouTube(info);
    else if (info.kind === "hls") this.fail("HLS (.m3u8) streams are not supported by this browser.");
    else this.openFile(info);

    return true;
  };

  Player.prototype.watchdog = function () {
    var self = this;

    global.clearTimeout(this.timeout);
    this.timeout = global.setTimeout(function () {
      if (self.active && !self.started) self.fail("This is taking too long to load.");
    }, LOAD_TIMEOUT_MS);
  };

  Player.prototype.openFile = function (info) {
    var self = this;
    var video = this.els.video;

    video.hidden = false;
    video.src = info.url;

    this.loadingView("Video", "Connecting…", -1, this.qualityNote());

    video.play().catch(function () {
      /* A real load error is reported by the error event, not as a
         blocked autoplay. Only retry muted when nothing failed. */
      if (video.error) return;

      video.muted = true;
      self.els.note.textContent = "Muted · tap the screen once to enable sound";
      video.play().catch(function () {
        if (!video.error) self.fail("This browser blocked playback.");
      });
    });

    if (info.start) {
      video.addEventListener("loadedmetadata", function seek() {
        video.removeEventListener("loadedmetadata", seek);
        video.currentTime = info.start;
      });
    }
  };

  Player.prototype.openYouTube = function (info) {
    var self = this;
    var mount;

    this.loadingView("YouTube", "Loading video…", -1, this.qualityNote());

    loadYouTubeApi().then(function () {
      if (!self.active) return;

      mount = document.createElement("div");
      self.els.frame.innerHTML = "";
      self.els.frame.appendChild(mount);
      self.els.frame.hidden = false;

      self.yt = new global.YT.Player(mount, {
        videoId: info.id,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          iv_load_policy: 3,
          vq: YT_QUALITY[self.quality] || "hd1080",
          start: info.start || 0,
          origin: global.location.origin
        },
        events: {
          onReady: function (event) {
            self.youtubeReady(event.target);
          },
          onStateChange: function (event) {
            self.youtubeState(event.data);
          },
          onError: function (event) {
            self.fail("YouTube could not play this video (" + event.data + ").");
          }
        }
      });
    }).catch(function () {
      self.fail("Could not reach YouTube from this device.");
    });
  };

  Player.prototype.youtubeReady = function (player) {
    var self = this;
    var data;

    player.playVideo();

    try {
      data = player.getVideoData ? player.getVideoData() : null;
      if (data && data.title) {
        this.title = data.title;
        this.els.title.textContent = data.title;
      }
    } catch (error) {}

    global.setTimeout(function () {
      if (!self.active || self.started) return;
      if (player.getPlayerState && player.getPlayerState() !== 1) {
        player.mute();
        self.els.note.textContent = "Muted · tap the screen once to enable sound";
        player.playVideo();
      }
    }, 1600);
  };

  Player.prototype.youtubeState = function (state) {
    if (!this.active) return;

    if (state === 1) {
      this.started = true;
      global.clearTimeout(this.timeout);
      this.els.loading.hidden = true;
      this.emit("playing");
    } else if (state === 2) {
      this.emit("paused");
    } else if (state === 3) {
      this.loadingView("YouTube", "Buffering…", -1, this.qualityNote());
      this.emit("buffering");
    } else if (state === 0) {
      this.emit("ended");
      this.close();
    }
  };

  Player.prototype.pause = function () {
    if (!this.active) return;

    if (this.yt && this.yt.pauseVideo) this.yt.pauseVideo();
    else this.els.video.pause();
  };

  Player.prototype.play = function () {
    if (!this.active) return;

    if (this.yt && this.yt.playVideo) {
      this.yt.playVideo();
      return;
    }

    this.els.video.play().catch(function () {});
  };

  Player.prototype.seek = function (position) {
    if (!this.active || !isFinite(position) || position < 0) return;

    if (this.yt && this.yt.seekTo) {
      this.yt.seekTo(position, true);
      return;
    }

    if (isFinite(this.els.video.duration)) {
      this.els.video.currentTime = Math.min(position, this.els.video.duration);
    }
  };

  Player.prototype.stop = function () {
    this.close();
  };

  Player.prototype.status = function () {
    var video = this.els.video;
    var state = "closed";

    if (this.active) {
      if (this.yt && this.yt.getPlayerState) {
        try {
          state = { 0: "ended", 1: "playing", 2: "paused", 3: "buffering" }[this.yt.getPlayerState()] || "loading";
        } catch (error) {
          state = "loading";
        }
      } else if (video.paused) {
        state = this.started ? "paused" : "loading";
      } else {
        state = "playing";
      }
    }

    return {
      state: state,
      position: this.position(),
      duration: this.duration(),
      title: this.title || ""
    };
  };

  /* Chrome only allows audio after a gesture. The first tap or key press on
     the screen lifts the mute; the kiosk launcher avoids needing it. */
  Player.prototype.unlockAudio = function () {
    if (!this.active) return;

    this.els.note.textContent = this.qualityNote();

    if (this.yt && this.yt.unMute) {
      try {
        this.yt.unMute();
        this.yt.setVolume(100);
      } catch (error) {}
      return;
    }

    if (this.els.video.muted) {
      this.els.video.muted = false;
      this.els.video.play().catch(function () {});
    }
  };

  Player.prototype.buffered = function () {
    var video = this.els.video;
    var end;

    if (!video.buffered || !video.buffered.length) return -1;
    if (!isFinite(video.duration) || video.duration <= 0) return -1;

    end = video.buffered.end(video.buffered.length - 1);
    return Math.min(1, end / video.duration);
  };

  Player.prototype.fill = function (ratio) {
    this.els.bar.classList.toggle("is-indeterminate", ratio < 0);
    this.els.fill.style.width = ratio < 0 ? "0%" : Math.round(ratio * 100) + "%";
  };

  Player.prototype.loadingView = function (title, status, ratio, note) {
    this.els.loading.hidden = false;
    this.els.title.textContent = title;
    this.els.status.textContent = status;
    this.els.note.textContent = note || this.qualityNote();
    this.fill(ratio);
  };

  Player.prototype.fail = function (message) {
    var self = this;

    global.clearTimeout(this.timeout);

    if (this.yt) {
      try {
        this.yt.destroy();
      } catch (error) {}
      this.yt = null;
    }

    this.els.video.pause();
    this.els.loading.hidden = false;
    this.els.loading.classList.add("is-error");
    this.els.title.textContent = "Can't play this";
    this.els.status.textContent = message;
    this.els.note.textContent = "";
    this.fill(-1);
    this.els.bar.classList.remove("is-indeterminate");
    this.emit("error");

    global.clearTimeout(this.errorTimer);
    this.errorTimer = global.setTimeout(function () {
      self.close();
    }, ERROR_MS);
  };

  Player.prototype.close = function () {
    var self = this;

    if (!this.active) return;

    this.active = false;
    this.closing = true;
    global.clearTimeout(this.timeout);
    global.clearTimeout(this.errorTimer);

    if (this.yt) {
      try {
        this.yt.destroy();
      } catch (error) {}
      this.yt = null;
    }

    this.els.video.pause();
    this.els.video.removeAttribute("src");
    this.els.video.load();
    this.els.frame.innerHTML = "";
    this.els.frame.hidden = true;
    this.els.loading.classList.remove("is-error");
    this.els.overlay.classList.remove("is-visible");
    this.emit("closed");

    global.setTimeout(function () {
      if (!self.active) {
        self.els.overlay.hidden = true;
        self.closing = false;
      }
    }, 420);
  };

  global.Ambient = global.Ambient || {};
  global.Ambient.Player = Player;
})(window);
