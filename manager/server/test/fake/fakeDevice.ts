/**
 * Fake de-esp32 device: an HTTP + WebSocket server that behaves like the firmware's `/api/v1` (spec §2),
 * including its transport quirks (single request at a time, 1536-byte JSON bodies, 302 captive redirects,
 * reboots without a response, 4 registered WS slots). Used by every Manager test and by `npm run fake`.
 *
 * Simplifications are listed in `manager/README.md` ("Fake device").
 */
import http from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { DeviceEnvelope, OpenApiDocument } from "../../src/types/device-api";
import {
  COMMAND_NAMES,
  PENDING_COMMAND_NAMES,
  executeCommand,
  rebuildIo,
  setInput as setInputCmd,
  type CommandCtx,
  type CommandOutcome,
} from "./commands";
import { parseFakeImage } from "./ota";
import { disposePending, pendingOnBoot, resetToDhcp } from "./pending";
import {
  DEMO_SEED,
  bootLogs,
  createState,
  hardwarePayload,
  mqttStatus,
  networkStatus,
  otaStatus,
  resolveOptions,
  statusPayload,
  telemetrySnapshot,
  topicIdFor,
  type BootAction,
  type FakeDeviceOptions,
  type FakeSlot,
  type FakeState,
  type ResolvedOptions,
} from "./state";

export { makeFakeImage, parseFakeImage, type FakeImageOptions } from "./ota";
export type { FakeDeviceOptions, FakeFaults, FakeState } from "./state";
export type { FakeClock } from "./pending";

export type Availability = "online" | "refuse" | "hang";

export interface RequestLogEntry {
  at: number;
  kind: "http" | "ws";
  method: string;
  /** URL path for HTTP, command name for WebSocket frames. */
  path: string;
  /** Response status; `null` when the connection was dropped without a response. */
  status: number | null;
  bytes: number;
}

const API = "/api/v1";
const MAX_JSON_BODY = 1536;
const RECV_IDLE_MS = 10000;
const OTA_PROGRESS_STEP = 64 * 1024;

const GET_ROUTES = new Set(["/status", "/telemetry", "/hardware", "/pins", "/network", "/network/scan", "/mqtt", "/logs", "/ota", "/openapi.json", "/ws"]);
const POST_ROUTES = new Set(["/pins", "/command", "/network/wifi", "/mqtt", "/ota", "/system/reboot", "/system/factory_reset"]);

interface BodyResult {
  buf: Buffer | null;
  /** The client went away (or stalled) before the body ended. */
  aborted: boolean;
}

function readBody(req: http.IncomingMessage, opts: { discard?: boolean; onChunk?: (total: number) => boolean | void } = {}): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    let timer: NodeJS.Timeout;
    const finish = (r: BodyResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ buf: null, aborted: true }), RECV_IDLE_MS);
    };
    arm();
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (!opts.discard) chunks.push(c);
      arm();
      if (opts.onChunk?.(total) === true) finish({ buf: null, aborted: true });
    });
    req.on("end", () => finish({ buf: opts.discard ? Buffer.alloc(0) : Buffer.concat(chunks), aborted: false }));
    req.on("close", () => finish({ buf: null, aborted: !req.complete }));
    req.on("error", () => finish({ buf: null, aborted: true }));
    req.resume();
  });
}

export class FakeDevice {
  readonly id: string;
  private hostName: string;
  /** The listening port (stable across reboots and offline cycles). */
  port = 0;
  /** Everything mutable. Edit freely in tests; the next request sees it. */
  readonly state: FakeState;
  /** Effective options. Delays and `faults` may be changed at runtime. */
  readonly options: ResolvedOptions;
  readonly requestLog: RequestLogEntry[] = [];

  private readonly server: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<Socket>();
  private readonly allWs = new Set<WebSocket>();
  private readonly registered = new Set<WebSocket>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly ctx: CommandCtx;
  private readonly logFn: ((line: string) => void) | undefined;
  private mode: Availability = "refuse";
  private modeOp: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private telemetryTimer: NodeJS.Timeout | null = null;
  private verifyTimer: NodeJS.Timeout | null = null;
  private rebootTimer: NodeJS.Timeout | null = null;
  private pendingBoot: BootAction | null = null;
  private rebootDone: (() => void) | null = null;
  private bootEpoch = 0;
  private closed = false;

