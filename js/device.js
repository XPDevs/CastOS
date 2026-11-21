/*
 * Device — chooses an animation profile from the hardware.
 *
 * "lite" trims the expensive paint work (backdrop blur, text shadows, long
 * crossfades, will-change layers) so a 1-2 GB Raspberry Pi or an old laptop
 * stays smooth. "full" is used when the machine has room to spare.
 *
 * Force it with ?profile=lite or ?profile=full; reduced-motion preferences
 * always get "lite".
 *
 * Exposes window.Ambient.Device.profile.
 */
(function (global) {
  "use strict";

  function parameter(name) {
    try {
      return new URLSearchParams(global.location.search).get(name);
    } catch (error) {
      return null;
    }
  }

  function detect() {
    var forced = parameter("profile");
    var memory = global.navigator.deviceMemory || 0;
    var cores = global.navigator.hardwareConcurrency || 0;
    var reduce = false;

    if (forced === "lite" || forced === "full") return forced;
    if (parameter("lite") === "1") return "lite";

    if (global.matchMedia) {
      reduce = global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    if (reduce) return "lite";
    if (memory && memory <= 2) return "lite";
    if (cores && cores <= 2) return "lite";

    return "full";
  }

  var profile = detect();

  global.document.documentElement.setAttribute("data-profile", profile);

  global.Ambient = global.Ambient || {};
  global.Ambient.Device = { profile: profile };
})(window);
