import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { routes as apiRoutes } from "./api";
import type { AppContext } from "./appContext";
import { sendError } from "./http/errors";
import { createRouter, type Route } from "./http/router";
import { createAccessController, ensureLanToken, toggleStatus, type AccessController } from "./http/access";
import { createSecurity, type RateLimitOptions, type SecurityDecision } from "./http/security";
import { serveStatic } from "./http/static";
import { isLoopbackHost, localUrlFor } from "./net";
import { createBackupsFeature, type BackupsConfig } from "./backups";
import { createDiscoveryService, type DiscoveryConfig } from "./discovery";
import { createFirmwareFeature, type FirmwareConfig } from "./firmware";
import { createIpChangeFeature, type IpChangeConfig } from "./ipchange";
import { createJobService, type JobsConfig } from "./jobs";
import { createSetupFeature, type SetupConfig, type WifiAdapterKind } from "./setup";
import { createWifiMoveFeature, type WifiMoveConfig } from "./wifimove";
import { createDevicePool } from "./device/client";
import { createHealthService } from "./device/health";
import { createLinkService } from "./device/link";
import { createSummaries } from "./device/summary";
import { createRegistry } from "./store/registry";
import { createSettingsService } from "./store/settings";
import { VERSION } from "./version";
import { createBrowserHub } from "./ws/browserHub";

export interface StartOptions {
  /** 0 picks a free port (tests, Electron). */
  port: number;
  host: string;
  /**
   * LAN mode from the command line (`--lan`): access token required (see http/security.ts). LAN mode is also on when the
   * persisted `lanEnabled` setting is true (switched on from Settings earlier) and the toggle is available.
   */
  lan: boolean;
  dataDir: string;
  /** Directory with the built SPA (index.html + assets/). Without it a "not built" page is served. */
  publicDir?: string;
  /** Extra Origin values accepted for mutating requests / WS upgrades (e.g. http://localhost:5173). */
  allowOrigins?: string[];
  log?: (msg: string) => void;
  /** Extra routes appended to the table (tests). */
  extraRoutes?: Route[];
  /** Max JSON body size in bytes (default 1 MB). */
  maxBodyBytes?: number;
  /** Health poll interval in ms; overrides the pollIntervalS setting (tests). */
  pollIntervalMs?: number;
  /** Timeout of one health poll and of the add-device probe (default 2000; tests). */
  pollTimeoutMs?: number;
  /** How long a manager-initiated restart keeps a device in `rebooting` (default 60000; tests). */
  rebootWindowMs?: number;
  /** Registry save debounce (default 1000; tests). */
  registrySaveDebounceMs?: number;
  /** Discovery injection points (fake mDNS, interface list, sweep port, timeouts). Tests must pass `mdns: false` or a fake and `interfaces: () => []`. */
  discovery?: DiscoveryConfig;
  /** Close a device's WebSocket this long after its last watcher left (default 10000; tests). */
  linkIdleCloseMs?: number;
  /** Socket open but no event frame for this long = link `full` (default 20000; tests). */
  fullDetectMs?: number;
  /** `GET /pins` poll interval while the link is `connecting` or `full` (default 5000; tests). */
  livePollMs?: number;
  /** Device link reconnect backoff bounds (default 1000 and 30000; tests). */
  linkBackoffMinMs?: number;
  linkBackoffMaxMs?: number;
  /** Quiet time that ends the `io.hydrate` burst (default 300) and its upper bound (default 1500; tests). */
  hydrateSettleMs?: number;
  hydrateMaxMs?: number;
  /** Timeout of a browser command sent over the device socket (default 10000; tests). */
  linkCmdTimeoutMs?: number;
  /** Wi-Fi adapter used by SoftAP setup (CLI: --wifi-adapter). Default "system". */
  wifiAdapter?: WifiAdapterKind;
  /** Job service tuning: finished jobs kept (default 50) and WebSocket throttle per job (default 150 ms; tests). */
  jobs?: JobsConfig;
  /** Batch 3 feature configs: each track widens its own type in its own folder. */
  setup?: SetupConfig;
  ipChange?: IpChangeConfig;
  firmware?: FirmwareConfig;
  backups?: BackupsConfig;
  /** Wi-Fi move feature config (L1). */
  wifiMove?: WifiMoveConfig;
  /** false = LAN access cannot be switched from the UI/API (the desktop app passes false). Default true. */
  lanToggle?: boolean;
  /** Address used when LAN access is switched on at runtime or by the saved setting (default "0.0.0.0"; tests use another loopback address such as "127.0.0.2"). */
  lanBindHost?: string;
  /** Addresses shown as LAN URLs (default: this machine's non-internal IPv4 addresses; tests). */
  lanAddresses?: () => string[];
  /** Wrong-token rate limit per remote address (defaults: 10 per 60 s; tests). */
  rateLimit?: RateLimitOptions;
}

export interface RunningServer {
  /** URL to open in a browser (localhost for loopback/wildcard binds). */
  url: string;
  /** Actual listening port. */
  port: number;
  host: string;
  /** LAN mode is on right now (live: follows Settings / PUT /api/access). */
  lan: boolean;
  /** Current access token (null while LAN mode is off). */
  token: string | null;
  close(): Promise<void>;
}

