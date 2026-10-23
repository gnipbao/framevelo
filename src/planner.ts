// Per-interval capture planning: split the frame range at composition boundaries, verify a few
// frames of each interval against a native screenshot, and route every interval to the fast
// drawElementImage path or to screenshot capture before encoding starts. A route never changes
// because of a runtime failure; it is decided here, once.

export type CaptureRoute = "dom" | "screenshot";

export interface Interval {
  /** First frame (absolute index on the composition timeline). */
  start: number;
  /** One past the last frame. */
  end: number;
}

export interface IntervalPlan extends Interval {
  route: CaptureRoute;
  /** Verification PSNR (dB) of each sampled frame, when sampled. */
  samples: Array<{ frame: number; psnr: number }>;
  reason: string;
}

/**
 * Split [startFrame, startFrame + frames) at the given boundaries (seconds, e.g. clip starts and
 * ends) and then into pieces of at most `maxSeconds`.
 */
export function buildIntervals(startFrame: number, frames: number, fps: number, boundaries: number[], maxSeconds = 2): Interval[] {
  const end = startFrame + frames;
  if (frames <= 0) return [];
  const cuts = new Set<number>([startFrame, end]);
  for (const seconds of boundaries) {
    const frame = Math.round(seconds * fps);
    if (frame > startFrame && frame < end) cuts.add(frame);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const maxFrames = Math.max(1, Math.round(maxSeconds * fps));
  const intervals: Interval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    const pieces = Math.ceil((b - a) / maxFrames);
    for (let p = 0; p < pieces; p++) {
      const s = a + Math.round(((b - a) * p) / pieces);
      const e = a + Math.round(((b - a) * (p + 1)) / pieces);
      if (e > s) intervals.push({ start: s, end: e });
    }
  }
  return intervals;
}

/** Frames to verify in an interval: its first frame and its middle frame. */
export function sampleFrames(interval: Interval): number[] {
  const middle = interval.start + Math.floor((interval.end - interval.start) / 2);
  return middle === interval.start ? [interval.start] : [interval.start, middle];
}

/**
 * Route each interval from its verification samples: below `thresholdDb` anywhere in the interval
 * sends the whole interval to screenshot capture.
 */
export function routeIntervals(
  intervals: Interval[],
  psnrByFrame: Map<number, number>,
  thresholdDb: number,
): IntervalPlan[] {
  return intervals.map((interval) => {
    const samples = sampleFrames(interval)
      .filter((frame) => psnrByFrame.has(frame))
      .map((frame) => ({ frame, psnr: psnrByFrame.get(frame)! }));
    const worst = samples.reduce((min, s) => Math.min(min, s.psnr), Infinity);
    if (worst < thresholdDb) {
      return { ...interval, route: "screenshot", samples, reason: `verification ${worst.toFixed(1)} dB < ${thresholdDb} dB` };
    }
    return { ...interval, route: "dom", samples, reason: samples.length ? `verified ≥ ${thresholdDb} dB` : "not sampled" };
  });
}

/** Merge neighbouring intervals that share a route. */
export function mergeRoutes(plans: Array<Interval & { route: CaptureRoute }>): Array<Interval & { route: CaptureRoute }> {
  const merged: Array<Interval & { route: CaptureRoute }> = [];
  for (const plan of plans) {
    const tail = merged.at(-1);
    if (tail && tail.route === plan.route && tail.end === plan.start) tail.end = plan.end;
    else merged.push({ start: plan.start, end: plan.end, route: plan.route });
  }
  return merged;
}

/** PSNR (dB) of two RGBA buffers over their RGB channels; 100 for identical buffers. */
export function psnrRgba(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array): number {
  if (a.length !== b.length || a.length % 4 !== 0) throw new Error("PSNR needs two RGBA buffers of the same size.");
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = a[i]! - b[i]!;
    const dg = a[i + 1]! - b[i + 1]!;
    const db = a[i + 2]! - b[i + 2]!;
    sum += dr * dr + dg * dg + db * db;
  }
  const mse = sum / ((a.length / 4) * 3);
  return mse === 0 ? 100 : 10 * Math.log10((255 * 255) / mse);
}
