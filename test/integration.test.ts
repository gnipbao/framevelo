// End-to-end renders through real Chrome and FFmpeg. Enabled with FRAMEVELO_INTEGRATION=1.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { probeVideo } from "../src/ffmpeg.ts";
import { render } from "../src/render.ts";

const enabled = process.env.FRAMEVELO_INTEGRATION === "1";
const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

describe("render (integration)", { skip: !enabled && "set FRAMEVELO_INTEGRATION=1" }, () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-it-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("canvas page: exact frame count, size, BT.709 tags", async () => {
    const output = path.join(dir, "canvas.mp4");
    const result = await render({ input: path.join(examples, "canvas-particles"), output, frames: 30 });
    assert.equal(result.mode, "canvas");
    assert.equal(result.driver, "framevelo");
    const probe = await probeVideo(output);
    assert.equal(probe.packets, 30);
    assert.deepEqual([probe.width, probe.height], [1920, 1080]);
    assert.equal(probe.colorTransfer, "bt709");
  });

  test("DOM page through drawElementImage, scaled to 4K", async () => {
    const output = path.join(dir, "dom-4k.mp4");
    const result = await render({ input: path.join(examples, "dom-cards"), output, frames: 15, scale: 2 });
    assert.equal(result.mode, "dom");
    const probe = await probeVideo(output);
    assert.equal(probe.packets, 15);
    assert.deepEqual([probe.width, probe.height], [3840, 2160]);
  });

  test("HEVC, motion blur sub-frames and an audio track", async () => {
    const audio = path.join(dir, "tone.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", audio]);
    const output = path.join(dir, "hevc.mp4");
    let lastProgress = 0;
    await render({
      input: path.join(examples, "canvas-particles"),
      output,
      codec: "hevc",
      start: 1,
      frames: 20,
      subframes: 3,
      audio,
      onProgress: (done) => (lastProgress = done),
    });
    const probe = await probeVideo(output);
    assert.equal(probe.codec, "hevc");
    assert.equal(probe.packets, 20);
    assert.equal(probe.audioCodec, "aac");
    assert.equal(lastProgress, 20);
  });

  test("a page without a time driver fails clearly and leaves no partial file", async () => {
    const output = path.join(dir, "fail.mp4");
    await assert.rejects(
      render({ input: path.join(examples, "..", "test", "fixtures", "no-seek.html"), output, frames: 5, readyTimeoutMs: 200 }),
      /no way to seek time/,
    );
    assert.deepEqual((await readdir(dir)).filter((f) => f.includes("fail")), []);
  });
});
