// Render HyperFrames projects with the official CLI and with FrameVelo on this machine, then report
// per-frame PSNR between the two, audio presence, and wall time / CPU / peak memory of each.
//
//   node bench/parity.ts <project-dir>... [--resolution 4k] [--out dir] [--hyperframes 0.8.186] [--json]
//
// A project dir is a HyperFrames project (index.html) or a regression fixture (src/index.html).
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { framePsnr, measure, streams } from "./measure.ts";

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
  console.error("usage: node bench/parity.ts <project-dir>... [--resolution 4k] [--out dir] [--hyperframes version] [--json]");
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
