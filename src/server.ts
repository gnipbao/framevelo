import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".wasm": "application/wasm",
};

export interface StaticServer {
  /** Origin such as http://127.0.0.1:53211 */
  origin: string;
  close(): Promise<void>;
}

/** Resolve a URL path inside `root`, or return null when it would escape it. */
export function resolveInsideRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved === root || resolved.startsWith(rootWithSep) ? resolved : null;
}

/**
 * Parse a single-range `Range: bytes=...` header against a file of `size` bytes. Returns null for
 * no or an unsupported header (serve the whole file) and "unsatisfiable" for a range past the end.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/**
 * Serve `root` on 127.0.0.1 so the page runs in a secure context (WebCodecs requires one) and can
 * load its relative assets. Only GET/HEAD, only files inside `root`. Byte ranges are supported:
 * Chrome needs them to seek in audio and video files.
 */
export async function serveDirectory(root: string, options: { mounts?: Record<string, string> } = {}): Promise<StaticServer> {
  const absoluteRoot = path.resolve(root);
  // Extra directories served under a URL prefix such as "/__framevelo/proxies/".
  const mounts = Object.entries(options.mounts ?? {}).map(([prefix, dir]) => [prefix.endsWith("/") ? prefix : `${prefix}/`, path.resolve(dir)] as const);
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
    let filePath = mount ? resolveInsideRoot(mount[1], `/${pathname.slice(mount[0].length)}`) : resolveInsideRoot(absoluteRoot, pathname);
    if (!filePath) {
      res.writeHead(403).end();
      return;
    }
    try {
      let info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        info = await stat(filePath);
      }
      const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
      const range = parseRange(req.headers.range, info.size);
      if (range === "unsatisfiable") {
        res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
        return;
      }
      res.writeHead(range ? 206 : 200, {
        "content-type": contentType,
        "content-length": range ? range.end - range.start + 1 : info.size,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${info.size}` } : {}),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(filePath, range ?? {})
        .on("error", () => res.destroy())
        .pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Static server did not bind to a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
