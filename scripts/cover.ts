// Screenshot the last frame of docs/assets/cover.html as docs/assets/cover.png (2560x1280).
//
//   node scripts/cover.ts
import path from "node:path";
import { findChrome, launchChrome } from "../src/chrome.ts";

const assets = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "docs", "assets");
const chrome = findChrome();
if (!chrome) throw new Error("Chrome not found. Run: framevelo browser install");
const browser = await launchChrome(chrome);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
  await page.goto(`file://${path.join(assets, "cover.html")}`, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const fv = (window as unknown as { __framevelo: { duration: number; seek(t: number): void } }).__framevelo;
    fv.seek(fv.duration);
  });
  const output = path.join(assets, "cover.png");
  await page.screenshot({ path: output as `${string}.png`, clip: { x: 0, y: 0, width: 1280, height: 640 } });
  process.stdout.write(`${output}\n`);
} finally {
  await browser.close();
}
