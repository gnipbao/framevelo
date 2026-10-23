import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { Codec } from "./options.ts";

const execFileAsync = promisify(execFile);

export interface MuxArgsOptions {
  codec: Codec;
  fps: number;
  output: string;
  audio?: string;
  /** Seconds to skip at the start of the audio, to stay in sync with a render that starts late. */
  audioOffset?: number;
  /** FFmpeg audio encoder, or "copy" for an audio track that is already AAC. */
  audioEncoder?: string;
  /**
   * Length of the video in seconds. Longer audio is cut to it; shorter audio simply ends early.
   * (-shortest would instead drop trailing video frames when the audio is a hair shorter.)
   */
  videoSeconds?: number;
  audioBitrate?: string;
}

/** Time base of one frame as an FFmpeg rational: "1/30", or "1001/30000" for 29.97 fps. */
export function frameTimeBase(fps: number): string {
  if (Number.isInteger(fps) && fps > 0) return `1/${fps}`;
  const ntsc = Math.round((fps * 1001) / 1000);
  if (Math.abs((ntsc * 1000) / 1001 - fps) < 1e-3) return `1001/${ntsc * 1000}`;
  throw new Error(`Unsupported frame rate ${fps}; use an integer or an NTSC rate such as 29.97.`);
}

/**
 * FFmpeg arguments that read the encoder's Annex-B stream from stdin and copy it into an MP4
 * without decoding or re-encoding.
 *
 * Bitstream filters: `*_metadata` rewrites the VUI to BT.709 SDR (Chrome tags canvas frames with
 * the sRGB transfer, which video players and editors do not expect), and `setts` gives frame N the
 * timestamp N. Raw Annex-B carries no timestamps; without them `-shortest` drops the audio track.
 * Frame-index timestamps are exact because the encoder emits I and P frames only, in order.
 */
export function buildMuxArgs(options: MuxArgsOptions): string[] {
  const { codec, fps, output, audio } = options;
  const metadataFilter = `${codec === "hevc" ? "hevc" : "h264"}_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1`;
  const timestampFilter = `setts=ts=N:duration=1:time_base=${frameTimeBase(fps)}`;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    codec === "hevc" ? "hevc" : "h264",
    "-i",
    "pipe:0",
    // Seek and length apply to the audio input only: an output -t counts from the earliest stream
    // start, so an audio track with encoder priming (negative start) would cut video frames.
    ...(audio && options.audioOffset ? ["-ss", String(options.audioOffset)] : []),
    ...(audio && options.videoSeconds ? ["-t", options.videoSeconds.toFixed(6)] : []),
    ...(audio ? ["-i", audio] : []),
    "-map",
    "0:v:0",
    ...(audio ? ["-map", "1:a:0"] : []),
    "-c:v",
    "copy",
    "-bsf:v",
    `${metadataFilter},${timestampFilter}`,
    ...(codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    ...(audio
      ? options.audioEncoder === "copy"
        ? ["-c:a", "copy"]
        : ["-c:a", options.audioEncoder ?? "aac", "-b:a", options.audioBitrate ?? "192k"]
      : []),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

let aacEncoderCache: Promise<string> | undefined;

/** Prefer Apple's AudioToolbox AAC encoder when FFmpeg was built with it. */
export function detectAacEncoder(ffmpegPath = "ffmpeg"): Promise<string> {
  aacEncoderCache ??= execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"], { maxBuffer: 8 << 20 })
    .then(({ stdout }) => (/\saac_at\s/.test(stdout) ? "aac_at" : "aac"))
    .catch(() => "aac");
  return aacEncoderCache;
}

export interface MuxProcess {
  /** Write encoded bytes, resolving once FFmpeg has room for more. */
  write(chunk: Buffer): Promise<void>;
  /** Close stdin and wait for FFmpeg to finish the file. */
  finish(): Promise<void>;
  kill(): void;
}

export function startMux(args: string[], ffmpegPath = "ffmpeg"): MuxProcess {
  const child: ChildProcessWithoutNullStreams = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(`Could not start ${ffmpegPath}: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${signal ?? code}${stderr ? `:\n${stderr.trim()}` : ""}`));
    });
  });
  // Surface an early exit through `finish`/`write` instead of an unhandled rejection.
  exited.catch(() => {});
  // A dead FFmpeg makes stdin emit EPIPE; the exit code carries the real error.
  child.stdin.on("error", () => {});

  return {
    write(chunk) {
      if (child.exitCode !== null) return exited;
      if (child.stdin.write(chunk)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        child.stdin.once("drain", resolve);
        exited.then(resolve, reject);
      });
    },
    async finish() {
      child.stdin.end();
      await exited;
    },
    kill() {
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

export interface VideoProbe {
  codec: string;
  width: number;
  height: number;
  packets: number;
  durationSeconds: number;
  colorTransfer?: string;
  audioCodec?: string;
}

/** Count packets (not the container's frame count estimate) so a truncated stream is caught. */
export async function probeVideo(file: string, ffprobePath = "ffprobe"): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_packets,color_transfer:format=duration", "-of", "json", file],
    { maxBuffer: 8 << 20 },
  );
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; nb_read_packets?: string; color_transfer?: string }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`No video stream in ${file}`);
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  return {
    codec: video.codec_name ?? "unknown",
    width: video.width ?? 0,
    height: video.height ?? 0,
    packets: Number(video.nb_read_packets ?? 0),
    durationSeconds: Number(parsed.format?.duration ?? 0),
    ...(video.color_transfer ? { colorTransfer: video.color_transfer } : {}),
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
  };
}

export async function toolVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["-version"]);
    return stdout.split("\n")[0]?.trim() ?? null;
  } catch {
    return null;
  }
}
