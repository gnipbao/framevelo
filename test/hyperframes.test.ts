import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contiguousRuns, isHyperFramesHtml, planFps, readPlanVideos, withConsoleRoutedTo } from "../src/hyperframes.ts";

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

test("readPlanVideos keys extracted frames by their file numbers and keeps deferred windows apart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-plan-test-"));
  try {
    assert.equal(readPlanVideos(dir), null, "no meta means no videos");
    await mkdir(path.join(dir, "meta"));
    await mkdir(path.join(dir, "video-frames", "clip"), { recursive: true });
    for (const name of ["frame_00010.jpg", "frame_00002.jpg", "frame_00001.jpg", "notes.txt"]) {
      await writeFile(path.join(dir, "video-frames", "clip", name), "");
    }
    const clip = { id: "clip", src: "a.mp4", start: 1, end: 4 };
    const long = { id: "long", src: "b.mp4", start: 0, end: 15 };
    const deferredRange = { sourcePath: "compiled/b.mp4", startTime: 0, durationSeconds: 15, format: "jpg" };
    await writeFile(
      path.join(dir, "meta", "videos.json"),
      JSON.stringify({
        videos: [clip, long],
        extracted: [
          { videoId: "clip", srcPath: "compiled/a.mp4", framePattern: "frame_%05d.jpg", fps: 30, totalFrames: 10, metadata: {} },
          { videoId: "long", srcPath: "compiled/b.mp4", framePattern: "frame_%05d.jpg", fps: 30, totalFrames: 450, metadata: {}, deferredRange },
        ],
      }),
    );
    const result = readPlanVideos(dir)!;
    assert.deepEqual(result.videos, [clip, long]);
    const [extracted] = result.extracted;
    assert.deepEqual([...extracted!.framePaths.keys()], [0, 1, 9], "frame_00010 is frame index 9");
    assert.deepEqual([...extracted!.framePaths.values()].map((p) => path.basename(p)), ["frame_00001.jpg", "frame_00002.jpg", "frame_00010.jpg"]);
    assert.equal(extracted!.ownedByLookup, false);
    assert.equal(result.deferred.length, 1);
    assert.deepEqual(result.deferred[0]!.deferredRange, deferredRange);
    assert.equal(result.deferred[0]!.framePaths.size, 0, "deferred frames are extracted by the render");
    assert.equal(result.deferred[0]!.outputDir, path.join(dir, "video-frames", "long"));

    await writeFile(path.join(dir, "meta", "videos.json"), JSON.stringify({ videos: [], extracted: [] }));
    assert.equal(readPlanVideos(dir), null, "a plan without extracted videos needs no injector");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("contiguousRuns groups consecutive frame indexes and bridges short gaps", () => {
  assert.deepEqual(contiguousRuns([]), []);
  assert.deepEqual(contiguousRuns([0, 1, 2, 5, 7, 8]), [
    { firstFrame: 0, frames: 3 },
    { firstFrame: 5, frames: 1 },
    { firstFrame: 7, frames: 2 },
  ]);
  assert.deepEqual(contiguousRuns([0, 4, 8, 40, 41], 30), [
    { firstFrame: 0, frames: 9 },
    { firstFrame: 40, frames: 2 },
  ], "gaps up to maxGap frames join one run");
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

