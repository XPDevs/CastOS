/*
 * Clock — locale-aware time and date, redrawn on the minute boundary.
 *
 * Exposes window.Ambient.Clock.
 */
(function (global) {
  "use strict";

  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function Clock(timeEl, dateEl) {
    var options = new Intl.DateTimeFormat(undefined, { hour: "numeric" })
      .resolvedOptions();

    this.timeEl = timeEl;
    this.dateEl = dateEl;
    this.use12Hour = options.hourCycle === "h12" || options.hour12 === true;
    this.dateFormatter = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  }

  Clock.prototype.render = function () {
    var now = new Date();
    var hours = now.getHours();

    if (this.use12Hour) {
      hours = hours % 12;
      if (hours === 0) hours = 12;
    }

    this.timeEl.textContent =
      (this.use12Hour ? hours : pad(hours)) + ":" + pad(now.getMinutes());
    this.dateEl.textContent = this.dateFormatter.format(now);
  };

  Clock.prototype.start = function () {
    var self = this;

    function tick() {
      self.render();
      global.setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    }

    tick();
  };

  global.Ambient = global.Ambient || {};
  global.Ambient.Clock = Clock;
})(window);
