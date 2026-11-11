// Ported from HyperFrames 0.9.33 (packages/producer/src/services/fileServer.ts, VIRTUAL_TIME_SHIM),
// Copyright HeyGen, Inc., licensed under the Apache License 2.0. The HyperFrames render bridge calls
// window.__HF_VIRTUAL_TIME__.seekToTime(ms) on every seek, so a page sees the composition time
// through Date, performance.now, requestAnimationFrame and, once rendering starts, its timers.

/**
 * Freezes `Date`, `performance.now` and the requestAnimationFrame queue at a virtual time that only
 * moves when the renderer seeks, and seeds `Math.random` and `crypto.getRandomValues` from it so a
 * re-render repeats. Timers set before the page is ready keep the real clock; timers set after the
 * first seek past readiness fire on film time, in due order.
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

  // Seeded Math.random / crypto.getRandomValues, keyed by virtual time.
  // Mulberry32: single uint32 state, deterministic, fast.
  var rngState = 0;
  function mulberry32() {
    rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
    var t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function reseedRngFromTime(ms) {
    var ms32 = Math.max(0, Math.floor(Number(ms) || 0)) | 0;
    // Knuth's multiplicative hash + golden-ratio offset gives a well-
    // distributed seed even for frame 0 (otherwise rngState=0 degenerates
    // the PRNG's first few outputs).
    rngState = (Math.imul(ms32, -1640531527) + 0x9E3779B9) | 0;
  }
  reseedRngFromTime(0);
  try {
    Math.random = function() { return mulberry32(); };
  } catch (e) {}
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    try {
      var __seededGetRandomValues = function(arr) {
        if (!arr || typeof arr.byteLength !== "number" || !arr.buffer) return arr;
        var byteLen = arr.byteLength;
        if (byteLen <= 0) return arr;
        var view = new DataView(arr.buffer, arr.byteOffset, byteLen);
        var i = 0;
        for (; i + 4 <= byteLen; i += 4) {
          var word = ((mulberry32() * 4294967296) >>> 0);
          view.setUint32(i, word, true);
        }
        for (; i < byteLen; i++) {
          view.setUint8(i, (mulberry32() * 256) | 0);
        }
        return arr;
      };
      window.crypto.getRandomValues = __seededGetRandomValues;
    } catch (e) {}
  }

  function flushAnimationFrame() {
    if (!rafQueue.length) return;
    var current = rafQueue.slice();
    rafQueue.length = 0;
    for (var i = 0; i < current.length; i++) {
      var entry = current[i];
      if (entry.cancelled) continue;
      try {
        entry.callback(virtualNowMs);
      } catch {}
    }
  }

  function VirtualDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof VirtualDate)) {
      return OriginalDate.apply(null, args.length ? args : [virtualNowMs]);
    }
    var instance = args.length ? new (Function.prototype.bind.apply(OriginalDate, [null].concat(args)))() : new OriginalDate(virtualNowMs);
    Object.setPrototypeOf(instance, VirtualDate.prototype);
    return instance;
  }

  VirtualDate.prototype = OriginalDate.prototype;
  Object.setPrototypeOf(VirtualDate, OriginalDate);
  VirtualDate.now = function() { return virtualNowMs; };
  VirtualDate.parse = OriginalDate.parse.bind(OriginalDate);
  VirtualDate.UTC = OriginalDate.UTC.bind(OriginalDate);

  try {
    Object.defineProperty(window, "Date", {
      configurable: true,
      writable: true,
      value: VirtualDate,
    });
  } catch {}

  if (window.performance && typeof window.performance.now === "function") {
    try {
      Object.defineProperty(window.performance, "now", {
        configurable: true,
        value: function() { return virtualNowMs; },
      });
    } catch {}
  }

  window.requestAnimationFrame = function(callback) {
    if (typeof callback !== "function") return 0;
    var entry = { id: rafId++, callback: callback, cancelled: false };
    rafQueue.push(entry);
    return entry.id;
  };
  window.cancelAnimationFrame = function(id) {
    for (var i = 0; i < rafQueue.length; i++) {
      if (rafQueue[i].id === id) {
        rafQueue[i].cancelled = true;
      }
    }
  };

  // Timers set once rendering has started run on film time: each seek fires every timer due by then, in
  // due order. Until a seek after the page reports ready, timers keep the wall clock: setup code waits on
  // them while the renderer may already be seeking.
  var rendering = false;
  var timerQueue = [];
  var nextTimerId = 1000000000;
  var firingDepth = 0;
  function addTimer(callback, delay, args, repeats) {
    // A timer set from a firing timer waits at least 1 ms, so a zero-delay chain cannot stall a seek.
    var ms = Math.max(firingDepth > 0 ? 1 : 0, Number(delay) || 0);
    var entry = { id: nextTimerId++, callback: callback, args: args, due: virtualNowMs + ms, every: repeats ? Math.max(1, ms) : 0, cancelled: false };
    timerQueue.push(entry);
    return entry.id;
  }
  function cancelTimer(id) {
    for (var i = 0; i < timerQueue.length; i++) {
      if (timerQueue[i].id === id) {
        timerQueue[i].cancelled = true;
        return true;
      }
    }
    return false;
  }
  function fireDueTimers(untilMs) {
    // Frame times are fractional, so a timer due on a frame lands a rounding error past it; it still fires on it.
    untilMs += 0.000001;
    while (true) {
      var next = null;
      for (var i = 0; i < timerQueue.length; i++) {
        var candidate = timerQueue[i];
        if (!candidate.cancelled && candidate.due <= untilMs && (next === null || candidate.due < next.due)) next = candidate;
      }
      if (next === null) break;
      var dueMs = next.due;
      if (next.every) next.due += next.every;
      else next.cancelled = true;
      virtualNowMs = dueMs;
      firingDepth++;
      try {
        next.callback.apply(window, next.args);
      } catch (err) {
        originalSetTimeout(function() { throw err; }, 0);
      }
      firingDepth--;
    }
    timerQueue = timerQueue.filter(function(entry) { return !entry.cancelled; });
  }
  window.setTimeout = function(callback, delay) {
    if (!rendering || typeof callback !== "function") return originalSetTimeout.apply(null, arguments);
    return addTimer(callback, delay, Array.prototype.slice.call(arguments, 2), false);
  };
  window.setInterval = function(callback, delay) {
    if (!rendering || typeof callback !== "function") return originalSetInterval.apply(null, arguments);
    return addTimer(callback, delay, Array.prototype.slice.call(arguments, 2), true);
  };
  window.clearTimeout = function(id) {
    if (!cancelTimer(id)) originalClearTimeout(id);
  };
  window.clearInterval = function(id) {
    if (!cancelTimer(id)) originalClearInterval(id);
  };

  function seekToTime(nextTimeMs) {
    var safeTimeMs = Math.max(0, Number(nextTimeMs) || 0);
    if (!rendering && window.__renderReady === true) {
      rendering = true;
      // A worker whose first frame is past the start plays the film's first frame first, so timers the
      // page starts there keep the schedule a one-worker render gives them.
      if (safeTimeMs > 0) seekToTime(0);
    }
    reseedRngFromTime(safeTimeMs);
    fireDueTimers(safeTimeMs);
    virtualNowMs = safeTimeMs;
    flushAnimationFrame();
    return virtualNowMs;
  }

  window.__HF_VIRTUAL_TIME__ = {
    originalSetTimeout: originalSetTimeout,
    originalClearTimeout: originalClearTimeout,
    originalSetInterval: originalSetInterval,
    originalClearInterval: originalClearInterval,
    originalRequestAnimationFrame: originalRequestAnimationFrame,
    originalCancelAnimationFrame: originalCancelAnimationFrame,
    seekToTime: seekToTime,
    getTime: function() {
      return virtualNowMs;
    },
  };
})();`;
