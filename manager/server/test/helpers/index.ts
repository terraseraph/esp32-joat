import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { start, type RunningServer, type StartOptions } from "../../src/app";

const tmpDirs: string[] = [];
process.on("exit", () => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Fresh temp data dir, removed when the test process exits. NEVER use the real data dir in tests. */
export function tmpDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dem-test-"));
  tmpDirs.push(dir);
  return dir;
}

export interface TestServer extends RunningServer {
  /** `http://127.0.0.1:<port>` (no trailing slash). */
  base: string;
  dataDir: string;
}

/** Start the real server on an ephemeral loopback port. Call `after(() => srv.close())` in the test file. */
export async function startTestServer(opts: Partial<StartOptions> = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? tmpDataDir();
  const server = await start({ port: 0, host: "127.0.0.1", lan: false, dataDir, ...opts });
  return { ...server, base: `http://127.0.0.1:${server.port}`, dataDir };
}

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** fetch + parse JSON (body is `undefined` when the response has none). Does not follow redirects. */
export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}): Promise<JsonResponse<T>> {
  const res = await fetch(url, { redirect: "manual", ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as T };
}

/**
 * Raw HTTP request, for when a test must control the Host header (pass it in `headers`).
 */
export function rawRequest(
  base: string,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: opts.method ?? "GET", path: opts.path ?? "/", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}
