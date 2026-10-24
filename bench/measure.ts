// Measurement helpers shared by the benchmark scripts: process-tree sampling, PSNR, stream info.
import { execFileSync, spawn } from "node:child_process";

export interface Measured {
  ok: boolean;
  wallS: number;
  /** CPU time of the whole process tree, user plus system. */
  cpuS: number;
  /** Peak of the summed resident memory of the process tree. */
  peakMb: number;
  /** The last 8 kB of stdout and stderr together. */
  log: string;
  stdout: string;
}

/** Run a command and sample its whole process tree every 200 ms: wall time, summed CPU, peak summed RSS. */
export function measure(cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<Measured> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env, cwd: options.cwd });
    let log = "";
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      log = (log + d.toString()).slice(-8000);
    });
    child.stderr.on("data", (d: Buffer) => (log = (log + d.toString()).slice(-8000)));
    const cpuSeen = new Map<number, number>();
    let peak = 0;
    const parseCpu = (s: string) => s.split(":").map(Number).reduce((acc, part) => acc * 60 + part, 0);
    const sample = () => {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,time="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .map(([pid, ppid, rss, time]) => ({ pid: Number(pid), ppid: Number(ppid), rss: Number(rss), cpu: parseCpu(time ?? "0") }));
      const children = new Map<number, typeof rows>();
      for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
      const stack = rows.filter((row) => row.pid === child.pid);
      let rss = 0;
      while (stack.length) {
        const row = stack.pop()!;
        rss += row.rss;
        cpuSeen.set(row.pid, Math.max(cpuSeen.get(row.pid) ?? 0, row.cpu));
        stack.push(...(children.get(row.pid) ?? []));
      }
      peak = Math.max(peak, rss);
    };
    const timer = setInterval(sample, 200);
    child.on("close", (code) => {
      clearInterval(timer);
      const cpu = [...cpuSeen.values()].reduce((a, b) => a + b, 0);
      resolve({ ok: code === 0, wallS: (performance.now() - started) / 1000, cpuS: cpu, peakMb: Math.round(peak / 1024), log, stdout });
    });
  });
}

export interface Psnr {
  average: number;
  min: number;
  frames: number;
}

/** Per-frame PSNR of `a` against `b`, frames paired by index; identical frames count as 100 dB. */
export function framePsnr(a: string, b: string): Psnr | null {
  try {
    const out = execFileSync(
      "ffmpeg",
      ["-hide_banner", "-i", a, "-i", b, "-lavfi", "[0:v]settb=1/30,setpts=N[x];[1:v]settb=1/30,setpts=N[y];[x][y]psnr=stats_file=-", "-f", "null", "-"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 },
    );
    const values = [...out.matchAll(/psnr_avg:(\S+)/g)].map((m) => (m[1] === "inf" ? 100 : Number(m[1])));
    if (!values.length) return null;
    return { average: values.reduce((x, y) => x + y, 0) / values.length, min: Math.min(...values), frames: values.length };
  } catch {
    return null;
  }
}

/** Video packet count and audio presence of a file. */
export function streams(file: string): { frames: number; audio: boolean } {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets", "-of", "csv=p=0", file], {
    encoding: "utf8",
  });
  let frames = 0;
  let audio = false;
  for (const line of out.trim().split("\n")) {
    const [type, packets] = line.split(",");
    if (type === "video") frames = Number(packets);
    if (type === "audio") audio = true;
  }
  return { frames, audio };
}

export const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** The median run by wall time (runs are whole measurements, so CPU and memory stay paired with it). */
export function medianRun<T extends { wallS: number }>(runs: T[]): T {
  const sorted = [...runs].sort((x, y) => x.wallS - y.wallS);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}
