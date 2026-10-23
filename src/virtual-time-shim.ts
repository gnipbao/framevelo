// Ported from HyperFrames (packages/producer/src/services/fileServer.ts, buildVirtualTimeShim with
// seedRandomFromFrame=false), Copyright HeyGen, Inc., licensed under the Apache License 2.0.
// The HyperFrames render bridge calls window.__HF_VIRTUAL_TIME__.seekToTime(ms) on every seek, so a
// page sees the composition time through Date, performance.now and requestAnimationFrame.

/**
 * Freezes `Date`, `performance.now` and the requestAnimationFrame queue at a virtual time that only
 * moves when the renderer seeks. Timers keep running on the real clock.
 */
export const VIRTUAL_TIME_SHIM = String.raw`(function() {
  if (window.__HF_VIRTUAL_TIME__) return;

  var virtualNowMs = 0;
  var rafId = 1;
  var rafQueue = [];
  var OriginalDate = Date;
  var originalSetTimeout = window.setTimeout.bind(window);
  var originalClearTimeout = window.clearTimeout.bind(window);
  var originalSetInterval = window.setInterval.bind(window);
  var originalClearInterval = window.clearInterval.bind(window);
  var originalRequestAnimationFrame = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : null;
  var originalCancelAnimationFrame = window.cancelAnimationFrame
    ? window.cancelAnimationFrame.bind(window)
    : null;

  function flushAnimationFrame() {
    if (!rafQueue.length) return;
    var current = rafQueue.slice();
    rafQueue.length = 0;
    for (var i = 0; i < current.length; i++) {
      var entry = current[i];
      if (entry.cancelled) continue;
      try {
        entry.callback(virtualNowMs);
      } catch (e) {}
    }
  }

  function VirtualDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof VirtualDate)) {
      return OriginalDate.apply(null, args.length ? args : [virtualNowMs]);
    }
    var instance = args.length
      ? new (Function.prototype.bind.apply(OriginalDate, [null].concat(args)))()
      : new OriginalDate(virtualNowMs);
    Object.setPrototypeOf(instance, VirtualDate.prototype);
    return instance;
  }

  VirtualDate.prototype = OriginalDate.prototype;
  Object.setPrototypeOf(VirtualDate, OriginalDate);
  VirtualDate.now = function() { return virtualNowMs; };
  VirtualDate.parse = OriginalDate.parse.bind(OriginalDate);
  VirtualDate.UTC = OriginalDate.UTC.bind(OriginalDate);

  try {
    Object.defineProperty(window, "Date", { configurable: true, writable: true, value: VirtualDate });
  } catch (e) {}

  if (window.performance && typeof window.performance.now === "function") {
    try {
      Object.defineProperty(window.performance, "now", {
        configurable: true,
        value: function() { return virtualNowMs; },
      });
    } catch (e) {}
  }

  window.requestAnimationFrame = function(callback) {
    if (typeof callback !== "function") return 0;
    var entry = { id: rafId++, callback: callback, cancelled: false };
    rafQueue.push(entry);
    return entry.id;
  };
  window.cancelAnimationFrame = function(id) {
    for (var i = 0; i < rafQueue.length; i++) {
      if (rafQueue[i].id === id) rafQueue[i].cancelled = true;
    }
  };

  window.__HF_VIRTUAL_TIME__ = {
    originalSetTimeout: originalSetTimeout,
    originalClearTimeout: originalClearTimeout,
    originalSetInterval: originalSetInterval,
    originalClearInterval: originalClearInterval,
    originalRequestAnimationFrame: originalRequestAnimationFrame,
    originalCancelAnimationFrame: originalCancelAnimationFrame,
    seekToTime: function(nextTimeMs) {
      virtualNowMs = Math.max(0, Number(nextTimeMs) || 0);
      flushAnimationFrame();
      return virtualNowMs;
    },
    getTime: function() {
      return virtualNowMs;
    },
  };
})();`;
