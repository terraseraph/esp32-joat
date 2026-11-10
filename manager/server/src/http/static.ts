import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const NOT_BUILT_HTML = `<!doctype html><meta charset="utf-8"><title>de-esp32 Manager</title>
<body style="font:16px system-ui;max-width:36em;margin:4em auto;padding:0 1em">
<h1>Web app not built</h1>
<p>The server is running, but there is no web app to serve yet.
Run <code>npm run build</code> in <code>manager/</code>, or use <code>npm run dev</code> and open the Vite URL (http://localhost:5173).</p>
<p>The API is available at <a href="/api/health">/api/health</a>.</p></body>`;

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  type: string,
  cache: string,
  file?: { path: string; size: number },
  text?: string,
): void {
  const headers: Record<string, string | number> = {
    "Content-Type": type,
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (file) headers["Content-Length"] = file.size;
  if (text !== undefined) headers["Content-Length"] = Buffer.byteLength(text);
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
  } else if (file) {
    createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
  } else {
    res.end(text);
  }
}

function fileIn(root: string, urlPath: string): { path: string; size: number } | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const abs = path.resolve(root, "." + path.posix.normalize("/" + rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const st = statSync(abs);
    return st.isFile() ? { path: abs, size: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * Serve the SPA from `publicDir`: real files, else (for GET/HEAD paths without an
 * extension) index.html so client-side routes work on reload.
 */
export function serveStatic(publicDir: string | undefined, req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }
  const root = publicDir ? path.resolve(publicDir) : undefined;
  const index = root ? fileIn(root, "/index.html") : null;
  if (!root || !index) {
    send(req, res, 503, "text/html; charset=utf-8", "no-store", undefined, NOT_BUILT_HTML);
    return;
  }

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const target = pathname === "/" ? null : fileIn(root, pathname);
  if (target) {
    const ext = path.extname(target.path).toLowerCase();
    const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : ext === ".html" ? "no-cache" : "public, max-age=3600";
    send(req, res, 200, TYPES[ext] ?? "application/octet-stream", cache, target);
    return;
  }
  if (pathname === "/" || path.extname(pathname) === "") {
    send(req, res, 200, TYPES[".html"] as string, "no-cache", index);
    return;
  }
  send(req, res, 404, "text/plain; charset=utf-8", "no-store", undefined, "Not Found");
}

/** True when `dir` contains the built SPA. */
export function hasIndex(dir: string): boolean {
  return existsSync(path.join(dir, "index.html"));
}
