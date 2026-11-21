/*
 * Boot — plays the boot animation frames once, then reveals the screensaver.
 *
 * Exposes window.Ambient.Boot.
 */
(function (global) {
  "use strict";

  var FRAME_COUNT = 60;
  var FRAME_MS = 30;
  var HOLD_MS = 700;
  var FADE_MS = 600;

  function pad(value) {
    if (value < 10) return "00" + value;
    if (value < 100) return "0" + value;
    return String(value);
  }

  function frameUrl(index) {
    return "assets/boot/" + pad(index) + ".png";
  }

  function preloadFrames() {
    var images = [];
    var pending = [];

    function load(index) {
      var image = new Image();

      images[index] = image;
      pending.push(
        new Promise(function (resolve) {
          image.onload = resolve;
          image.onerror = resolve;
          image.src = frameUrl(index);
        })
      );
    }

    for (var i = 0; i < FRAME_COUNT; i++) load(i);
    return Promise.all(pending).then(function () {
      return images;
    });
  }

  function Boot(overlay, frame) {
    this.overlay = overlay;
    this.frame = frame;
  }

  Boot.prototype.play = function () {
    var self = this;

    return preloadFrames().then(function (images) {
      return new Promise(function (resolve) {
        var index = 0;

        if (images.length) self.frame.src = images[0].src;

        var timer = global.setInterval(function () {
          index += 1;
          if (index >= images.length) {
            global.clearInterval(timer);
            self.finish(resolve);
            return;
          }
          self.frame.src = images[index].src;
        }, FRAME_MS);
      });
    });
  };

  Boot.prototype.finish = function (done) {
    var self = this;

    global.setTimeout(function () {
      self.overlay.classList.add("is-done");
      global.setTimeout(function () {
        self.overlay.classList.add("is-hidden");
        done();
      }, FADE_MS);
    }, HOLD_MS);
  };

  global.Ambient = global.Ambient || {};
  global.Ambient.Boot = Boot;
})(window);
