import assert from "node:assert/strict";
import { test } from "node:test";
import { codecString, defaultBitrate, evenDimension, frameCount, keyframeInterval, parseBitrate, subframeOffsets } from "../src/options.ts";

test("parseBitrate accepts plain numbers and k/M/G suffixes", () => {
  assert.equal(parseBitrate("12M"), 12_000_000);
  assert.equal(parseBitrate("1.5m"), 1_500_000);
  assert.equal(parseBitrate("800k"), 800_000);
  assert.equal(parseBitrate("2G"), 2_000_000_000);
  assert.equal(parseBitrate("12000000"), 12_000_000);
});

test("parseBitrate rejects malformed or non-positive values", () => {
  for (const bad of ["", "fast", "12 Mbps", "-3M", "0"]) assert.throws(() => parseBitrate(bad), /bitrate/i, bad);
});

test("defaultBitrate scales with pixels and frame rate, and HEVC needs less", () => {
  assert.equal(defaultBitrate(1920, 1080, 30, "h264"), 12_400_000);
  assert.ok(defaultBitrate(3840, 2160, 30, "h264") > 4 * 12_000_000);
  assert.ok(defaultBitrate(1920, 1080, 30, "hevc") < defaultBitrate(1920, 1080, 30, "h264"));
  assert.equal(defaultBitrate(16, 16, 1, "h264"), 1_000_000, "clamped to a 1 Mbps floor");
});

test("quality presets scale the default bitrate", () => {
  assert.equal(defaultBitrate(1920, 1080, 30, "h264", "draft"), 6_200_000);
  assert.equal(defaultBitrate(1920, 1080, 30, "h264", "standard"), 12_400_000);
  assert.equal(defaultBitrate(1920, 1080, 30, "h264", "high"), 19_900_000);
});

test("frameCount treats the duration as whole frame intervals", () => {
  assert.equal(frameCount(10, 30), 300);
  assert.equal(frameCount(0.1 + 0.2, 10), 3, "floating-point noise does not add a frame");
  assert.equal(frameCount(1.01, 30), 31);
  assert.equal(frameCount(0.001, 30), 1);
  assert.throws(() => frameCount(0, 30));
  assert.throws(() => frameCount(1, 0));
});

test("subframeOffsets are centered on the frame and span the shutter", () => {
  assert.deepEqual(subframeOffsets(1, 0.5, 30), [0]);
  const offsets = subframeOffsets(4, 0.5, 30);
  assert.equal(offsets.length, 4);
  assert.ok(Math.abs(offsets.reduce((a, b) => a + b, 0)) < 1e-12, "centered");
  assert.ok(Math.abs(offsets[3]! - offsets[0]! - (0.5 / 30) * 0.75) < 1e-12, "spread over the shutter");
  assert.throws(() => subframeOffsets(0, 0.5, 30));
  assert.throws(() => subframeOffsets(2, 1.5, 30));
});

test("evenDimension rounds down to an even size", () => {
  assert.equal(evenDimension(1920), 1920);
  assert.equal(evenDimension(1081), 1080);
  assert.equal(evenDimension(1080.6), 1080);
});

test("codecString raises the level above 4K30", () => {
  assert.equal(codecString("h264", 1920, 1080, 60), "avc1.640033");
  assert.equal(codecString("h264", 3840, 2160, 30), "avc1.640033");
  assert.equal(codecString("h264", 3840, 2160, 60), "avc1.640034");
  assert.equal(codecString("hevc", 3840, 2160, 60), "hvc1.1.6.L156.B0");
});

test("keyframeInterval is two seconds of frames", () => {
  assert.equal(keyframeInterval(30), 60);
  assert.equal(keyframeInterval(29.97), 60);
});
