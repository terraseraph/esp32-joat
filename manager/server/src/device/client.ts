import http from "node:http";
import type { Readable } from "node:stream";
import type { DeviceEnvelope, DeviceStatus } from "../types/device-api";
import { SerialQueue } from "./queue";
import { splitStoredHost } from "./hostAddr";

/**
 * Typed HTTP client for ONE device's `/api/v1` (spec 2.1 and 3.5).
 *
 *  - every call goes through a per-device FIFO queue with concurrency 1 (the device's httpd is single-threaded)
 *  - keep-alive agent with one socket, per-call timeouts, optional local bind address (`localAddress`, needed for
 *    talking to a SoftAP through one specific Wi-Fi adapter)
 *  - redirects are never followed: a 3xx is a `captive_redirect` error carrying `Location`
 *  - JSON bodies above 1536 bytes are refused locally and never sent
 *  - reboot-type calls turn a socket reset/timeout into `{v:1, ok:true, result:{expectedRestart:true}}`
 */

export type DeviceErrorKind =
  | "timeout"
  | "refused"
  | "reset"
  | "unreachable"
  | "captive_redirect"
  | "bad_response"
  | "http_status"
  /** Added: the request body exceeds the device's 1536 byte limit; nothing was sent. */
  | "body_too_large";

export class DeviceError extends Error {
  readonly kind: DeviceErrorKind;
  readonly status?: number;
  /** `Location` header of a captive_redirect. */
  readonly location?: string;
  constructor(kind: DeviceErrorKind, message: string, extra: { status?: number; location?: string; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "DeviceError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.location !== undefined) this.location = extra.location;
  }
}

/** True for failures where the device did not (or could not) answer, as opposed to answering something odd. */
export function isTransportKind(kind: DeviceErrorKind): boolean {
  return kind !== "http_status" && kind !== "body_too_large";
}

export const MAX_DEVICE_BODY = 1536;
export const DEFAULT_TIMEOUT_MS = 5000;
export const PROBE_TIMEOUT_MS = 2000;
export const WIFI_TIMEOUT_MS = 25_000;
export const SCAN_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const RESTART_COMMANDS = new Set(["system.reboot", "system.factory_reset", "ota.rollback"]);
const RESTART_PATHS = new Set(["/system/reboot", "/system/factory_reset"]);

function relPath(rel: string): string {
  const q = rel.indexOf("?");
  const p = q >= 0 ? rel.slice(0, q) : rel;
  const norm = p.replace(/\/+$/, "");
  return norm.startsWith("/") ? norm : `/${norm}`;
}

/**
 * The device command a request amounts to: the `cmd` of `POST /command` (and of `/pins` when it carries one),
 * or the command implied by the route (`/pins` without `cmd` = `pin.configure`, `/network/wifi`, `/mqtt`,
 * `/system/reboot`, `/system/factory_reset`, `GET /network/scan`).
 */
export function commandFor(method: string, rel: string, body: unknown): string | undefined {
  const p = relPath(rel);
  const m = method.toUpperCase();
  const cmdOf = (b: unknown): string | undefined =>
    typeof b === "object" && b !== null && typeof (b as { cmd?: unknown }).cmd === "string" ? (b as { cmd: string }).cmd : undefined;
  if (m === "GET") return p === "/network/scan" ? "network.wifi.scan" : undefined;
  if (m !== "POST") return undefined;
  switch (p) {
    case "/command":
      return cmdOf(body);
    case "/pins":
      return cmdOf(body) ?? "pin.configure";
    case "/network/wifi":
      return "network.wifi.set";
    case "/mqtt":
      return "mqtt.configure";
    case "/system/reboot":
      return "system.reboot";
    case "/system/factory_reset":
      return "system.factory_reset";
    default:
      return undefined;
  }
}

export function timeoutFor(command: string | undefined, rel: string): number {
  const p = relPath(rel);
  if (command === "network.wifi.set" || p === "/network/wifi") return WIFI_TIMEOUT_MS;
  if (command === "network.wifi.scan" || p === "/network/scan") return SCAN_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

export function expectsRestart(method: string, rel: string, command: string | undefined): boolean {
  if (method.toUpperCase() !== "POST") return false;
  return RESTART_PATHS.has(relPath(rel)) || (command !== undefined && RESTART_COMMANDS.has(command));
}

export interface DeviceResponse {
  status: number;
  contentType: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  /** Parsed body when the content type is JSON and it parsed; otherwise undefined. */
  json: unknown;
  /** True when this response was synthesised because the device restarted instead of answering. */
  expectedRestart: boolean;
}

export interface CallOptions {
  /** Request body as JSON (stringified here). */
  json?: unknown;
  /** Raw request body (sent as application/json). Wins over `json`. */
  body?: Buffer | string;
  /** Default depends on the call (5 s; 25 s Wi-Fi set; 12 s scan). */
  timeoutMs?: number;
  /** Bind the outgoing connection to this local address (a specific network adapter). */
  localAddress?: string;
  /** Override restart handling (default: derived from the path/command). */
  expectRestart?: boolean;
}

export interface DeviceClient {
  /** Stored form of the address (`ip` or `ip:port`). */
  readonly host: string;
  /** Requests waiting or running. */
  readonly queueDepth: number;
  setHost(host: string): void;
  /** Raw call: resolves with any HTTP response except a redirect; throws `DeviceError` for transport problems. */
  request(method: string, rel: string, opts?: CallOptions): Promise<DeviceResponse>;
  /** GET and parse a JSON 2xx; throws `DeviceError` (http_status / bad_response) otherwise. */
  getJson<T = unknown>(rel: string, opts?: CallOptions): Promise<T>;
  postJson<T = unknown>(rel: string, body: unknown, opts?: CallOptions): Promise<T>;
  status(opts?: CallOptions): Promise<DeviceStatus>;
  /** `POST /command`; returns the device envelope (ok true or false) or the synthesised restart envelope. */
  command(body: { cmd: string; [k: string]: unknown }, opts?: CallOptions): Promise<DeviceEnvelope<unknown>>;
  /**
   * Stream a large raw body (a firmware image) with a `Content-Length`, through the same queue. Bypasses the 1536 byte JSON
   * limit. `onProgress` gets the bytes handed to the socket so far. Aborting `signal` destroys the request (`DeviceError`
   * `reset`). The timeout is idle time: it restarts whenever bytes move or the device answers.
   */
  upload(rel: string, source: Readable, length: number, opts?: UploadOptions): Promise<DeviceResponse>;
  destroy(): void;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (sent: number) => void;
  /** Max time without any progress (default 30 s). */
  idleTimeoutMs?: number;
  /** Time allowed for the device to answer after the last byte was sent (default 60 s: it checks the image first). */
  answerTimeoutMs?: number;
  localAddress?: string;
}

export interface DeviceClientOptions {
  host: string;
  /** Default local bind address for every call (per-call `localAddress` wins). */
  localAddress?: string;
  onQueueChange?: (depth: number) => void;
}

function mapNodeError(err: NodeJS.ErrnoException, host: string, localAddress: string | undefined): DeviceError {
  switch (err.code) {
    case "ECONNREFUSED":
      return new DeviceError("refused", `Connection refused by ${host}`, { cause: err });
    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
      return new DeviceError("reset", `${host} closed the connection without answering`, { cause: err });
    case "ETIMEDOUT":
      return new DeviceError("timeout", `Connecting to ${host} timed out`, { cause: err });
    case "EADDRNOTAVAIL":
      return new DeviceError("unreachable", `Cannot reach ${host}${localAddress ? ` from local address ${localAddress}` : ""} (${err.code})`, { cause: err });
    default:
      return new DeviceError("unreachable", `Cannot reach ${host} (${err.code ?? err.message})`, { cause: err });
  }
}

export function createDeviceClient(opts: DeviceClientOptions): DeviceClient {
  let host = opts.host;
  let target = splitStoredHost(host);
  let agent = newAgent();
  const queue = new SerialQueue(opts.onQueueChange);

  function newAgent(): http.Agent {
    return new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, scheduling: "fifo" });
  }

