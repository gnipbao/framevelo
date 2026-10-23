import assert from "node:assert/strict";
import { test } from "node:test";
import { planSegments } from "../src/capture.ts";

const hook = async () => {};

test("without a hook the whole range runs in the page", () => {
  assert.deepEqual(planSegments({ startFrame: 10, frames: 50, fps: 30, subframeOffsets: [0] }), [{ start: 10, count: 50, hooked: false, route: "dom" }]);
  assert.deepEqual(planSegments({ startFrame: 0, frames: 0, fps: 30, subframeOffsets: [0] }), []);
});

test("hooked runs cover the needed window, the frame after it, and the first frame", () => {
  // Needed for t in [1, 2) at 10 fps: frames 10..19.
  const segments = planSegments({
    startFrame: 0,
    frames: 40,
    fps: 10,
    subframeOffsets: [0],
    beforeSample: hook,
    needsBeforeSample: (t) => t >= 1 && t < 2,
  });
  assert.deepEqual(segments, [
    { start: 0, count: 1, hooked: true, route: "dom" },
    { start: 1, count: 9, hooked: false, route: "dom" },
    { start: 10, count: 11, hooked: true, route: "dom" },
    { start: 21, count: 19, hooked: false, route: "dom" },
  ]);
  assert.equal(segments.reduce((n, s) => n + s.count, 0), 40);
});

test("a sub-frame inside the window hooks its frame", () => {
  const segments = planSegments({
    startFrame: 0,
    frames: 3,
    fps: 10,
    subframeOffsets: [-0.04, 0, 0.04],
    beforeSample: hook,
    needsBeforeSample: (t) => t >= 0.24,
  });
  // Frame 2 (t=0.2) has a sub-frame at 0.24.
  assert.deepEqual(segments, [
    { start: 0, count: 1, hooked: true, route: "dom" },
    { start: 1, count: 1, hooked: false, route: "dom" },
    { start: 2, count: 1, hooked: true, route: "dom" },
  ]);
});

test("hooking every frame when no predicate is given", () => {
  assert.deepEqual(planSegments({ startFrame: 5, frames: 4, fps: 30, subframeOffsets: [0], beforeSample: hook }), [{ start: 5, count: 4, hooked: true, route: "dom" }]);
});

test("screenshot intervals are always driven from Node and split segments", () => {
  const segments = planSegments({ startFrame: 0, frames: 10, fps: 10, subframeOffsets: [0] }, (frame) => (frame >= 4 && frame < 7 ? "screenshot" : "dom"));
  assert.deepEqual(segments, [
    { start: 0, count: 4, hooked: false, route: "dom" },
    { start: 4, count: 3, hooked: true, route: "screenshot" },
    { start: 7, count: 3, hooked: false, route: "dom" },
  ]);
});
