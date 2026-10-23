import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isHyperFramesHtml, planFps, readPlanVideos, withConsoleRoutedTo } from "../src/hyperframes.ts";

test("isHyperFramesHtml looks for a composition id", () => {
  assert.equal(isHyperFramesHtml(`<div id="root" data-composition-id="main" data-width="1920">`), true);
  assert.equal(isHyperFramesHtml(`<div id="root" data-composition-id='main'>`), true);
  assert.equal(isHyperFramesHtml(`<canvas id="scene"></canvas><script>window.__framevelo = {}</script>`), false);
});

test("planFps snaps to the rates the planner accepts", () => {
  assert.equal(planFps(30), 30);
  assert.equal(planFps(29.97), 30);
  assert.equal(planFps(23.976), 24);
  assert.equal(planFps(50), 60);
  assert.equal(planFps(12), 24);
});

test("readPlanVideos rebuilds frame paths in presentation order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-plan-test-"));
  try {
    assert.equal(readPlanVideos(dir), null, "no meta means no videos");
    await mkdir(path.join(dir, "meta"));
    await mkdir(path.join(dir, "video-frames", "clip"), { recursive: true });
    for (const name of ["frame_00010.jpg", "frame_00002.jpg", "frame_00001.jpg", "notes.txt"]) {
      await writeFile(path.join(dir, "video-frames", "clip", name), "");
    }
    const video = { id: "clip", src: "a.mp4", start: 1, end: 4 };
    await writeFile(
      path.join(dir, "meta", "videos.json"),
      JSON.stringify({
        videos: [video],
        extracted: [{ videoId: "clip", srcPath: "compiled/a.mp4", framePattern: "frame_%05d.jpg", fps: 30, totalFrames: 3, metadata: {} }],
      }),
    );
    const result = readPlanVideos(dir)!;
    assert.deepEqual(result.videos, [video]);
    const extracted = result.extracted[0] as { framePaths: Map<number, string>; ownedByLookup: boolean };
    assert.deepEqual([...extracted.framePaths.values()].map((p) => path.basename(p)), ["frame_00001.jpg", "frame_00002.jpg", "frame_00010.jpg"]);
    assert.equal(extracted.ownedByLookup, false);

    await writeFile(path.join(dir, "meta", "videos.json"), JSON.stringify({ videos: [], extracted: [] }));
    assert.equal(readPlanVideos(dir), null, "a plan without extracted videos needs no injector");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withConsoleRoutedTo forwards warnings, drops info, and restores the console", async () => {
  const messages: string[] = [];
  const original = console.error;
  const value = await withConsoleRoutedTo(
    (m) => messages.push(m),
    async () => {
      console.error("[INFO] compiled");
      console.warn("[WARN] sparse keyframes");
      console.log("progress");
      return 42;
    },
  );
  assert.equal(value, 42);
  assert.deepEqual(messages, ["hyperframes: sparse keyframes"]);
  assert.equal(console.error, original);
});

test("withConsoleRoutedTo restores the console when the call throws", async () => {
  const original = console.warn;
  await assert.rejects(withConsoleRoutedTo(() => {}, async () => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(console.warn, original);
});
