// Make test/fixtures/remotion renderable: install its own dependencies (Remotion stays out of
// FrameVelo's) and generate the media it plays (FFmpeg test sources, nothing checked in).
//
//   node scripts/remotion-fixture.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const remotionFixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "remotion");

/** True once the fixture's dependencies are installed. */
export const remotionFixtureInstalled = () => existsSync(path.join(remotionFixture, "node_modules", "@remotion", "cli"));

/** Install the fixture's dependencies when needed and generate its media; returns its directory. */
export function prepareRemotionFixture(options: { install?: boolean } = {}): string {
  if (!remotionFixtureInstalled()) {
    if (options.install === false) throw new Error(`The Remotion fixture is not installed: npm ci --prefix ${path.relative(process.cwd(), remotionFixture)}`);
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-fund", "--no-audit"], { cwd: remotionFixture, stdio: "inherit", shell: process.platform === "win32" });
  }
  const pub = path.join(remotionFixture, "public");
  mkdirSync(pub, { recursive: true });
  const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  if (!existsSync(path.join(pub, "clip.mp4"))) {
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", path.join(pub, "clip.mp4")]);
  }
  if (!existsSync(path.join(pub, "tone.wav"))) {
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000", "-ac", "2", path.join(pub, "tone.wav")]);
  }
  return remotionFixture;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${prepareRemotionFixture()}\n`);
}
