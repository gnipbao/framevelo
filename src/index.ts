export { render, type RenderOptions, type RenderResult } from "./render.ts";
export { runDoctor, type DoctorCheck } from "./doctor.ts";
export { findChrome, chromeArgs, MIN_DOM_CHROME_MAJOR } from "./chrome.ts";
export { parseBitrate, defaultBitrate, frameCount, subframeOffsets, type Codec } from "./options.ts";
export type { CaptureMode, PageRenderStats } from "./page-runtime.ts";
