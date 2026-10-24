// End-to-end renders through real Chrome and FFmpeg. Enabled with FRAMEVELO_INTEGRATION=1.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../src/doctor.ts";
import { probeVideo } from "../src/ffmpeg.ts";
import { render } from "../src/render.ts";

const enabled = process.env.FRAMEVELO_INTEGRATION === "1";
// On CI, render logs show how far a slow or stuck render got.
const logging = process.env.CI ? { onLog: (line: string) => process.stderr.write(`  [framevelo] ${line}\n`) } : {};
const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("render (integration)", { skip: !enabled && "set FRAMEVELO_INTEGRATION=1" }, () => {
  let dir: string;
  // Encoders differ between machines: CI runners have no hardware HEVC encoder, for instance.
  const encoders = new Set<string>();
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-it-"));
    // Keep video proxies out of the user's cache.
    process.env.FRAMEVELO_CACHE_DIR = path.join(dir, "cache");
    for (const check of await runDoctor()) if (check.name.startsWith("Encoder ") && check.ok) encoders.add(check.name.slice(8));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("canvas page: exact frame count, size, BT.709 tags", async () => {
    const output = path.join(dir, "canvas.mp4");
    const result = await render({ ...logging, input: path.join(examples, "canvas-particles"), output, frames: 30 });
    assert.equal(result.mode, "canvas");
    assert.equal(result.driver, "framevelo");
    const probe = await probeVideo(output);
    assert.equal(probe.packets, 30);
    assert.deepEqual([probe.width, probe.height], [1920, 1080]);
    assert.equal(probe.colorTransfer, "bt709");
  });

  test("DOM page through drawElementImage, scaled to 4K", async (t) => {
    if (!encoders.has("H.264 4K")) return t.skip("this Chrome cannot encode H.264 at 4K");
    const output = path.join(dir, "dom-4k.mp4");
    const result = await render({ ...logging, input: path.join(examples, "dom-cards"), output, frames: 15, scale: 2 });
    assert.equal(result.mode, "dom");
    const probe = await probeVideo(output);
    assert.equal(probe.packets, 15);
    assert.deepEqual([probe.width, probe.height], [3840, 2160]);
  });

  test("HEVC, motion blur sub-frames and an audio track", async (t) => {
    if (!encoders.has("HEVC 1080p")) return t.skip("this Chrome cannot encode HEVC");
    const audio = path.join(dir, "tone.wav");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", audio]);
    const output = path.join(dir, "hevc.mp4");
    let lastProgress = 0;
    await render({
      ...logging,
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

  test("Node-driven frames split across worker pages concatenate seamlessly", async () => {
    const common = { input: path.join(examples, "dom-cards"), capture: "screenshot", fps: 120, frames: 400, width: 320, height: 180 } as const;
    const single = path.join(dir, "workers-1.mp4");
    const split = path.join(dir, "workers-2.mp4");
    assert.equal((await render({ ...logging, ...common, output: single, workers: 1 })).workers, 1);
    const result = await render({ ...logging, ...common, output: split, workers: 2 });
    assert.equal(result.workers, 2);
    assert.equal((await probeVideo(split)).packets, 400);
    const keyframes = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=key_frame", "-of", "csv=p=0", split], { encoding: "utf8" })
      .trim()
      .split("\n")
      .flatMap((flag, i) => (flag.startsWith("1") ? [i] : []));
    assert.ok(keyframes.includes(200), `the second range starts on a keyframe (keyframes ${keyframes.join(",")})`);
    const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", split, "-i", single, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { encoding: "utf8" });
    const psnr = Number(/average:([\d.]+)/.exec(stderr)?.[1]);
    assert.ok(psnr > 40, `split and single-page renders match (PSNR ${psnr} dB)`);
  });

  test("HyperFrames project: official compile and runtime, injected video, plan audio", async () => {
    const output = path.join(dir, "hyperframes.mp4");
    // Frames 15..44 (0.5 s to 1.5 s) cross the b-roll's entrance at 1 s.
    const result = await render({ ...logging, input: path.join(examples, "hyperframes-project"), output, start: 0.5, frames: 30 });
    assert.equal(result.pipeline, "hyperframes");
    assert.equal(result.driver, "hyperframes");
    assert.equal(result.audio, true);
    const probe = await probeVideo(output);
    assert.equal(probe.packets, 30);
    assert.equal(probe.audioCodec, "aac");
    // The b-roll box is empty before 1 s and shows the injected test pattern after it.
    const crop = "crop=600:300:1100:300";
    const { stderr } = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-i", output, "-i", output, "-lavfi", `[0:v]select=eq(n\\,5),${crop},setpts=0[a];[1:v]select=eq(n\\,25),${crop},setpts=0[b];[a][b]psnr`, "-f", "null", "-"],
      { encoding: "utf8" },
    );
    const psnr = Number(/average:([\d.]+)/.exec(stderr)?.[1]);
    assert.ok(psnr > 0 && psnr < 20, `the video region should change once the b-roll is injected (PSNR ${psnr} dB)`);
  });

  test("HyperFrames: verification leaves no callback state behind; the mix is held to −1 dBTP", async () => {
    const project = path.join(dir, "hyperframes-callbacks");
    await cp(path.join(fixtures, "hyperframes-callbacks"), project, { recursive: true });
    const tone = "0.99*sin(2*PI*997*t)";
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `aevalsrc=${tone}|${tone}:s=48000:d=6`, path.join(project, "tone.wav")]);
    // Six seconds verify samples up to 5 s, after both keys of the box's move have run; the first
    // second alone verifies nothing past 0.5 s. Their first 30 frames must match.
    const long = path.join(dir, "callbacks-long.mp4");
    const short = path.join(dir, "callbacks-short.mp4");
    const result = await render({ ...logging, input: project, output: long, capture: "auto", workers: 1 });
    assert.equal(result.pipeline, "hyperframes");
    assert.equal(result.frames, 180);
    await render({ ...logging, input: project, output: short, capture: "auto", frames: 30, workers: 1 });
    const { stderr } = spawnSync(
      "ffmpeg",
      ["-hide_banner", "-i", long, "-i", short, "-lavfi", "[0:v]trim=end_frame=30[a];[1:v]trim=end_frame=30[b];[a][b]psnr", "-f", "null", "-"],
      { encoding: "utf8" },
    );
    const psnr = Number(/average:([\d.]+|inf)/.exec(stderr)?.[1]?.replace("inf", "100"));
    assert.ok(psnr > 40, `the first second matches whatever was verified later (PSNR ${psnr} dB)`);
    const loudness = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", long, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const truePeak = Number(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)/.exec(loudness)?.[1]);
    assert.ok(truePeak <= -1, `the AAC track's true peak is held to -1 dBTP (${truePeak} dBTP)`);
  });

  test("plain page <video data-start> is frame-exact on the composition clock", async () => {
    const output = path.join(dir, "video-page.mp4");
    const result = await render({ ...logging, input: path.join(examples, "video-page"), output, frames: 60 });
    assert.equal(result.page.frames, 60);
    // Output frame i shows source frame i - 15 (data-start 0.5 s at 30 fps). Compare the source's
    // timecode corner in grayscale against the expected source frame and its neighbours.
    const source = path.join(examples, "video-page", "assets", "clip.mp4");
    const corner = (input: string, frame: number, x: number, y: number) =>
      `[${input}]select=eq(n\\,${frame}),crop=200:44:${x}:${y},format=gray,setpts=0`;
    const psnr = (frame: number, sourceFrame: number) => {
      const { stderr } = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-i", output, "-i", source, "-lavfi", `${corner("0:v", frame, 160, 200)}[a];${corner("1:v", sourceFrame, 0, 0)}[b];[a][b]psnr`, "-f", "null", "-"],
        { encoding: "utf8" },
      );
      const value = /average:(\S+)/.exec(stderr)?.[1];
      return value === "inf" ? 100 : Number(value);
    };
    for (const frame of [31, 44, 59]) {
      const exact = psnr(frame, frame - 15);
      assert.ok(exact > psnr(frame, frame - 16) && exact > psnr(frame, frame - 14), `frame ${frame} shows source frame ${frame - 15}`);
    }
  });

  test("a page without a time driver fails clearly and leaves no partial file", async () => {
    const output = path.join(dir, "fail.mp4");
    await assert.rejects(
      render({ ...logging, input: path.join(examples, "..", "test", "fixtures", "no-seek.html"), output, frames: 5, readyTimeoutMs: 200 }),
      /no way to seek time/,
    );
    assert.deepEqual((await readdir(dir)).filter((f) => f.includes("fail")), []);
  });
});
