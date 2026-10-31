import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { framePsnr } from "../bench/measure.ts";
import { prepareRemotionFixture, remotionFixture, remotionFixtureInstalled } from "../scripts/remotion-fixture.ts";
import { findChrome } from "../src/chrome.ts";
import { probeVideo, remuxWithAudioArgs } from "../src/ffmpeg.ts";
import { renderOptionsFromArgs } from "../src/mcp.ts";
import { findRemotionEntry, isRemotionProject, remotionProjectFor } from "../src/remotion.ts";
import { render } from "../src/render.ts";

function project(pkg: Record<string, unknown> | null, files: string[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "framevelo-remotion-unit-"));
  if (pkg) writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), "");
  }
  return dir;
}

test("a Remotion project is a package that depends on remotion", () => {
  const dirs = [
    project({ dependencies: { remotion: "4.0.539" } }),
    project({ devDependencies: { remotion: "^4" } }),
    project({ dependencies: { react: "19" } }),
    project(null),
  ];
  try {
    assert.deepEqual(dirs.map(isRemotionProject), [true, true, false, false]);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("the entry point is found where remotion render looks for it", () => {
  const dir = project({ dependencies: { remotion: "4" } }, ["remotion/index.tsx", "src/index.ts"]);
  try {
    assert.equal(findRemotionEntry(dir), path.join(dir, "src", "index.ts"));
    assert.deepEqual(remotionProjectFor(dir), { projectDir: dir, entry: path.join(dir, "src", "index.ts") });
    // An entry file names its project, the nearest package above it that depends on remotion.
    assert.deepEqual(remotionProjectFor(path.join(dir, "remotion", "index.tsx")), { projectDir: dir, entry: path.join(dir, "remotion", "index.tsx") });
    assert.equal(remotionProjectFor(path.join(dir, "missing.ts")), null);
    assert.equal(findRemotionEntry(project({ dependencies: { remotion: "4" } })), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pages and other projects are not Remotion projects", () => {
  const dir = project({ dependencies: { react: "19" } }, ["src/index.ts", "index.html"]);
  try {
    assert.equal(remotionProjectFor(dir), null);
    assert.equal(remotionProjectFor(path.join(dir, "index.html")), null);
    assert.equal(remotionProjectFor(path.join(dir, "src", "index.ts")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the MCP render tool passes the composition and its props", () => {
  const options = renderOptionsFromArgs({ input: "/work/promo", composition: "Main", props: { title: "Hi", n: 2 } });
  assert.equal(options.composition, "Main");
  assert.deepEqual(options.props, { title: "Hi", n: 2 });
  assert.throws(() => renderOptionsFromArgs({ input: "/a", props: ["x"] }), /props must be an object/);
  assert.throws(() => renderOptionsFromArgs({ input: "/a", composition: "" }), /composition must be a non-empty string/);
});

test("the mixed audio is copied in beside the video, never re-encoded or cut", () => {
  const args = remuxWithAudioArgs("v.mp4", "a.m4a", "out.mp4");
  assert.deepEqual(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4), ["-map", "0:v:0", "-map", "1:a:0"]);
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.ok(!args.includes("-shortest"));
  assert.equal(args.at(-1), "out.mp4");
});

const integration = process.env.FRAMEVELO_INTEGRATION === "1";
const skip = !integration ? "set FRAMEVELO_INTEGRATION=1" : !remotionFixtureInstalled() ? "the Remotion fixture is not installed: node scripts/remotion-fixture.ts" : false;

describe("Remotion projects (integration)", { skip }, () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "framevelo-remotion-"));
    prepareRemotionFixture({ install: false });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a composition renders with its audio, matching remotion render", async () => {
    const output = path.join(dir, "scene.mp4");
    const result = await render({ input: remotionFixture, output, composition: "Scene" });
    assert.equal(result.pipeline, "remotion");
    assert.equal(result.driver, "remotion");
    const probe = await probeVideo(output);
    assert.equal(probe.packets, 90);
    assert.deepEqual([probe.width, probe.height], [1280, 720]);
    assert.equal(probe.audioCodec, "aac");

    // remotion render on the same Chrome, so that only capture and encoding differ.
    const reference = path.join(dir, "scene.remotion.mp4");
    const chrome = findChrome();
    execFileSync(
      process.execPath,
      [path.join(remotionFixture, "node_modules", "@remotion", "cli", "remotion-cli.js"), "render", "Scene", reference, "--log=error", ...(chrome ? ["--browser-executable", chrome] : [])],
      { cwd: remotionFixture, stdio: "inherit" },
    );
    const psnr = framePsnr(output, reference);
    assert.ok(psnr && psnr.frames === 90, "both renders decode to 90 frames");
    // An <OffthreadVideo> frame captured before it was shown would sit near 16 dB.
    assert.ok(psnr.min > 35 && psnr.average > 40, `matches remotion render (avg ${psnr.average.toFixed(1)} dB, min ${psnr.min.toFixed(1)} dB)`);
    const samples = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 64 << 20 });
    assert.ok(samples(output).equals(samples(reference)), "the audio is Remotion's own mix, sample for sample");
  });

  test("with several compositions and none chosen, the error names them", async () => {
    await assert.rejects(render({ input: remotionFixture, output: path.join(dir, "none.mp4"), frames: 5 }), /pick one with --composition: Scene, Card, Showcase/);
    await assert.rejects(render({ input: remotionFixture, output: path.join(dir, "bad.mp4"), composition: "Nope", frames: 5 }), /No composition "Nope"/);
  });

  test("input props reach the composition", async () => {
    const plain = path.join(dir, "plain.mp4");
    const titled = path.join(dir, "titled.mp4");
    await render({ input: remotionFixture, output: plain, composition: "Scene", start: 1, frames: 5 });
    await render({ input: remotionFixture, output: titled, composition: "Scene", start: 1, frames: 5, props: { title: "Props reach the page" } });
    const psnr = framePsnr(plain, titled);
    assert.ok(psnr && psnr.average < 35, `a different title changes the picture (${psnr?.average.toFixed(1)} dB)`);
  });

  test("an entry file names its project", async () => {
    const output = path.join(dir, "card.mp4");
    const result = await render({ input: path.join(remotionFixture, "src", "index.ts"), output, composition: "Card", frames: 10 });
    assert.equal(result.pipeline, "remotion");
    assert.deepEqual([result.width, result.height, result.frames], [720, 720, 10]);
    assert.equal((await probeVideo(output)).audioCodec, undefined, "a composition without media gets no audio track");
  });
});
