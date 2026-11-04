import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildMuxArgs, colorTags, durationMismatch, frameTimeBase, probeVideo, trackTimescale } from "../src/ffmpeg.ts";

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/** FFmpeg on PATH can make an H.264 stream to mux. */
const x264 = (() => {
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("libx264");
  } catch {
    return false;
  }
})();

test("muxed frames last 1/fps each with the FFmpeg on PATH", { skip: !x264 && "needs ffmpeg with libx264" }, async () => {
  // FFmpeg 8.1 and later put all 150 frames of a 5 s render within 0.05 s; only the length showed it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "framevelo-mux-"));
  try {
    // Annex-B with I and P frames only, as the WebCodecs encoder writes it.
    const raw = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64", "-frames:v", "45", "-c:v", "libx264", "-bf", "0", "-g", "15", "-f", "h264", "-"]);
    for (const fps of [30, 29.97]) {
      const output = path.join(dir, `${fps}.mp4`);
      execFileSync("ffmpeg", buildMuxArgs({ codec: "h264", fps, output }), { input: raw });
      const probe = await probeVideo(output);
      assert.equal(probe.packets, 45);
      assert.equal(durationMismatch(probe, 45, fps), null, `${fps} fps`);
      const timeBase = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=time_base", "-of", "csv=p=0", output], { encoding: "utf8" }).trim();
      assert.equal(timeBase, `1/${trackTimescale(fps)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a video that is not its frames' length is caught", () => {
  const probe = (videoSeconds: number) => ({ codec: "h264", width: 64, height: 64, packets: 150, durationSeconds: videoSeconds, videoSeconds });
  assert.equal(durationMismatch(probe(5), 150, 30), null);
  assert.equal(durationMismatch(probe((150 * 1001) / 30000), 150, 29.97), null);
  assert.equal(durationMismatch(probe(0.049674), 150, 30), "the video lasts 0.050 s, but 150 frames at 30 fps last 5.000 s");
  assert.ok(durationMismatch(probe(149 / 30), 150, 30), "a frame short");
});

test("frameTimeBase handles integer and NTSC rates", () => {
  assert.equal(frameTimeBase(30), "1/30");
  assert.equal(frameTimeBase(60), "1/60");
  assert.equal(frameTimeBase(29.97), "1001/30000");
  assert.equal(frameTimeBase(23.976), "1001/24000");
  assert.equal(frameTimeBase(59.94), "1001/60000");
  assert.throws(() => frameTimeBase(12.345));
});

test("the track timescale makes every frame whole ticks", () => {
  assert.equal(trackTimescale(30), 15360);
  assert.equal(trackTimescale(60), 15360);
  assert.equal(trackTimescale(24), 12288);
  assert.equal(trackTimescale(29.97), 30000);
});

test("video-only mux copies the stream, tags BT.709 and stamps frame timestamps", () => {
  const args = buildMuxArgs({ codec: "h264", fps: 30, output: "out.mp4" });
  assert.equal(valueAfter(args, "-f"), "h264");
  assert.equal(valueAfter(args, "-i"), "pipe:0");
  assert.equal(valueAfter(args, "-c:v"), "copy");
  const bsf = valueAfter(args, "-bsf:v")!;
  assert.match(bsf, /^h264_metadata=.*colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1/);
  // In the filter's own time base: since FFmpeg 8.1, setts rescales its results when time_base is set.
  assert.match(bsf, /setts=ts=N\*\(1\/30\)\/TB:duration=\(1\/30\)\/TB$/);
  assert.equal(valueAfter(args, "-video_track_timescale"), "15360");
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

test("the stream is tagged with the range and matrix the encoder reported", () => {
  // Chrome's software H.264 encoder on Windows writes full-range BT.709; the others limited range.
  const full = buildMuxArgs({ codec: "h264", fps: 30, output: "out.mp4", colorSpace: { matrix: "bt709", primaries: "bt709", transfer: "iec61966-2-1", fullRange: true } });
  assert.match(valueAfter(full, "-bsf:v")!, /video_full_range_flag=1:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1/);
  assert.equal(valueAfter(full, "-color_range"), "pc");
  const bt601 = buildMuxArgs({ codec: "hevc", fps: 30, output: "out.mp4", colorSpace: { matrix: "smpte170m", primaries: "smpte170m", fullRange: false } });
  assert.match(valueAfter(bt601, "-bsf:v")!, /^hevc_metadata=video_full_range_flag=0:colour_primaries=6:transfer_characteristics=1:matrix_coefficients=6/);
  assert.deepEqual([valueAfter(bt601, "-colorspace"), valueAfter(bt601, "-color_primaries"), valueAfter(bt601, "-color_range")], ["smpte170m", "smpte170m", "tv"]);
  // Nothing reported, or something unknown: BT.709, limited range.
  assert.deepEqual(colorTags(), { matrixCode: 1, matrix: "bt709", primariesCode: 1, primaries: "bt709", fullRange: false });
  assert.deepEqual(colorTags({ matrix: "rgb", primaries: "film" }), colorTags());
});
