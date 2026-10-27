import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { keyframeRatio, proxyArgs, proxyPath } from "../src/media-proxy.ts";

const clip = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "video-page", "assets", "clip.mp4");

test("proxyPath is stable for a file version and changes with it", () => {
  const a = proxyPath("/media/a.mp4", 1000, 1700000000000.4, "/cache");
  assert.equal(a, proxyPath("/media/a.mp4", 1000, 1700000000000.9, "/cache"), "sub-millisecond mtime noise is ignored");
  assert.notEqual(a, proxyPath("/media/a.mp4", 1001, 1700000000000, "/cache"));
  assert.notEqual(a, proxyPath("/media/a.mp4", 1000, 1700000001000, "/cache"));
  assert.notEqual(a, proxyPath("/media/b.mp4", 1000, 1700000000000, "/cache"));
  assert.equal(path.dirname(a), path.normalize("/cache"));
  assert.match(path.basename(a), /^[0-9a-f]{20}\.mp4$/);
});

test("proxyArgs make every frame a keyframe and keep source timestamps", () => {
  for (const encoder of ["videotoolbox", "x264"] as const) {
    const args = proxyArgs("in.mp4", "out.mp4", encoder);
    assert.equal(args[args.indexOf("-g") + 1], "1");
    assert.equal(args[args.indexOf("-fps_mode") + 1], "passthrough");
    assert.ok(args.includes("-an"));
    assert.equal(args.at(-1), "out.mp4");
  }
  assert.equal(proxyArgs("in.mp4", "out.mp4", "videotoolbox")[proxyArgs("in.mp4", "out.mp4", "videotoolbox").indexOf("-c:v") + 1], "h264_videotoolbox");
});

test("keyframeRatio counts keyframe packets without decoding", async () => {
  const ratio = await keyframeRatio(clip);
  assert.deepEqual(ratio, { packets: 120, keyframes: 4, pixFmt: "yuv420p" });
});
