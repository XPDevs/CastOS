/*
 * Slideshow — two image layers, crossfaded, skipping wallpapers that fail.
 *
 * Exposes window.Ambient.Slideshow.
 */
(function (global) {
  "use strict";

  function Slideshow(layers, playlist, holdMs) {
    this.playlist = playlist;
    this.holdMs = holdMs;
    this.front = layers[0];
    this.back = layers[1];
    this.cursor = 0;
    this.running = false;
  }

  Slideshow.prototype.load = function (layer, url) {
    return new Promise(function (resolve, reject) {
      function cleanup() {
        layer.removeEventListener("load", onLoad);
        layer.removeEventListener("error", onError);
      }
      function onLoad() {
        cleanup();
        resolve();
      }
      function onError() {
        cleanup();
        reject(new Error(url));
      }

      layer.addEventListener("load", onLoad);
      layer.addEventListener("error", onError);
      layer.src = url;
    });
  };

  /* Try wallpapers in order until one loads, so a single bad file cannot
     freeze the slideshow. */
  Slideshow.prototype.show = function (layer) {
    var self = this;

    function next(attempt) {
      if (attempt >= self.playlist.length) return Promise.resolve(false);

      var url = self.playlist[self.cursor % self.playlist.length];
      self.cursor += 1;

      return self.load(layer, url).then(
        function () {
          return true;
        },
        function (error) {
          if (global.console) console.warn("ambient: skipping wallpaper", error.message);
          return next(attempt + 1);
        }
      );
    }

    return next(0);
  };

  Slideshow.prototype.advance = function () {
    var self = this;

    return this.show(this.back).then(function (loaded) {
      var previous;

      if (!loaded) return;

      self.back.classList.add("is-active");
      self.front.classList.remove("is-active");

      previous = self.front;
      self.front = self.back;
      self.back = previous;
    });
  };

  Slideshow.prototype.start = function () {
    var self = this;

    if (this.running || !this.playlist.length) return;
    this.running = true;

    this.show(this.front).then(function (loaded) {
      if (!loaded) {
        if (global.console) console.warn("ambient: no wallpaper loaded");
        return;
      }
      self.front.classList.add("is-active");

      function tick() {
        self.advance().then(function () {
          global.setTimeout(tick, self.holdMs);
        });
      }

      global.setTimeout(tick, self.holdMs);
    });
  };

  global.Ambient = global.Ambient || {};
  global.Ambient.Slideshow = Slideshow;
})(window);
