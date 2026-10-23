import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntervals, mergeRoutes, psnrRgba, routeIntervals, sampleFrames } from "../src/planner.ts";

test("buildIntervals cuts at boundaries and caps interval length", () => {
  // 0..10 s at 10 fps, a clip boundary at 3 s, 2 s cap.
  assert.deepEqual(buildIntervals(0, 100, 10, [3, 12, -1]), [
    { start: 0, end: 15 },
    { start: 15, end: 30 },
    { start: 30, end: 48 },
    { start: 48, end: 65 },
    { start: 65, end: 83 },
    { start: 83, end: 100 },
  ]);
  assert.deepEqual(buildIntervals(10, 5, 30, []), [{ start: 10, end: 15 }]);
  assert.deepEqual(buildIntervals(0, 0, 30, [1]), []);
});

test("intervals tile the range exactly", () => {
  const intervals = buildIntervals(7, 1234, 30, [1.5, 2.25, 20, 41.1], 2);
  assert.equal(intervals[0]!.start, 7);
  assert.equal(intervals.at(-1)!.end, 7 + 1234);
  for (let i = 1; i < intervals.length; i++) assert.equal(intervals[i]!.start, intervals[i - 1]!.end);
});

test("sampleFrames picks the first and middle frame", () => {
  assert.deepEqual(sampleFrames({ start: 10, end: 20 }), [10, 15]);
  assert.deepEqual(sampleFrames({ start: 10, end: 11 }), [10]);
});

test("routeIntervals sends an interval with any weak sample to screenshots", () => {
  const intervals = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 20, end: 30 },
  ];
  const psnr = new Map([
    [0, 45],
    [5, 48],
    [10, 44],
    [15, 18.5],
  ]);
  const plans = routeIntervals(intervals, psnr, 30);
  assert.deepEqual(plans.map((p) => p.route), ["dom", "screenshot", "dom"]);
  assert.match(plans[1]!.reason, /18\.5 dB < 30 dB/);
  assert.equal(plans[2]!.reason, "not sampled");
  assert.deepEqual(mergeRoutes(plans), [
    { start: 0, end: 10, route: "dom" },
    { start: 10, end: 20, route: "screenshot" },
    { start: 20, end: 30, route: "dom" },
  ]);
  assert.deepEqual(mergeRoutes(routeIntervals(intervals, new Map(), 30)), [{ start: 0, end: 30, route: "dom" }]);
});

test("psnrRgba compares RGB and ignores alpha", () => {
  const a = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  assert.equal(psnrRgba(a, a.slice()), 100);
  const b = new Uint8Array([10, 20, 30, 0, 40, 50, 61, 255]);
  const expected = 10 * Math.log10((255 * 255) / (1 / 6));
  assert.ok(Math.abs(psnrRgba(a, b) - expected) < 1e-9);
  assert.throws(() => psnrRgba(a, new Uint8Array(4)));
});
