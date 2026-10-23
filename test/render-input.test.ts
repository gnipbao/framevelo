import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findCodeVideoSkill, fpsFromHtml, isCodeVideoHtml, localFileForUrl, resolveInput, videoWindows, viewportFromHtml } from "../src/render.ts";

test("viewportFromHtml prefers the HyperFrames root size", () => {
  const html = `<meta name="viewport" content="width=800, height=600" />
    <div id="root" data-composition-id="main" data-width="1080" data-height="1920" data-duration="5"></div>`;
  assert.deepEqual(viewportFromHtml(html), { width: 1080, height: 1920 });
});

test("viewportFromHtml falls back to the viewport meta tag, then null", () => {
  assert.deepEqual(viewportFromHtml(`<meta name="viewport" content="width=1280, height=720">`), { width: 1280, height: 720 });
  assert.equal(viewportFromHtml(`<meta name="viewport" content="width=device-width">`), null);
  assert.equal(viewportFromHtml(`<div data-width="10" data-height="10"></div>`), null, "ignores elements that are not a composition root");
});

test("resolveInput accepts a file or a directory with index.html", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-input-"));
  try {
    await writeFile(path.join(dir, "scene.html"), "");
    assert.deepEqual(await resolveInput(path.join(dir, "scene.html")), { root: dir, file: path.join(dir, "scene.html") });
    await assert.rejects(resolveInput(dir), /No index.html/);
    await writeFile(path.join(dir, "index.html"), "");
    assert.deepEqual(await resolveInput(dir), { root: dir, file: path.join(dir, "index.html") });
    await assert.rejects(resolveInput(path.join(dir, "missing.html")), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fpsFromHtml reads data-fps from the composition root only", () => {
  assert.equal(fpsFromHtml(`<div data-composition-id="main" data-fps="60" data-width="1920"></div>`), 60);
  assert.equal(fpsFromHtml(`<div data-composition-id="main"></div>`), undefined);
  assert.equal(fpsFromHtml(`<div data-fps="24"></div>`), undefined);
});

test("videoWindows returns start/end pairs, or null when any is unknown", () => {
  assert.deepEqual(videoWindows([{ start: 1, end: 4 }, { start: 5, end: 6.5 }]), [[1, 4], [5, 6.5]]);
  assert.deepEqual(videoWindows([]), []);
  assert.equal(videoWindows([{ start: 1 }]), null);
  assert.equal(videoWindows([{ start: 1, end: Infinity }]), null);
});

test("isCodeVideoHtml recognizes compositions that import the code-video runtime", () => {
  assert.equal(isCodeVideoHtml(`<script type="importmap">{"imports":{"three":"/@skill/node_modules/three/build/three.module.js"}}</script>`), true);
  assert.equal(isCodeVideoHtml(`<script type="module">import { defineComposition } from '/@skill/runtime/comp.js';</script>`), true);
  assert.equal(isCodeVideoHtml(`<div id="root" data-composition-id="main"></div>`), false);
});

test("findCodeVideoSkill prefers CODE_VIDEO_SKILL_DIR and requires the runtime", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-skill-"));
  try {
    assert.equal(findCodeVideoSkill({ CODE_VIDEO_SKILL_DIR: dir }, "/nonexistent"), null, "a directory without runtime/comp.js is not a skill");
    await mkdir(path.join(dir, "runtime"));
    await writeFile(path.join(dir, "runtime", "comp.js"), "");
    assert.equal(findCodeVideoSkill({ CODE_VIDEO_SKILL_DIR: dir }, "/nonexistent"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("localFileForUrl maps served URLs back to files in the root or a mount", () => {
  const origin = "http://127.0.0.1:5000";
  assert.equal(localFileForUrl(`${origin}/audio/song%20one.wav`, origin, "/proj"), path.join("/proj", "audio", "song one.wav"));
  assert.equal(localFileForUrl(`${origin}/@skill/runtime/comp.js`, origin, "/proj", { "/@skill/": "/skill" }), path.join("/skill", "runtime", "comp.js"));
  assert.equal(localFileForUrl("https://cdn.example.com/a.wav", origin, "/proj"), null);
  assert.equal(localFileForUrl(`${origin}/../etc/passwd`, origin, "/proj"), path.join("/proj", "etc", "passwd"), "never escapes the root");
});
