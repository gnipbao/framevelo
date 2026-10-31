// End-to-end renders through real Chrome and FFmpeg. Enabled with FRAMEVELO_INTEGRATION=1.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findChrome, isHeadlessShell } from "../src/chrome.ts";
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
    // Keep video proxies out of the user's cache, but keep the browser found there.
    process.env.FRAMEVELO_CHROME ??= findChrome() ?? undefined;
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
    // Apple players read the colour description from the MP4 colr box: BT.709 primaries, transfer, matrix.
    const mp4 = await readFile(output);
    const colr = mp4.indexOf("colrnclx");
    assert.ok(colr > 0, "the MP4 has an nclx colr box");
    assert.deepEqual([mp4.readUInt16BE(colr + 8), mp4.readUInt16BE(colr + 10), mp4.readUInt16BE(colr + 12)], [1, 1, 1]);
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

  test("injected video frames split across worker pages concatenate seamlessly", async () => {
    // A HyperFrames composition that is 15 s of video: 450 frames injected from Node, two pages.
    const project = path.join(fixtures, "hf-long-video");
    if (!existsSync(path.join(project, "clip.mp4"))) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=15", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", path.join(project, "clip.mp4")]);
    }
    const single = path.join(dir, "workers-1.mp4");
    const split = path.join(dir, "workers-2.mp4");
    assert.equal((await render({ ...logging, input: project, output: single, workers: 1 })).workers, 1);
    const result = await render({ ...logging, input: project, output: split, workers: 2 });
    assert.equal(result.workers, 2);
    assert.equal((await probeVideo(split)).packets, 450);
    const keyframes = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "frame=key_frame", "-of", "csv=p=0", split], { encoding: "utf8" })
      .trim()
      .split("\n")
      .flatMap((flag, i) => (flag.startsWith("1") ? [i] : []));
    assert.ok(keyframes.includes(225), `the second range starts on a keyframe (keyframes ${keyframes.join(",")})`);
    const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", split, "-i", single, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { encoding: "utf8" });
    const psnr = Number(/average:([\d.]+)/.exec(stderr)?.[1]);
    assert.ok(psnr > 40, `split and single-page renders match (PSNR ${psnr} dB)`);
  });

  test("screenshot frames stay on one page", async () => {
    // Chrome serializes screenshot work: a second page would cost memory and gain little.
    const result = await render({ ...logging, input: path.join(examples, "dom-cards"), output: path.join(dir, "shots.mp4"), capture: "screenshot", fps: 120, frames: 400, width: 320, height: 180, workers: 2 });
    assert.equal(result.workers, 1);
    assert.equal(result.screenshotFrames, 400);
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

  test("full Chrome renders HyperFrames pages that are not in front", async (t) => {
    // Full Chrome paints only its front tab; the fresh page after verification is not in front.
    // An installed Google Chrome, found with the caches (and their headless shells) out of the way.
    const chrome = findChrome({ env: {}, home: dir });
    if (!chrome || isHeadlessShell(chrome) || !isHeadlessShell(process.env.FRAMEVELO_CHROME ?? "")) {
      return t.skip("needs Google Chrome next to the headless shell");
    }
    const output = path.join(dir, "full-chrome.mp4");
    const result = await render({ ...logging, input: path.join(examples, "hyperframes-project"), output, start: 0.5, frames: 30, chromePath: chrome });
    assert.match(result.chrome, /^Chrome\//);
    assert.equal((await probeVideo(output)).packets, 30);
  });

  test("colours come out as drawn, decoded with the tags the file carries", async () => {
    // Saturated red, green and blue show the encoder's matrix; dark grey shows its range, which
    // differs between encoders (Chrome's software encoder on Windows writes full range) and moves it
    // by 10 levels or more when mistagged. What must hold is what a player shows from the file's tags.
    const output = path.join(dir, "colors.mp4");
    const result = await render({ ...logging, input: path.join(fixtures, "color-patches.html"), output, frames: 3 });
    const encoder = result.page.colorSpace;
    assert.ok(encoder, "the encoder reports the colour space of its output");
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=color_range,color_space", "-of", "json", output], { encoding: "utf8" });
    const tags = (JSON.parse(probe) as { streams: { color_range: string; color_space: string }[] }).streams[0]!;
    const context = `tags ${tags.color_range}/${tags.color_space}, encoder ${JSON.stringify(encoder)}`;
    assert.equal(tags.color_range, encoder.fullRange ? "pc" : "tv", `tagged with the range the encoder wrote (${context})`);
    const rgb = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-frames:v", "1", "-vf", "scale=in_color_matrix=auto:in_range=auto,format=rgb24", "-f", "rawvideo", "-"]);
    const drawn = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], "dark grey": [40, 40, 40] };
    Object.entries(drawn).forEach(([name, want], i) => {
      const at = (32 * 256 + i * 64 + 32) * 3;
      const got = [rgb[at]!, rgb[at + 1]!, rgb[at + 2]!];
      assert.ok(got.every((v, c) => Math.abs(v - want[c]!) <= 6), `${name}: shown as ${got.join(",")}, drawn ${want.join(",")} (${context})`);
    });
  });

  test("paint reuse: the frames are the same without it, and the stats say what each frame needed", async () => {
    // The page steps every 10 frames and holds still in between.
    const input = path.join(fixtures, "paint-reuse.html");
    const reused = path.join(dir, "reuse-on.mp4");
    const requested = path.join(dir, "reuse-off.mp4");
    const on = (await render({ ...logging, input, output: reused })).page;
    const off = (await render({ ...logging, input, output: requested, reusePaints: false })).page;
    const counts = (p: typeof on) => `reused ${p.reusedPaints}, followed ${p.followedPaints}, requested ${p.requestedPaints}`;
    assert.ok(on.reusedPaints >= 40, `frames that change nothing reuse the canvas (${counts(on)})`);
    assert.ok(on.requestedPaints + on.followedPaints >= 6, `every step is painted (${counts(on)})`);
    assert.equal(off.reusedPaints + off.followedPaints, 0, `--no-paint-reuse requests every paint (${counts(off)})`);
    // A frame left one step behind would sit near 20 dB.
    const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", reused, "-i", requested, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { encoding: "utf8" });
    const min = /min:(\S+)/.exec(stderr)?.[1];
    assert.ok(min === "inf" || Number(min) > 40, `the same frames with and without reuse (min PSNR ${min} dB)`);
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