function deny(res: http.ServerResponse, d: Extract<SecurityDecision, { kind: "deny" }>, page: boolean): void {
  if (page && d.status === 401) {
    const html = `<!doctype html><meta charset="utf-8"><title>de-esp32 Manager</title>
<body style="font:16px system-ui;max-width:36em;margin:4em auto;padding:0 1em">
<h1>Access token required</h1>
<p>This Manager is running in LAN mode. Open the URL printed in the terminal where it was started;
it ends in <code>?token=...</code>. The token is stored in a cookie afterwards.</p></body>`;
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    return;
  }
  sendError(res, d.status, d.code, d.message, undefined, d.headers);
}

export async function start(opts: StartOptions): Promise<RunningServer> {
  const log = opts.log ?? (() => {});
  await fs.mkdir(opts.dataDir, { recursive: true });
  const settings = await createSettingsService(opts.dataDir);
  const toggle = toggleStatus(opts);
  // CLI --lan always wins; the saved switch only counts while it can be changed at all.
  const lanFromSettings = toggle.available && settings.get().lanEnabled;
  const lanAtStart = opts.lan || lanFromSettings;
  const lanBindHost = opts.lanBindHost ?? "0.0.0.0";
  const bindHost = !opts.lan && lanFromSettings && isLoopbackHost(opts.host) ? lanBindHost : opts.host;
  const token = lanAtStart ? await ensureLanToken(settings) : null;
  const registry = await createRegistry({ dataDir: opts.dataDir, debounceMs: opts.registrySaveDebounceMs ?? 1000, log });

  let port = opts.port;
  const security = createSecurity({
    lan: lanAtStart,
    token,
    allowOrigins: opts.allowOrigins ?? [],
    getPort: () => port,
    ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
  });
  // Assigned as soon as the server exists (below); read lazily by `app.host`.
  // eslint-disable-next-line prefer-const
  let access: AccessController | undefined;
  // Late-bound: the hub, pool, health service and summaries reference each other.
  // eslint-disable-next-line prefer-const
  let summaries: ReturnType<typeof createSummaries>;
  const hub = createBrowserHub({
    version: VERSION,
    lan: () => security.lan,
    log,
    getDevices: () => summaries.list(),
    getDevice: (id) => summaries.get(id),
  });
  const pool = createDevicePool({ onQueueChange: (id) => hub.deviceChanged(id) });
  const health = createHealthService({
    registry,
    pool,
    settings,
    log,
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(opts.pollTimeoutMs !== undefined ? { pollTimeoutMs: opts.pollTimeoutMs } : {}),
    ...(opts.rebootWindowMs !== undefined ? { rebootWindowMs: opts.rebootWindowMs } : {}),
    // Late-bound: the link service is created right below. A watched device with a healthy live link is not polled.
    isLive: (id) => links.isLive(id),
  });
  // Late-bound like `summaries`: the link service needs the context that is built below.
  // eslint-disable-next-line prefer-const
  let app: AppContext;
  const links = createLinkService({
    getApp: () => app,
    registry,
    health,
    hub,
    log,
    config: {
      ...(opts.linkIdleCloseMs !== undefined ? { idleCloseMs: opts.linkIdleCloseMs } : {}),
      ...(opts.fullDetectMs !== undefined ? { fullDetectMs: opts.fullDetectMs } : {}),
      ...(opts.livePollMs !== undefined ? { livePollMs: opts.livePollMs } : {}),
      ...(opts.linkBackoffMinMs !== undefined ? { backoffMinMs: opts.linkBackoffMinMs } : {}),
      ...(opts.linkBackoffMaxMs !== undefined ? { backoffMaxMs: opts.linkBackoffMaxMs } : {}),
      ...(opts.hydrateSettleMs !== undefined ? { hydrateSettleMs: opts.hydrateSettleMs } : {}),
      ...(opts.hydrateMaxMs !== undefined ? { hydrateMaxMs: opts.hydrateMaxMs } : {}),
      ...(opts.linkCmdTimeoutMs !== undefined ? { cmdTimeoutMs: opts.linkCmdTimeoutMs } : {}),
    },
  });
  summaries = createSummaries({ registry, health, queueDepth: (id) => pool.depth(id), linkState: (id) => links.stateOf(id) });
  health.onChange((id) => hub.deviceChanged(id));
  registry.onChange((c) => {
    if (c.kind === "removed") hub.deviceRemoved(c.id);
    else if (c.kind === "added" || c.kind === "updated") hub.deviceChanged(c.id);
  });
  hub.onClose((ws) => links.unwatchAll(ws));
  hub.onMessage((msg, ws) => {
    if (msg.t === "watch") {
      if (Array.isArray(msg.ids)) links.setWatch(ws, (msg.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 500));
      return;
    }
    if (msg.t !== "cmd" || typeof msg.id !== "string") return;
    const id = msg.id;
    const corr = typeof msg.corr === "string" ? { corr: msg.corr } : {};
    const body = msg.body as { cmd?: unknown } | null | undefined;
    if (typeof body !== "object" || body === null || Array.isArray(body) || typeof body.cmd !== "string" || body.cmd === "") {
      hub.send(ws, { t: "cmdResult", id, ...corr, res: { v: 1, ok: false, error: "A command needs a body with a string \"cmd\"" } });
      return;
    }
    void links.command(id, body as { cmd: string }).then((res) => hub.send(ws, { t: "cmdResult", id, ...corr, res }));
  });
  const wifiAdapterKind = opts.wifiAdapter ?? "system";
  const discovery = createDiscoveryService({ registry, health, settings, hub, log, ...(opts.discovery ? { config: opts.discovery } : {}) });
  const jobs = createJobService({ hub, log, dataDir: opts.dataDir, ...(opts.jobs ? { config: opts.jobs } : {}) });
  const routes = [...apiRoutes, ...(opts.extraRoutes ?? [])];
  // The feature seams (setup, ipChange, firmware, backups) are filled in below, once the context exists.
  const base: Omit<AppContext, "setup" | "ipChange" | "firmware" | "backups" | "wifiMove" | "access"> = {
    version: VERSION,
    // Live: LAN access can be switched at runtime (http/access.ts).
    get lan() {
      return security.lan;
    },
    get host() {
      return access?.host ?? bindHost;
    },
    dataDir: opts.dataDir,
    startedAt: Date.now(),
    get token() {
      return security.lan ? security.token : null;
    },
    routes,
    hub,
    settings,
    registry,
    pool,
    health,
    summaries,
    links,
    discovery,
    jobs,
    wifiAdapterKind,
    probeTimeoutMs: opts.pollTimeoutMs ?? 2000,
    getPort: () => port,
    log,
  };
  app = base as AppContext;
  app.setup = await createSetupFeature(app, { adapterKind: wifiAdapterKind, ...(opts.setup ? { config: opts.setup } : {}) });
  app.ipChange = await createIpChangeFeature(app, opts.ipChange);
  app.firmware = await createFirmwareFeature(app, opts.firmware);
  app.backups = await createBackupsFeature(app, opts.backups);
  app.wifiMove = await createWifiMoveFeature(app, opts.wifiMove);
  const router = createRouter(routes, { maxBodyBytes: opts.maxBodyBytes, log });

  const server = http.createServer((req, res) => {
    access?.noteRequest(req);
    const decision = security.check(req, "http");
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const isApi = pathname === "/api" || pathname.startsWith("/api/");
    if (decision.kind === "deny") return deny(res, decision, !isApi);
    if (decision.kind === "redirect") {
      res.writeHead(302, { Location: decision.location, "Set-Cookie": decision.setCookie, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (pathname === "/api/ws") {
      return sendError(res, 426, "upgrade_required", "Connect with a WebSocket upgrade", undefined, { Upgrade: "websocket" });
    }
    if (isApi) {
      void router.handle(req, res, app);
      return;
    }
    serveStatic(opts.publicDir, req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    access?.noteRequest(req);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const decision = security.check(req, "upgrade");
    const reject = (status: string, extra: string[] = []) => socket.end(["HTTP/1.1 " + status, ...extra, "Connection: close", "Content-Length: 0", "", ""].join("\r\n"));
    if (decision.kind === "deny") {
      if (decision.status === 429) return reject("429 Too Many Requests", [`Retry-After: ${decision.headers?.["Retry-After"] ?? "60"}`]);
      return reject(decision.status === 401 ? "401 Unauthorized" : "403 Forbidden");
    }
    if (decision.kind !== "allow") return reject("401 Unauthorized");
    if (pathname !== "/api/ws") return reject("404 Not Found");
    access?.noteUpgrade(socket as Socket);
    hub.handleUpgrade(req, socket, head, { local: security.isLocalUser(req) });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const controller = createAccessController({
    server,
    security,
    settings,
    hub,
    initialHost: bindHost,
    startHost: opts.host,
    lanBindHost,
    toggle,
    getPort: () => port,
    log,
    ...(opts.lanAddresses ? { lanAddresses: opts.lanAddresses } : {}),
  });
  access = controller;
  app.access = controller;
  server.on("connection", (s) => controller.trackConnection(s));
  log(`listening on ${bindHost}:${port}${security.lan ? " (LAN mode)" : ""}`);
  health.start();

  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return {
    url: localUrlFor(bindHost, port),
    port,
    get host() {
      return controller.host;
    },
    get lan() {
      return security.lan;
    },
    get token() {
      return controller.token;
    },
    async close() {
      // Features first (setup may have to put this PC's Wi-Fi back), then the jobs they run, then what jobs use.
      await app.setup.close();
      await app.ipChange.close();
      await app.firmware.close();
      await app.backups.close();
      await app.wifiMove.close();
      await app.jobs.close();
      await discovery.close();
      links.close();
      health.stop();
      pool.destroy();
      await registry.flush();
      await hub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
        for (const s of sockets) s.destroy();
      });
    },
  };
}
