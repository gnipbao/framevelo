// Render HyperFrames projects with the official CLI and with FrameVelo on this machine, then report
// per-frame PSNR between the two, audio presence, and wall time / CPU / peak memory of each.
//
//   node scripts/parity.ts <project-dir>... [--resolution 4k] [--out dir] [--hyperframes 0.8.186] [--json]
//
// A project dir is a HyperFrames project (index.html) or a regression fixture (src/index.html).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

interface Measured {
  ok: boolean;
  wallS: number;
  cpuS: number;
  peakMb: number;
  log: string;
}

/** Run a command and sample its whole process tree: wall time, summed CPU, peak summed RSS. */
function measure(cmd: string, args: string[]): Promise<Measured> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d: Buffer) => (log = (log + d.toString()).slice(-4000)));
    child.stderr.on("data", (d: Buffer) => (log = (log + d.toString()).slice(-4000)));
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
      resolve({ ok: code === 0, wallS: (performance.now() - started) / 1000, cpuS: cpu, peakMb: Math.round(peak / 1024), log });
    });
  });
}

interface Psnr {
  average: number;
  min: number;
  frames: number;
}

/** Per-frame PSNR of `a` against `b`, frames paired by index. */
function framePsnr(a: string, b: string): Psnr | null {
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

function streams(file: string): { frames: number; audio: boolean } {
  const out = execFileSync("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets", "-of", "csv=p=0", file], { encoding: "utf8" });
  let frames = 0;
  let audio = false;
  for (const line of out.trim().split("\n")) {
    const [type, packets] = line.split(",");
    if (type === "video") frames = Number(packets);
    if (type === "audio") audio = true;
  }
  return { frames, audio };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    resolution: { type: "string" },
    out: { type: "string", default: "out/parity" },
    hyperframes: { type: "string", default: "0.8.186" },
    json: { type: "boolean" },
  },
});
if (!positionals.length) {
  console.error("usage: node scripts/parity.ts <project-dir>... [--resolution 4k] [--out dir] [--hyperframes version] [--json]");
  process.exit(2);
}
const outDir = path.resolve(values.out!);
mkdirSync(outDir, { recursive: true });
const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "cli.ts");
const scale = values.resolution === "4k" ? ["--scale", "2"] : [];
const officialResolution = values.resolution ? ["--resolution", values.resolution] : [];

const rows: Array<Record<string, unknown>> = [];
for (const dir of positionals) {
  const project = existsSync(path.join(dir, "src", "index.html")) ? path.join(dir, "src") : dir;
  const name = path.basename(dir.replace(/\/$/, ""));
  const official = path.join(outDir, `${name}.official.mp4`);
  const ours = path.join(outDir, `${name}.framevelo.mp4`);
  process.stderr.write(`${name}: official... `);
  const a = await measure("npx", ["-y", `hyperframes@${values.hyperframes}`, "render", project, "-o", official, "--quiet", ...officialResolution]);
  process.stderr.write(`${a.ok ? `${a.wallS.toFixed(1)} s` : "FAILED"}; framevelo... `);
  const b = await measure("node", ["--disable-warning=ExperimentalWarning", cli, "render", project, "-o", ours, "-q", ...scale]);
  process.stderr.write(`${b.ok ? `${b.wallS.toFixed(1)} s` : "FAILED"}\n`);
  const row: Record<string, unknown> = { name, officialOk: a.ok, framevelOk: b.ok };
  if (!b.ok) row.error = b.log.trim().split("\n").slice(-3).join(" | ");
  if (a.ok && b.ok) {
    const sa = streams(official);
    const sb = streams(ours);
    const psnr = framePsnr(ours, official);
    Object.assign(row, {
      frames: `${sb.frames}/${sa.frames}`,
      audio: `${sb.audio ? "yes" : "no"}/${sa.audio ? "yes" : "no"}`,
      psnrAvg: psnr ? Number(psnr.average.toFixed(1)) : null,
      psnrMin: psnr ? Number(psnr.min.toFixed(1)) : null,
    });
  }
  Object.assign(row, {
    officialWall: Number(a.wallS.toFixed(2)),
    framevelWall: Number(b.wallS.toFixed(2)),
    officialCpu: Number(a.cpuS.toFixed(1)),
    framevelCpu: Number(b.cpuS.toFixed(1)),
    officialMb: a.peakMb,
    framevelMb: b.peakMb,
  });
  rows.push(row);
}

if (values.json) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
} else {
  const header = "| Project | Frames (FV/HF) | Audio | PSNR avg | PSNR min | Wall HF → FV | CPU HF → FV | Memory HF → FV |";
  console.log(header);
  console.log("|---|---|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    if (!r.officialOk || !r.framevelOk) {
      console.log(`| ${r.name} | ${r.officialOk ? "" : "official failed "}${r.framevelOk ? "" : `FrameVelo failed: ${String(r.error ?? "")}`} | | | | | | |`);
      continue;
    }
    console.log(
      `| ${r.name} | ${r.frames} | ${r.audio} | ${r.psnrAvg} | ${r.psnrMin} | ${r.officialWall} s → ${r.framevelWall} s | ${r.officialCpu} s → ${r.framevelCpu} s | ${r.officialMb} → ${r.framevelMb} MB |`,
    );
  }
}
