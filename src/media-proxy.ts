// All-intra proxies for videos a plain page puts on the composition clock. Seeking a long-GOP file
// decodes from the previous keyframe every frame; a proxy where every frame is a keyframe makes each
// seek one decode. Proxies are encoded once on the hardware encoder, keep the source timestamps, and
// are cached by source path, size and modification time.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { framevelCacheDir } from "./chrome.ts";

const execFileAsync = promisify(execFile);

export interface ProxyResult {
  source: string;
  /** The proxy, or null when the source is already all-intra or cannot be proxied. */
  proxy: string | null;
  reason: string;
}

/** Packets and keyframes of the first video stream, read from packet headers only (no decoding). */
export async function keyframeRatio(file: string, ffprobePath = "ffprobe"): Promise<{ packets: number; keyframes: number; pixFmt: string }> {
  const probe = (entries: string) =>
    execFileAsync(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", file], {
      maxBuffer: 256 << 20,
    }).then(({ stdout }) => stdout.split("\n").map((line) => line.trim()).filter(Boolean));
  const [flags, [pixFmt = ""]] = await Promise.all([probe("packet=flags"), probe("stream=pix_fmt")]);
  // One line of flags per packet, such as "K__" for a keyframe or "___".
  return { packets: flags.length, keyframes: flags.filter((f) => f.startsWith("K")).length, pixFmt };
}

export function proxyPath(source: string, size: number, mtimeMs: number, cacheDir = path.join(framevelCacheDir(), "proxies")): string {
  const key = createHash("sha1").update(`${path.resolve(source)}\0${size}\0${Math.floor(mtimeMs)}`).digest("hex").slice(0, 20);
  return path.join(cacheDir, `${key}.mp4`);
}

/** FFmpeg arguments for an all-intra H.264 proxy that keeps every source timestamp. */
export function proxyArgs(source: string, output: string, encoder: "videotoolbox" | "x264"): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-an",
    "-fps_mode",
    "passthrough",
    ...(encoder === "videotoolbox"
      ? ["-c:v", "h264_videotoolbox", "-q:v", "80", "-g", "1", "-pix_fmt", "nv12"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-g", "1", "-keyint_min", "1", "-pix_fmt", "yuv420p"]),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

let encoderCache: Promise<"videotoolbox" | "x264"> | undefined;
function proxyEncoder(ffmpegPath: string): Promise<"videotoolbox" | "x264"> {
  encoderCache ??= execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], { maxBuffer: 8 << 20 })
    .then(({ stdout }) => (process.platform === "darwin" && /\sh264_videotoolbox\s/.test(stdout) ? ("videotoolbox" as const) : ("x264" as const)))
    .catch(() => "x264" as const);
  return encoderCache;
}

/**
 * Return an all-intra proxy for `source` (building it if needed), or null with a reason when the
 * source can be seeked as is or should not be proxied.
 */
export async function ensureProxy(
  source: string,
  options: { ffmpegPath?: string; ffprobePath?: string; cacheDir?: string } = {},
): Promise<ProxyResult> {
  const info = await stat(source);
  const { packets, keyframes, pixFmt } = await keyframeRatio(source, options.ffprobePath);
  if (packets === 0) return { source, proxy: null, reason: "no video stream" };
  if (keyframes === packets) return { source, proxy: null, reason: "already all-intra" };
  if (/(10|12|16)(le|be)$/.test(pixFmt)) return { source, proxy: null, reason: `high bit depth (${pixFmt}) kept as is` };
  const output = proxyPath(source, info.size, info.mtimeMs, options.cacheDir);
  if (existsSync(output)) return { source, proxy: output, reason: "cached" };
  await mkdir(path.dirname(output), { recursive: true });
  const partial = `${output}.${process.pid}.partial.mp4`;
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";
  try {
    await execFileAsync(ffmpeg, proxyArgs(source, partial, await proxyEncoder(ffmpeg)), { maxBuffer: 8 << 20 });
    await rename(partial, output);
  } finally {
    await rm(partial, { force: true });
  }
  return { source, proxy: output, reason: `built (${keyframes}/${packets} keyframes)` };
}
