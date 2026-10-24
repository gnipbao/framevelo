import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultWorkers, fpsFromHtml, localFileForUrl, resolveInput, videoWindows, viewportFromHtml } from "../src/render.ts";

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

test("localFileForUrl maps served URLs back to files in the root or a mount", () => {
  const origin = "http://127.0.0.1:5000";
  assert.equal(localFileForUrl(`${origin}/audio/song%20one.wav`, origin, "/proj"), path.join("/proj", "audio", "song one.wav"));
  assert.equal(localFileForUrl(`${origin}/vendor/music/bed.m4a`, origin, "/proj", { "/vendor/": "/shared" }), path.join("/shared", "music", "bed.m4a"));
  assert.equal(localFileForUrl("https://cdn.example.com/a.wav", origin, "/proj"), null);
  assert.equal(localFileForUrl(`${origin}/../etc/passwd`, origin, "/proj"), path.join("/proj", "etc", "passwd"), "never escapes the root");
});

test("defaultWorkers scales with cores and stays between 1 and 4", () => {
  assert.equal(defaultWorkers(1), 1);
  assert.equal(defaultWorkers(4), 1);
  assert.equal(defaultWorkers(11), 3);
  assert.equal(defaultWorkers(32), 4);
});
