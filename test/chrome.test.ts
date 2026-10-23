import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { chromeArgs, chromeMajor, findChrome } from "../src/chrome.ts";

const fakeFs = (files: string[], dirs: Record<string, string[]> = {}) => ({
  exists: (file: string) => files.includes(file),
  listDir: (dir: string) => dirs[dir] ?? [],
});

test("an explicit path wins and must exist", () => {
  const fs = fakeFs(["/opt/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(findChrome({ ...fs, explicitPath: "/opt/chrome", platform: "darwin", env: {} }), "/opt/chrome");
  assert.throws(() => findChrome({ ...fs, explicitPath: "/missing", platform: "darwin", env: {} }), /not found/);
});

test("FRAMEVELO_CHROME comes before installed browsers", () => {
  const fs = fakeFs(["/env/chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(findChrome({ ...fs, platform: "darwin", env: { FRAMEVELO_CHROME: "/env/chrome" } }), "/env/chrome");
});

test("finds installed Google Chrome on macOS", () => {
  const fs = fakeFs(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]);
  assert.equal(findChrome({ ...fs, platform: "darwin", env: {}, home: "/Users/me" }), "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
});

test("falls back to the newest Chrome for Testing in the Puppeteer cache", () => {
  const cache = "/Users/me/.cache/puppeteer/chrome";
  const binary = (dir: string) => path.join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  const fs = fakeFs([binary("mac_arm-126.0.6478.126"), binary("mac_arm-152.0.7977.75")], {
    [cache]: ["mac_arm-126.0.6478.126", "mac_arm-152.0.7977.75", "mac_arm-99.0.1.1"],
  });
  assert.equal(findChrome({ ...fs, platform: "darwin", env: {}, home: "/Users/me" }), binary("mac_arm-152.0.7977.75"));
});

test("returns null when nothing is installed", () => {
  assert.equal(findChrome({ ...fakeFs([]), platform: "linux", env: {}, home: "/home/me" }), null);
});

test("chromeMajor parses browser version strings", () => {
  assert.equal(chromeMajor("Chrome/155.0.8059.85"), 155);
  assert.equal(chromeMajor("HeadlessChrome/152.0.7977.30"), 152);
  assert.equal(chromeMajor("unknown"), 0);
});

test("chromeArgs enables HTML-in-Canvas and removes vsync pacing", () => {
  const args = chromeArgs("darwin");
  assert.ok(args.includes("--enable-features=CanvasDrawElement"));
  assert.ok(args.includes("--disable-gpu-vsync"));
  assert.ok(args.includes("--disable-frame-rate-limit"));
  assert.ok(args.includes("--use-angle=metal"));
  assert.ok(!chromeArgs("linux").includes("--use-angle=metal"));
});
