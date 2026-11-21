/*
 * Main — wire the playlist, clock, slideshow and cast badge.
 *
 * Google's ambient slideshow speeds are 5 s, 10 s, 30 s, 1 m, 3 m, 5 m and
 * 10 m; this runs at 30 s, the standard speed.
 *
 * The device profile decides how much animation the hardware gets: a short
 * crossfade on lite devices, the full transition everywhere else.
 *
 * The TV itself has no mouse or keyboard controls: casting, pairing and
 * messages all arrive over the network.
 */
(function () {
  "use strict";

  var HOLD_MS = 30000;
  var lite = !!(window.Ambient.Device && window.Ambient.Device.profile === "lite");
  var CROSSFADE_MS = lite ? 350 : 1500;

  var playlist = Array.isArray(window.AMBIENT_PLAYLIST)
    ? window.AMBIENT_PLAYLIST.filter(function (url) {
        return typeof url === "string" && url;
      })
    : [];

  document.documentElement.style.setProperty("--fade", CROSSFADE_MS + "ms");

  function startCast() {
    if (!window.Ambient.Cast) return;

    new window.Ambient.Cast({
      badge: document.getElementById("cast"),
      code: document.getElementById("cast-code"),
      panel: document.getElementById("cast-panel"),
      eyebrow: document.getElementById("cast-panel-eyebrow"),
      headline: document.getElementById("cast-panel-headline"),
      sub: document.getElementById("cast-panel-sub")
    }).start();
  }

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

  startCast();
})();
