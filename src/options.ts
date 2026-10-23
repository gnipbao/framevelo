// Pure helpers for turning user-facing render options into encoder and timing parameters.

export type Codec = "h264" | "hevc";

/** Parse "12M", "800k", "12000000" or "1.5m" into bits per second. */
export function parseBitrate(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kKmMgG]?)\s*$/.exec(value);
  if (!match) throw new Error(`Invalid bitrate "${value}". Use a number of bits per second, or a k/M/G suffix such as 12M.`);
  const scale = { "": 1, k: 1e3, m: 1e6, g: 1e9 }[match[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  const bits = Math.round(Number(match[1]) * scale);
  if (bits <= 0) throw new Error(`Bitrate must be positive, got "${value}".`);
  return bits;
}

/**
 * Default target bitrate. VideoToolbox needs roughly 1.2x the bitrate of x264 CRF 18 for the same
 * quality on motion graphics; 0.2 bits per pixel per frame for H.264 lands at about 12 Mbps for
 * 1080p30 and 50 Mbps for 4K30. HEVC gets about two thirds of that.
 */
export function defaultBitrate(width: number, height: number, fps: number, codec: Codec): number {
  const bitsPerPixel = codec === "hevc" ? 0.13 : 0.2;
  const bits = width * height * fps * bitsPerPixel;
  return Math.round(Math.min(Math.max(bits, 1e6), 150e6) / 1e5) * 1e5;
}

/** Number of output frames for a duration, treating the duration as whole frame intervals. */
export function frameCount(durationSeconds: number, fps: number): number {
  if (!(durationSeconds > 0)) throw new Error(`Duration must be positive, got ${durationSeconds}.`);
  if (!(fps > 0)) throw new Error(`fps must be positive, got ${fps}.`);
  // The epsilon keeps 10 s at 30 fps at 300 frames despite floating-point noise.
  return Math.max(1, Math.ceil(durationSeconds * fps - 1e-6));
}

/**
 * Time offsets (seconds, relative to the frame time) of the sub-frames averaged into one output
 * frame for motion blur. Samples are centered on the frame time and spread over `shutter` of the
 * frame interval, so a 180-degree shutter is 0.5.
 */
export function subframeOffsets(subframes: number, shutter: number, fps: number): number[] {
  if (!Number.isInteger(subframes) || subframes < 1) throw new Error(`subframes must be a positive integer, got ${subframes}.`);
  if (!(shutter >= 0 && shutter <= 1)) throw new Error(`shutter must be between 0 and 1, got ${shutter}.`);
  if (subframes === 1) return [0];
  return Array.from({ length: subframes }, (_, k) => ((k + 0.5) / subframes - 0.5) * (shutter / fps));
}

/** 4:2:0 encoders need even dimensions. */
export function evenDimension(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

/** WebCodecs codec string with a level high enough for the frame size and rate. */
export function codecString(codec: Codec, width: number, height: number, fps: number): string {
  const lumaSamplesPerSecond = width * height * fps;
  const above4k30 = lumaSamplesPerSecond > 3840 * 2160 * 30;
  if (codec === "hevc") return above4k30 ? "hvc1.1.6.L156.B0" : "hvc1.1.6.L153.B0";
  // High profile, level 5.1 (up to 4K30) or 5.2 (up to 4K60).
  return above4k30 ? "avc1.640034" : "avc1.640033";
}

/** Keyframe every two seconds keeps seeking in players cheap without hurting compression much. */
export function keyframeInterval(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}
