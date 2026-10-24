import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMuxArgs, frameTimeBase } from "../src/ffmpeg.ts";

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("frameTimeBase handles integer and NTSC rates", () => {
  assert.equal(frameTimeBase(30), "1/30");
  assert.equal(frameTimeBase(60), "1/60");
  assert.equal(frameTimeBase(29.97), "1001/30000");
  assert.equal(frameTimeBase(23.976), "1001/24000");
  assert.equal(frameTimeBase(59.94), "1001/60000");
  assert.throws(() => frameTimeBase(12.345));
});

test("video-only mux copies the stream, tags BT.709 and stamps frame timestamps", () => {
  const args = buildMuxArgs({ codec: "h264", fps: 30, output: "out.mp4" });
  assert.equal(valueAfter(args, "-f"), "h264");
  assert.equal(valueAfter(args, "-i"), "pipe:0");
  assert.equal(valueAfter(args, "-c:v"), "copy");
  const bsf = valueAfter(args, "-bsf:v")!;
  assert.match(bsf, /^h264_metadata=.*colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1/);
  assert.match(bsf, /setts=ts=N:duration=1:time_base=1\/30$/);
  // The container's colr box follows the stream parameters, not the rewritten bitstream.
  for (const option of ["-color_primaries", "-color_trc", "-colorspace"]) assert.equal(valueAfter(args, option), "bt709");
  assert.equal(valueAfter(args, "-color_range"), "tv");
  assert.ok(!args.includes("-shortest"));
  assert.ok(!args.includes("-tag:v"));
  assert.equal(args.at(-1), "out.mp4");
});

test("HEVC uses the hevc demuxer, metadata filter and hvc1 tag", () => {
  const args = buildMuxArgs({ codec: "hevc", fps: 30, output: "out.mp4" });
  assert.equal(valueAfter(args, "-f"), "hevc");
  assert.match(valueAfter(args, "-bsf:v")!, /^hevc_metadata=/);
  assert.equal(valueAfter(args, "-tag:v"), "hvc1");
});

test("audio is mapped, encoded, trimmed to the video and offset by the start time", () => {
  const args = buildMuxArgs({ codec: "h264", fps: 30, output: "out.mp4", audio: "a.wav", audioEncoder: "aac_at", audioOffset: 2.5 });
  const ss = args.indexOf("-ss");
  assert.ok(ss > 0 && args[ss + 1] === "2.5" && args[ss + 2] === "-i" && args[ss + 3] === "a.wav", "seek applies to the audio input");
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "-map"), ["0:v:0", "1:a:0"]);
  assert.equal(valueAfter(args, "-c:a"), "aac_at");
  assert.ok(!args.includes("-shortest"), "never drop video frames for a shorter audio track");
});

test("audio is cut to the video length on the audio input, never the video", () => {
  const args = buildMuxArgs({ codec: "h264", fps: 30, output: "o.mp4", audio: "a.wav", audioOffset: 1, videoSeconds: 572 / 30 });
  const t = args.indexOf("-t");
  assert.equal(args[t + 1], "19.066667");
  assert.equal(args[t + 2], "-i");
  assert.equal(args[t + 3], "a.wav", "-t limits the audio input");
  assert.equal(args.lastIndexOf("-t"), t, "no output -t that could cut video frames");
  assert.ok(!args.includes("-shortest"));
});

test("no audio offset when rendering from the start", () => {
  assert.ok(!buildMuxArgs({ codec: "h264", fps: 30, output: "o.mp4", audio: "a.wav", audioOffset: 0 }).includes("-ss"));
});

test("an AAC track can be copied instead of re-encoded", () => {
  const args = buildMuxArgs({ codec: "h264", fps: 30, output: "o.mp4", audio: "mix.m4a", audioEncoder: "copy" });
  assert.equal(valueAfter(args, "-c:a"), "copy");
  assert.ok(!args.includes("-b:a"));
});
