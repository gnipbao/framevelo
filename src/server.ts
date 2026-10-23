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
 * Serve `root` on 127.0.0.1 so the page runs in a secure context (WebCodecs requires one) and can
 * load its relative assets. Only GET/HEAD, only files inside `root`.
 */
export async function serveDirectory(root: string): Promise<StaticServer> {
  const absoluteRoot = path.resolve(root);
  const server: Server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    let filePath = resolveInsideRoot(absoluteRoot, pathname);
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
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
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