  function once(method: string, rel: string, body: Buffer | undefined, timeoutMs: number, localAddress: string | undefined): Promise<DeviceResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const headers: http.OutgoingHttpHeaders = { Accept: "application/json, */*" };
      if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = body.length;
      } else if (method === "POST") {
        headers["Content-Length"] = 0;
      }
      const req = http.request(
        {
          host: target.hostname,
          port: target.port,
          method,
          path: `/api/v1${rel.startsWith("/") ? rel : `/${rel}`}`,
          agent,
          headers,
          ...(localAddress ? { localAddress } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const location = String(res.headers.location ?? "");
            res.resume();
            finish(() =>
              reject(
                new DeviceError(
                  "captive_redirect",
                  `${host} redirected to ${location || "another address"} instead of answering (setup mode, a captive portal, or an unknown route)`,
                  { status, location },
                ),
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              finish(() => reject(new DeviceError("bad_response", `${host} sent a response larger than ${MAX_RESPONSE_BYTES} bytes`)));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on("error", (err) => finish(() => reject(mapNodeError(err as NodeJS.ErrnoException, host, localAddress))));
          res.on("aborted", () => finish(() => reject(new DeviceError("reset", `${host} dropped the connection while answering`))));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            const contentType = String(res.headers["content-type"] ?? "");
            const text = buf.toString("utf8");
            let json: unknown;
            if (/json/i.test(contentType)) {
              try {
                json = JSON.parse(text);
              } catch {
                json = undefined;
              }
            }
            finish(() => resolve({ status, contentType, headers: res.headers, body: buf, text, json, expectedRestart: false }));
          });
        },
      );
      const timer = setTimeout(() => {
        finish(() => reject(new DeviceError("timeout", `${host} did not answer within ${Math.round(timeoutMs / 100) / 10} s`)));
        req.destroy();
      }, timeoutMs);
      req.on("error", (err) => finish(() => reject(mapNodeError(err, host, localAddress))));
      req.end(body);
    });
  }

  async function execute(method: string, rel: string, body: Buffer | undefined, callOpts: CallOptions, parsedBody: unknown): Promise<DeviceResponse> {
    const command = commandFor(method, rel, parsedBody);
    const timeoutMs = callOpts.timeoutMs ?? timeoutFor(command, rel);
    const restart = callOpts.expectRestart ?? expectsRestart(method, rel, command);
    const localAddress = callOpts.localAddress ?? opts.localAddress;
    try {
      try {
        return await once(method, rel, body, timeoutMs, localAddress);
      } catch (err) {
        // A pooled keep-alive socket the device already closed: GETs are safe to repeat once.
        if (err instanceof DeviceError && err.kind === "reset" && method === "GET") return await once(method, rel, body, timeoutMs, localAddress);
        throw err;
      }
    } catch (err) {
      if (err instanceof DeviceError && (err.kind === "reset" || err.kind === "timeout" || err.kind === "unreachable")) agent.destroy();
      if (restart && err instanceof DeviceError && (err.kind === "reset" || err.kind === "timeout")) {
        const corr = typeof (parsedBody as { corr?: unknown } | undefined)?.corr === "string" ? (parsedBody as { corr: string }).corr : undefined;
        const envelope = { v: 1, ok: true, ...(corr ? { corr } : {}), result: { expectedRestart: true } };
        const text = JSON.stringify(envelope);
        return {
          status: 200,
          contentType: "application/json",
          headers: {},
          body: Buffer.from(text),
          text,
          json: envelope,
          expectedRestart: true,
        };
      }
      throw err;
    }
  }

  function request(method: string, rel: string, callOpts: CallOptions = {}): Promise<DeviceResponse> {
    let body: Buffer | undefined;
    let parsed: unknown;
    if (callOpts.body !== undefined) {
      body = typeof callOpts.body === "string" ? Buffer.from(callOpts.body, "utf8") : callOpts.body;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
    } else if (callOpts.json !== undefined) {
      body = Buffer.from(JSON.stringify(callOpts.json), "utf8");
      parsed = callOpts.json;
    }
    if (body && body.length > MAX_DEVICE_BODY) {
      return Promise.reject(
        new DeviceError("body_too_large", `The request body is ${body.length} bytes; the device accepts at most ${MAX_DEVICE_BODY} bytes of JSON, so it was not sent`),
      );
    }
    return queue.run(() => execute(method.toUpperCase(), rel, body, callOpts, parsed));
  }

  function assertOk(res: DeviceResponse): void {
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 400 && res.text.trim() === "json") {
      throw new DeviceError(
        "http_status",
        `${host} rejected the request body as invalid JSON (HTTP 400 "json"): the body must be a non-empty JSON object of at most ${MAX_DEVICE_BODY} bytes`,
        { status: 400 },
      );
    }
    throw new DeviceError("http_status", `${host} answered HTTP ${res.status}`, { status: res.status });
  }

  function jsonOf<T>(res: DeviceResponse): T {
    assertOk(res);
    if (res.json === undefined) throw new DeviceError("bad_response", `${host} did not answer with JSON`, { status: res.status });
    return res.json as T;
  }

  return {
    get host() {
      return host;
    },
    get queueDepth() {
      return queue.depth;
    },
    setHost(next) {
      if (next === host) return;
      host = next;
      target = splitStoredHost(next);
      agent.destroy();
      agent = newAgent();
    },
    request,
    upload(rel, source, length, o = {}) {
      return queue.run(
        () =>
          new Promise<DeviceResponse>((resolve, reject) => {
            const idleMs = o.idleTimeoutMs ?? 30_000;
            const answerMs = o.answerTimeoutMs ?? 60_000;
            const localAddress = o.localAddress ?? opts.localAddress;
            let settled = false;
            let sent = 0;
            let timer: NodeJS.Timeout | undefined;
            const cleanup = (): void => {
              settled = true;
              clearTimeout(timer);
              o.signal?.removeEventListener("abort", onAbort);
            };
            const fail = (err: DeviceError): void => {
              if (settled) return;
              cleanup();
              source.destroy();
              req.destroy();
              agent.destroy();
              reject(err);
            };
            const arm = (ms: number): void => {
              clearTimeout(timer);
              timer = setTimeout(() => fail(new DeviceError("timeout", `${host} stopped taking data (no progress for ${Math.round(ms / 1000)} s)`)), ms);
            };
            const onAbort = (): void => fail(new DeviceError("reset", "The upload was cancelled"));
            const req = http.request(
              {
                host: target.hostname,
                port: target.port,
                method: "POST",
                path: `/api/v1${rel.startsWith("/") ? rel : `/${rel}`}`,
                agent,
                headers: { Accept: "application/json, */*", "Content-Type": "application/octet-stream", "Content-Length": length },
                ...(localAddress ? { localAddress } : {}),
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("error", (err) => fail(mapNodeError(err as NodeJS.ErrnoException, host, localAddress)));
                res.on("aborted", () => fail(new DeviceError("reset", `${host} dropped the connection while answering`)));
                res.on("end", () => {
                  if (settled) return;
                  cleanup();
                  const buf = Buffer.concat(chunks);
                  const contentType = String(res.headers["content-type"] ?? "");
                  const text = buf.toString("utf8");
                  let json: unknown;
                  if (/json/i.test(contentType)) {
                    try {
                      json = JSON.parse(text);
                    } catch {
                      json = undefined;
                    }
                  }
                  resolve({ status: res.statusCode ?? 0, contentType, headers: res.headers, body: buf, text, json, expectedRestart: false });
                });
              },
            );
            req.on("error", (err) => fail(mapNodeError(err, host, localAddress)));
            if (o.signal?.aborted) return onAbort();
            o.signal?.addEventListener("abort", onAbort, { once: true });
            arm(idleMs);
            source.on("data", (c: Buffer) => {
              sent += c.length;
              arm(idleMs);
              o.onProgress?.(sent);
            });
            source.on("end", () => arm(answerMs));
            source.on("error", (err) => fail(new DeviceError("unreachable", `Could not read the firmware file (${err.message})`)));
            source.pipe(req);
          }),
      );
    },
    async getJson<T>(rel: string, o?: CallOptions) {
      return jsonOf<T>(await request("GET", rel, o));
    },
    async postJson<T>(rel: string, body: unknown, o?: CallOptions) {
      return jsonOf<T>(await request("POST", rel, { ...o, json: body }));
    },
    async status(o) {
      return jsonOf<DeviceStatus>(await request("GET", "/status", { timeoutMs: PROBE_TIMEOUT_MS, ...o }));
    },
    async command(body, o) {
      const res = await request("POST", "/command", { ...o, json: body });
      return jsonOf<DeviceEnvelope<unknown>>(res);
    },
    destroy() {
      agent.destroy();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pool: one client (and queue) per registered device
// ---------------------------------------------------------------------------------------------------------------

export interface DevicePool {
  /** The client for a device id; created on first use, and re-pointed when `host` changed. */
  forDevice(id: string, host: string): DeviceClient;
  /** Requests waiting or running for a device (0 when it has no client yet). */
  depth(id: string): number;
  /** Forget a device (forget/delete); its sockets are closed. */
  drop(id: string): void;
  destroy(): void;
}

export function createDevicePool(opts: { localAddress?: string; onQueueChange?: (id: string, depth: number) => void } = {}): DevicePool {
  const clients = new Map<string, DeviceClient>();
  return {
    forDevice(id, host) {
      let c = clients.get(id);
      if (!c) {
        c = createDeviceClient({
          host,
          ...(opts.localAddress ? { localAddress: opts.localAddress } : {}),
          onQueueChange: (d) => opts.onQueueChange?.(id, d),
        });
        clients.set(id, c);
      } else {
        c.setHost(host);
      }
      return c;
    },
    depth: (id) => clients.get(id)?.queueDepth ?? 0,
    drop(id) {
      clients.get(id)?.destroy();
      clients.delete(id);
    },
    destroy() {
      for (const c of clients.values()) c.destroy();
      clients.clear();
    },
  };
}
