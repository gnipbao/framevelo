import { chromeMajor, findChrome, launchChrome, MIN_DOM_CHROME_MAJOR } from "./chrome.ts";
import { detectAacEncoder, toolVersion } from "./ffmpeg.ts";
import { loadHyperFrames } from "./hyperframes.ts";
import { serveDirectory } from "./server.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed optional check does not block rendering. */
  optional?: boolean;
}

interface EncoderSupport {
  label: string;
  hardware: boolean;
  any: boolean;
}

/** Probe the toolchain FrameVelo needs and report what this machine can do. */
export async function runDoctor(options: { chromePath?: string; ffmpegPath?: string; ffprobePath?: string } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  checks.push({ name: "Node.js", ok: nodeOk, detail: nodeOk ? process.version : `${process.version}; needs 22.18 or later` });

  const ffmpeg = await toolVersion(options.ffmpegPath ?? "ffmpeg");
  checks.push({ name: "FFmpeg", ok: ffmpeg !== null, detail: ffmpeg ?? "not found on PATH" });
  const ffprobe = await toolVersion(options.ffprobePath ?? "ffprobe");
  checks.push({ name: "FFprobe", ok: ffprobe !== null, detail: ffprobe ?? "not found on PATH" });
  if (ffmpeg) {
    const aac = await detectAacEncoder(options.ffmpegPath);
    checks.push({ name: "AAC encoder", ok: true, optional: true, detail: aac === "aac_at" ? "aac_at (AudioToolbox)" : "aac (FFmpeg built-in)" });
  }

  try {
    const api = await loadHyperFrames();
    checks.push({ name: "HyperFrames projects", ok: true, optional: true, detail: `@hyperframes/producer ${api.version}` });
  } catch {
    checks.push({
      name: "HyperFrames projects",
      ok: false,
      optional: true,
      detail: "@hyperframes/producer not installed; HyperFrames projects render as plain pages",
    });
  }

  let chromePath: string | null = null;
  try {
    chromePath = findChrome(options.chromePath ? { explicitPath: options.chromePath } : {});
  } catch (error) {
    checks.push({ name: "Chrome", ok: false, detail: error instanceof Error ? error.message : String(error) });
    return checks;
  }
  if (!chromePath) {
    checks.push({ name: "Chrome", ok: false, detail: "not found; install Google Chrome or set FRAMEVELO_CHROME" });
    return checks;
  }

  // WebCodecs needs a secure context, so probe from a page served on 127.0.0.1.
  const dir = await mkdtemp(path.join(os.tmpdir(), "framevelo-doctor-"));
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>doctor</title>");
  const server = await serveDirectory(dir);
  const browser = await launchChrome(chromePath);
  try {
    const version = await browser.version();
    checks.push({ name: "Chrome", ok: true, detail: `${version} (${chromePath})` });
    const page = await browser.newPage();
    await page.goto(`${server.origin}/index.html`);
    const report = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d") as (CanvasRenderingContext2D & { drawElementImage?: unknown }) | null;
      const gl = document.createElement("canvas").getContext("webgl2");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const gpu = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
      const encoders: Array<{ label: string; hardware: boolean; any: boolean }> = [];
      const cases: Array<[string, string, number, number]> = [
        ["H.264 1080p", "avc1.640033", 1920, 1080],
        ["H.264 4K", "avc1.640033", 3840, 2160],
        ["HEVC 1080p", "hvc1.1.6.L153.B0", 1920, 1080],
        ["HEVC 4K", "hvc1.1.6.L153.B0", 3840, 2160],
      ];
      for (const [label, codec, width, height] of cases) {
        const base = { codec, width, height, bitrate: 20e6, framerate: 30 };
        const hw = await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: "prefer-hardware" }).catch(() => ({ supported: false }));
        const any = await VideoEncoder.isConfigSupported(base).catch(() => ({ supported: false }));
        encoders.push({ label, hardware: hw.supported === true, any: any.supported === true });
      }
      return { drawElement: typeof ctx?.drawElementImage === "function", gpu, encoders };
    });
    const major = chromeMajor(version);
    checks.push({
      name: "DOM capture (drawElementImage)",
      ok: report.drawElement && major >= MIN_DOM_CHROME_MAJOR,
      detail: report.drawElement ? `available (Chrome ${major})` : `unavailable; needs Chrome ${MIN_DOM_CHROME_MAJOR}+`,
    });
    const softwareGpu = /swiftshader|llvmpipe|software/i.test(report.gpu);
    checks.push({ name: "GPU", ok: !softwareGpu, detail: report.gpu });
    for (const encoder of report.encoders as EncoderSupport[]) {
      checks.push({
        name: `Encoder ${encoder.label}`,
        ok: encoder.any,
        optional: !encoder.label.startsWith("H.264 1080p"),
        detail: encoder.hardware ? "hardware" : encoder.any ? "software only" : "unsupported",
      });
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
  return checks;
}
