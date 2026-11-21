/*
 * Main — boot, then wire the playlist, clock and slideshow together, and
 * handle fullscreen.
 *
 * Google's ambient slideshow speeds are 5 s, 10 s, 30 s, 1 m, 3 m, 5 m and
 * 10 m; this runs at 30 s, the standard speed.
 */
(function () {
  "use strict";

  var HOLD_MS = 30000;
  var CROSSFADE_MS = 1500;

  var playlist = Array.isArray(window.AMBIENT_PLAYLIST)
    ? window.AMBIENT_PLAYLIST.filter(function (url) {
        return typeof url === "string" && url;
      })
    : [];

  document.documentElement.style.setProperty("--fade", CROSSFADE_MS + "ms");

  function startAmbient() {
    new window.Ambient.Clock(
      document.getElementById("clock-time"),
      document.getElementById("clock-date")
    ).start();

    if (playlist.length) {
      new window.Ambient.Slideshow(
        [document.getElementById("slide-a"), document.getElementById("slide-b")],
        playlist,
        HOLD_MS
      ).start();
    } else if (window.console) {
      console.warn("ambient: playlist is empty");
    }
  }

  function enterFullscreen() {
    var element = document.documentElement;
    var request = element.requestFullscreen || element.webkitRequestFullscreen ||
      element.mozRequestFullScreen || element.msRequestFullscreen;
    var result;

    if (document.fullscreenElement || document.webkitFullscreenElement ||
        document.mozFullScreenElement || document.msFullscreenElement)
      return;

    if (!request) return;
    result = request.call(element);
    if (result && typeof result.catch === "function") result.catch(function () {});
  }

  document.addEventListener("click", enterFullscreen);
  document.addEventListener("keydown", function (event) {
    if (event.key === "f" || event.key === "F") enterFullscreen();
  });

  /* The boot screen hands over to the screensaver when the animation ends;
     if it cannot run, the screensaver starts anyway. */
  var boot = new window.Ambient.Boot(
    document.getElementById("boot"),
    document.getElementById("boot-frame")
  );

  boot.play().then(startAmbient, startAmbient);
})();