  private constructor(opts: FakeDeviceOptions) {
    this.options = resolveOptions(opts);
    this.id = this.options.id;
    this.hostName = this.options.host;
    this.logFn = opts.log;
    this.state = createState(this.options);
    this.ctx = {
      state: this.state,
      opts: this.options,
      emit: (topic, data) => this.emit(topic, data),
      sleep: (ms) => this.sleep(ms),
      control: {
        beginReboot: (action) => this.beginReboot(action),
        leaveLan: () => void this.goOffline("refuse"),
        otaApply: (slot) => void this.simulateOtaApply(slot),
        moveTo: (addr) => void this.moveTo(addr),
      },
    };
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on("connection", (s: Socket) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    this.server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket as Socket, head));
  }

  /** Start a fake device (listening on `opts.port`, default ephemeral). Prefer `startFakeDevice`. */
  static async start(opts: FakeDeviceOptions = {}): Promise<FakeDevice> {
    const dev = new FakeDevice(opts);
    await dev.init(opts);
    return dev;
  }

  // -----------------------------------------------------------------------------------------------------------
  // Public handle
  // -----------------------------------------------------------------------------------------------------------

  /** The address it listens on (changes when a `wifiMoves` entry moves the device). */
  get host(): string {
    return this.hostName;
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** All open WebSocket connections, registered or not. */
  get wsClientCount(): number {
    return this.allWs.size;
  }

  /** WebSocket clients that occupy one of the `wsLimit` slots and therefore receive events. */
  get registeredWsCount(): number {
    return this.registered.size;
  }

  get availability(): Availability {
    return this.mode;
  }

  /** Stop everything (listener, sockets, timers). The handle cannot be reused. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    if (this.rebootTimer) clearTimeout(this.rebootTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    disposePending(this.state);
    await this.modeOp.catch(() => undefined);
    await this.stopListening();
    this.wss.close();
    this.rebootDone?.();
  }

  /**
   * `"refuse"`: stop listening (connection refused), drop every connection, keep the state.
   * `"hang"`: keep accepting connections but never answer.
   */
  goOffline(mode: "refuse" | "hang" = "refuse"): Promise<void> {
    return this.setMode(mode);
  }

  /** Come back (listening on the SAME port again). Applies a pending boot (reboot/factory reset) if there is one. */
  async goOnline(): Promise<void> {
    if (this.rebootTimer) {
      clearTimeout(this.rebootTimer);
      this.rebootTimer = null;
    }
    await this.comeOnline();
    this.rebootDone?.();
    this.rebootDone = null;
  }

  /** Software reboot: offline for `rebootMs`, then back with uptime reset and `boot_count + 1`. Resolves when back online. */
  reboot(): Promise<void> {
    return this.beginReboot({});
  }

  /** Push an event frame to every registered WS client (no-op when offline or nobody is registered). */
  emit(topic: string, data: unknown): void {
    if (this.mode !== "online" || this.registered.size === 0) return;
    const frame = JSON.stringify({ topic, data });
    for (const ws of this.registered) if (ws.readyState === ws.OPEN) ws.send(frame);
  }

  /** Change the outside world: a digital level (`in` pins) or millivolts (`adc` pins). Emits and fires rules like the real thing. */
  setInput(gpio: number, value: number): void {
    setInputCmd(this.ctx, gpio, value);
  }

  // -----------------------------------------------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------------------------------------------

  private async init(opts: FakeDeviceOptions): Promise<void> {
    const silent: CommandCtx = { ...this.ctx, emit: () => undefined, sleep: () => Promise.resolve() };
    const run = async (req: Record<string, unknown>): Promise<void> => {
      const out = await executeCommand(silent, req);
      if (out.reply && !out.reply.ok) throw new Error(`fake device initial config: ${out.reply.error} (${JSON.stringify(req)})`);
    };
    const mqttInit = (m: NonNullable<FakeDeviceOptions["mqtt"]>): void => {
      const s = this.state.mqtt;
      s.enabled = true;
      if (m.uri !== undefined) s.uri = m.uri;
      if (m.root !== undefined) s.root = m.root;
      if (m.user !== undefined) s.user = m.user;
      if (m.password !== undefined) s.password = m.password;
      s.connected = m.connected ?? true;
      s.reconnects = Math.max(1, s.reconnects);
    };
    if (this.options.seed === "demo") {
      Object.assign(this.state.inputs, DEMO_SEED.inputs);
      for (const p of DEMO_SEED.pins) await run({ cmd: "pin.configure", pin: p });
      for (const m of DEMO_SEED.modules) await run({ cmd: "module.add", ...m });
      for (const r of DEMO_SEED.rules) await run({ cmd: "rule.set", rule: r });
      mqttInit(DEMO_SEED.mqtt);
      this.state.mqtt.published = 1840;
      this.state.mqtt.received = 3;
    }
    for (const p of opts.pins ?? []) await run({ cmd: "pin.configure", pin: p });
    for (const m of opts.modules ?? []) await run({ cmd: "module.add", ...m });
    for (const r of opts.rules ?? []) await run({ cmd: "rule.set", rule: r });
    if (opts.mqtt) mqttInit(opts.mqtt);
    this.state.generation = 1;
    bootLogs(this.state);
    await this.setMode("online");
    if (this.options.telemetryIntervalMs > 0) {
      this.telemetryTimer = setInterval(() => this.emit("telemetry", telemetrySnapshot(this.state)), this.options.telemetryIntervalMs);
    }
    this.log(`listening on ${this.url} id=${this.id}`);
  }

  private log(line: string): void {
    this.logFn?.(`[fake ${this.id.slice(6)}] ${line}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(() => {
        this.timers.delete(t);
        resolve();
      }, ms);
      this.timers.add(t);
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // Availability, reboot
  // -----------------------------------------------------------------------------------------------------------

  private setMode(mode: Availability): Promise<void> {
    this.modeOp = this.modeOp.then(async () => {
      if (this.closed && mode !== "refuse") return;
      this.mode = mode;
      if (mode === "refuse") await this.stopListening();
      else await this.startListening();
    });
    return this.modeOp;
  }

  /** The device joined a network on another subnet: stop answering here, answer at `addr` (`host:port` or a port) with the same id and state. */
  private moveTo(addr: string): Promise<void> {
    this.modeOp = this.modeOp.then(async () => {
      if (this.closed) return;
      const m = /^(?:(.+):)?(\d+)$/.exec(addr);
      if (!m) throw new Error(`fake device wifiMoves: bad address "${addr}"`);
      await this.stopListening();
      this.hostName = m[1] ?? this.hostName;
      this.port = Number(m[2]);
      this.options.port = this.port;
      this.options.host = this.hostName;
      this.log(`moved to ${this.hostName}:${this.port}`);
      if (this.mode === "online") await this.startListening();
    });
    return this.modeOp;
  }

  private async startListening(): Promise<void> {
    if (this.server.listening) return;
    const port = this.port || this.options.port;
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (e: Error): void => reject(e);
          this.server.once("error", onError);
          this.server.listen(port, this.host, () => {
            this.server.off("error", onError);
            resolve();
          });
        });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 40) throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const addr = this.server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
  }

  private async stopListening(): Promise<void> {
    for (const ws of this.allWs) ws.terminate();
    this.allWs.clear();
    this.registered.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async comeOnline(): Promise<void> {
    if (this.closed) return;
    if (this.pendingBoot) {
      const action = this.pendingBoot;
      this.pendingBoot = null;
      this.applyBoot(action);
    }
    await this.setMode("online");
  }

  /** Go offline now; come back after `rebootMs` (a factory reset stays offline unless `factoryResetReturns`). */
  private beginReboot(action: BootAction): Promise<void> {
    if (this.pendingBoot) return new Promise((resolve) => resolve());
    this.pendingBoot = action;
    this.log(action.factory ? "factory reset" : action.rollback ? "ota rollback reboot" : "reboot");
    if (action.factory) this.wipeConfig();
    void this.setMode("refuse");
    return new Promise<void>((resolve) => {
      this.rebootDone = resolve;
      this.rebootTimer = setTimeout(() => {
        this.rebootTimer = null;
        if (action.factory && !this.options.factoryResetReturns) {
          resolve(); // stays off the LAN (SoftAP only); goOnline() brings it back for tests
          this.rebootDone = null;
          return;
        }
        void this.comeOnline().then(() => {
          resolve();
          this.rebootDone = null;
        });
      }, this.options.rebootMs);
    });
  }

  /** `system.factory_reset`: erase the NVS user config (Wi-Fi, pins, add-ons, rules, MQTT, name, AP password). */
  private wipeConfig(): void {
    const s = this.state;
    s.pins = [];
    s.modules = [];
    s.rules = [];
    s.io = {};
    s.apPassword = "";
    s.name = s.hostname;
    s.topic_id = topicIdFor(s.name, s.hostname);
    s.mqtt.enabled = false;
    s.mqtt.connected = false;
    s.mqtt.uri = "";
    s.mqtt.root = "devices";
    s.mqtt.user = "";
    s.mqtt.password = "";
    s.network.state = "ap_only";
    s.network.sta_ip = "";
    s.network.sta_connected = false;
    s.network.provisioned = false;
    s.network.ap_open = true;
    resetToDhcp(s);
    s.generation++;
  }

  /** Everything a reset does on the way back up. */
  private applyBoot(action: BootAction): void {
    const s = this.state;
    this.bootEpoch++;
    s.bootAt = Date.now();
    s.boot_count++;
    s.reset_reason = 3; // software (esp_restart)
    s.serialSession = false;
    s.network.state = s.network.provisioned ? "sta_connected" : "ap_only"; // a reboot restores the saved credentials
    s.network.sta_connected = s.network.provisioned;
    s.network.sta_ip = s.network.provisioned ? s.network.sta_ip || "192.168.1.42" : "";
    s.mqtt.connected = s.mqtt.enabled;
    pendingOnBoot(s);

    const o = s.ota;
    o.session = "idle";
    o.bytes = 0;
    o.total = 0;
    o.percent = 0;
    delete o.last_error;
    delete o.incoming_version;
    delete o.incoming_project;
    const other = o.running === 0 ? 1 : 0;
    if (action.ota) {
      if (this.options.faults.otaRollback) {
        // The new image failed to boot; the bootloader fell back to the old slot.
        o.slots[other] = { ...action.ota, invalid: true };
        o.last_error = "new image failed to boot; rolled back";
      } else {
        o.slots[other] = action.ota;
        o.running = other;
        o.image_state = "pending_verify";
      }
    } else if (action.rollback) {
      const old = o.slots[o.running];
      if (old) old.invalid = true;
      o.running = other;
      o.image_state = "valid";
    }
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    if (o.image_state === "pending_verify") {
      const epoch = this.bootEpoch;
      this.verifyTimer = setTimeout(() => {
        if (epoch === this.bootEpoch && o.image_state === "pending_verify") o.image_state = "valid";
      }, this.options.verifyMs);
    }
    s.boot_state = s.safe_mode ? "safe_mode" : "healthy";
    rebuildIo(this.ctx);
    bootLogs(s);
  }

  // -----------------------------------------------------------------------------------------------------------
  // HTTP
  // -----------------------------------------------------------------------------------------------------------

  /** FIFO mutex: the real httpd is a single task, so request N+1 only starts when request N is done. */
  private lock(fn: () => Promise<void>): Promise<void> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private record(entry: RequestLogEntry): void {
    this.requestLog.push(entry);
    if (this.requestLog.length > 2000) this.requestLog.shift();
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.mode === "hang") return; // accepted, never answered
    const entry: RequestLogEntry = { at: Date.now(), kind: "http", method: req.method ?? "GET", path: req.url ?? "/", status: null, bytes: 0 };
    this.record(entry);
    res.on("finish", () => {
      entry.status = res.statusCode;
      this.log(`${entry.method} ${entry.path} -> ${entry.status}`);
    });
    void this.lock(async () => {
      if (req.socket.destroyed || this.mode !== "online") return;
      if (this.options.latencyMs > 0) await this.sleep(this.options.latencyMs);
      if (req.socket.destroyed || this.mode !== "online") return;
      try {
        await this.route(req, res, entry);
      } catch (e) {
        this.log(`handler error: ${(e as Error).stack ?? String(e)}`);
        if (!res.headersSent && !res.destroyed) this.sendText(res, 500, "error");
      }
    });
  }

  private sendJson(res: http.ServerResponse, body: unknown, after?: () => void): void {
    const text = JSON.stringify(body);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
    res.end(text, () => after?.());
  }

  private sendText(res: http.ServerResponse, status: number, text: string, extra: http.OutgoingHttpHeaders = {}): void {
    res.writeHead(status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(text), ...extra });
    res.end(text);
  }

  /**
   * Unknown GET (and, because it is the same httpd 404 error hook, unknown POST) redirects to the captive
   * portal instead of answering 404 (§2.1).
   */
  private async captive(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") await readBody(req, { discard: true });
    const text = "Redirect to the captive portal";
    res.writeHead(302, { Location: "http://192.168.4.1/", "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  /** JSON request body with the firmware's limits; on any problem answers 400 text `json` and returns `undefined`. */
  private async readJson(req: http.IncomingMessage, res: http.ServerResponse, entry: RequestLogEntry): Promise<Record<string, unknown> | undefined> {
    const header = req.headers["content-length"];
    const len = header === undefined ? NaN : Number(header);
    const reject = async (consumed = false): Promise<undefined> => {
      if (!consumed) await readBody(req, { discard: true });
      if (!res.destroyed) this.sendText(res, 400, "json", { Connection: "close" });
      return undefined;
    };
    if (!(len > 0) || len > MAX_JSON_BODY) return reject();
    const { buf, aborted } = await readBody(req);
    if (aborted || !buf) {
      res.destroy();
      return undefined;
    }
    entry.bytes = buf.length;
    try {
      const v: unknown = JSON.parse(buf.toString("utf8"));
      if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    return reject(true);
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, entry: RequestLogEntry): Promise<void> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    entry.path = path;
    if (path === "/" || path === "/index.html") {
      if (method !== "GET") return this.captive(req, res);
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${this.state.name}</title></head><body><h1>${this.state.name}</h1><p>de-esp32 fake device ${this.state.id}</p></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    if (!path.startsWith(`${API}/`)) return this.captive(req, res);
    const rel = path.slice(API.length);
    const known = GET_ROUTES.has(rel) || POST_ROUTES.has(rel);
    if (!known) return this.captive(req, res);
    if (method === "GET" && GET_ROUTES.has(rel)) return this.routeGet(rel, req, res);
    if (method === "POST" && POST_ROUTES.has(rel)) return this.routePost(rel, req, res, entry);
    if (method !== "GET") await readBody(req, { discard: true });
    this.sendText(res, 405, "Method Not Allowed");
  }

  private async routeGet(rel: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const s = this.state;
    switch (rel) {
      case "/status":
        return this.sendJson(res, statusPayload(s, this.registered.size));
      case "/telemetry":
        return this.sendJson(res, telemetrySnapshot(s));
      case "/hardware":
        return this.sendJson(res, hardwarePayload(s));
      case "/pins":
        return this.sendJson(res, JSON.parse(JSON.stringify(s.io)));
      case "/network":
        return this.sendJson(res, networkStatus(s));
      case "/network/scan": {
        await this.sleep(this.options.scanDelayMs);
        if (res.destroyed) return;
        return this.sendJson(res, s.scan.map((a) => ({ ...a })));
      }
      case "/mqtt":
        return this.sendJson(res, mqttStatus(s));
      case "/logs":
        return this.sendJson(res, { lines: [...s.logs] });
      case "/ota":
        return this.sendJson(res, otaStatus(s));
      case "/openapi.json": {
        const text = JSON.stringify(this.openapi());
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Content-Length": Buffer.byteLength(text) });
        res.end(text);
        return;
      }
      default: // "/ws" without an Upgrade header
        return this.sendText(res, 400, "Bad Request");
    }
  }

  private async routePost(rel: string, req: http.IncomingMessage, res: http.ServerResponse, entry: RequestLogEntry): Promise<void> {
    if (rel === "/ota") return this.otaUpload(req, res, entry);
    if (rel === "/system/reboot" || rel === "/system/factory_reset") {
      req.resume(); // body ignored
      return this.respond(req, res, await executeCommand(this.ctx, { cmd: rel === "/system/reboot" ? "system.reboot" : "system.factory_reset" }));
    }
    const body = await this.readJson(req, res, entry);
    if (!body) return;
    let command: Record<string, unknown>;
    switch (rel) {
      case "/pins":
        command = "cmd" in body ? body : { ...body, cmd: "pin.configure" }; // no cmd: the whole body is the pin
        break;
      case "/network/wifi":
        command = { ...body, cmd: "network.wifi.set" };
        break;
      case "/mqtt":
        command = { ...body, cmd: "mqtt.configure" };
        break;
      default:
        command = body;
    }
    return this.respond(req, res, await executeCommand(this.ctx, command));
  }

  /** Write a command outcome: an envelope, or (reboot paths) nothing at all and a dead socket. */
  private respond(req: http.IncomingMessage, res: http.ServerResponse, out: CommandOutcome): void {
    if (out.reply === null) {
      req.socket.destroy();
      out.after?.();
      return;
    }
    this.sendJson(res, out.reply, out.after);
  }

  private openapi(): OpenApiDocument {
    const s = this.state;
    const prefix = `${s.mqtt.root}/${s.topic_id}`;
    const paths: Record<string, unknown> = {};
    for (const p of GET_ROUTES) if (p !== "/ws") paths[`${API}${p}`] = { get: { summary: p.slice(1), responses: { "200": { description: "OK" } } } };
    for (const p of POST_ROUTES) paths[`${API}${p}`] = { ...(paths[`${API}${p}`] as object | undefined), post: { summary: p.slice(1), responses: { "200": { description: "OK" } } } };
    return {
      openapi: "3.0.3",
      info: { title: "de-esp32 runtime API (fake)", version: s.fw },
      paths,
      "x-commands": [...COMMAND_NAMES, ...(this.options.pendingFirmware ? PENDING_COMMAND_NAMES : [])],
      "x-mqtt": { root: s.mqtt.root, prefix, topics: [...s.mqtt.sub, ...s.mqtt.pub].map((t) => `${prefix}/${t}`) },
      "x-discovery": { mdns: s.hostname, service: "_http._tcp", de_service: "_de-esp32._tcp", board: "esp32-devkitc", port: 80 },
    };
  }

  // -----------------------------------------------------------------------------------------------------------
  // OTA
  // -----------------------------------------------------------------------------------------------------------

  private progress(error?: string): void {
    const o = this.state.ota;
    this.emit("ota/progress", { session: o.session, bytes: o.bytes, total: o.total, percent: o.percent, ...(error ? { error } : {}) });
  }

  /** `POST /ota`: raw image bytes, `Content-Length` required (spec §2.2, `web_server.cpp:212-252`). */
  private async otaUpload(req: http.IncomingMessage, res: http.ServerResponse, entry: RequestLogEntry): Promise<void> {
    const s = this.state;
    const o = s.ota;
    const len = Number(req.headers["content-length"] ?? NaN);
    const envErr = (error: string): DeviceEnvelope<never> => ({ v: 1, ok: false, error });
    let reject: string | null = null;
    if (!(len > 0)) reject = "Content-Length required";
    else if (o.session === "writing" || o.session === "fetching") reject = "ota busy";
    else if (o.image_state === "pending_verify") reject = "running image still pending verify";
    if (reject) {
      if (len > 0) await readBody(req, { discard: true });
      if (!res.destroyed) this.sendJson(res, envErr(reject));
      return;
    }

    o.session = "writing";
    o.bytes = 0;
    o.total = len;
    o.percent = 0;
    delete o.last_error;
    delete o.incoming_version;
    delete o.incoming_project;
    this.progress();
    let mark = OTA_PROGRESS_STEP;
    const failAt = this.options.faults.otaFailAtBytes;
    const { buf, aborted } = await readBody(req, {
      onChunk: (total) => {
        o.bytes = total;
        o.percent = Math.min(100, Math.floor((total * 100) / len));
        while (total >= mark) {
          this.progress();
          mark += OTA_PROGRESS_STEP;
        }
        if (failAt !== undefined && total >= failAt) {
          req.socket.destroy(); // fault hook: connection dies mid-upload
          return true;
        }
        return false;
      },
    });
    entry.bytes = o.bytes;
    if (aborted || !buf) {
      o.session = "error";
      o.last_error = "upload aborted";
      this.progress("upload aborted");
      if (!res.destroyed) res.destroy();
      return;
    }
    const parsed = parseFakeImage(buf);
    if (!parsed.ok) {
      o.session = "error";
      o.last_error = parsed.error;
      if (parsed.incoming_version) o.incoming_version = parsed.incoming_version;
      if (parsed.incoming_project) o.incoming_project = parsed.incoming_project;
      this.progress(parsed.error);
      this.sendJson(res, envErr(parsed.error));
      return;
    }
    o.session = "rebooting";
    o.bytes = len;
    o.percent = 100;
    o.incoming_version = parsed.slot.app_version;
    o.incoming_project = parsed.slot.project;
    this.progress();
    this.sendJson(res, { v: 1, ok: true, result: otaStatus(s) }, () => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        void this.beginReboot({ ota: parsed.slot });
      }, this.options.otaRebootDelayMs);
      this.timers.add(t);
    });
  }

  /** `ota.apply`: pretend to fetch in the background (nothing is downloaded), then reboot into the "new" image. */
  private async simulateOtaApply(slot: FakeSlot): Promise<void> {
    const o = this.state.ota;
    const epoch = this.bootEpoch;
    const steps = 4;
    this.progress();
    for (let i = 1; i <= steps; i++) {
      await this.sleep(this.options.otaApplyMs / steps);
      if (this.closed || epoch !== this.bootEpoch) return;
      o.bytes = Math.floor((o.total * i) / steps);
      o.percent = Math.floor((o.bytes * 100) / o.total);
      this.progress();
    }
    o.session = "rebooting";
    this.progress();
    await this.sleep(100);
    if (this.closed || epoch !== this.bootEpoch) return;
    void this.beginReboot({ ota: slot });
  }

  // -----------------------------------------------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------------------------------------------

  private onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.mode === "hang") return;
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    if (this.mode !== "online" || path !== `${API}/ws`) {
      socket.destroy();
      return;
    }
    void this.lock(async () => {
      if (socket.destroyed || this.mode !== "online") return;
      await new Promise<void>((resolve) => {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.onWs(ws);
          resolve();
        });
      });
    });
  }

  private onWs(ws: WebSocket): void {
    this.allWs.add(ws);
    // Only the first `wsLimit` clients are registered; a 5th+ is accepted but never gets events (§2.1).
    if (this.registered.size < this.options.wsLimit) this.registered.add(ws);
    ws.on("error", () => undefined);
    ws.on("close", () => {
      this.allWs.delete(ws);
      this.registered.delete(ws);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary || this.mode === "hang") return;
      const text = data.toString();
      void this.lock(async () => {
        if (ws.readyState !== ws.OPEN || this.mode !== "online") return;
        if (this.options.latencyMs > 0) await this.sleep(this.options.latencyMs);
        await this.onWsText(ws, text);
      });
    });
  }

  private async onWsText(ws: WebSocket, text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ v: 1, ok: false, error: "json" }));
      return;
    }
    const cmd = typeof msg === "object" && msg !== null && typeof (msg as { cmd?: unknown }).cmd === "string" ? (msg as { cmd: string }).cmd : "?";
    const entry: RequestLogEntry = { at: Date.now(), kind: "ws", method: "WS", path: cmd, status: null, bytes: text.length };
    this.record(entry);
    const out = await executeCommand(this.ctx, msg);
    if (out.reply === null) {
      ws.terminate();
      out.after?.();
      return;
    }
    entry.status = 200;
    ws.send(JSON.stringify(out.reply), () => out.after?.());
  }
}

/** Start a fake de-esp32 device. */
export function startFakeDevice(opts: FakeDeviceOptions = {}): Promise<FakeDevice> {
  return FakeDevice.start(opts);
}
