import { WebSocket } from "ws";
import { applyCommandEffects, callDevice } from "../api/deviceCall";
import type { AppContext } from "../appContext";
import { HttpError } from "../http/errors";
import type { HealthService } from "./health";
import type { RegistryStore } from "../store/registry";
import type { BrowserWsMessage, LinkState } from "../types/api";
import type { IoState, TelemetrySnapshot } from "../types/device-api";
import type { BrowserHub } from "../ws/browserHub";
import { DeviceError, timeoutFor } from "./client";

/**
 * Device WebSocket link (M5, spec 3.6) and the live fan-out to browsers.
 *
 *  - Browser sockets declare what they look at (`watch`); the server keeps AT MOST ONE device socket per device,
 *    open only while somebody watches it, closed `idleCloseMs` after the last watcher left.
 *  - Per device cache: `io` map (by state key) and the last telemetry frame. After every (re)open the server sends
 *    `io.hydrate`, collects the burst and pushes one `live` snapshot; afterwards single `io` / `event` messages.
 *  - A socket that is open but gets no event frame within `fullDetectMs` is `full` (the device already has 4 live
 *    viewers): `GET /pins` is polled and diffed into synthesised `io` messages meanwhile.
 *  - Commands from browsers go over the device socket when it is `open` (except restarts and slow commands).
 *  - "Live" (`isLive`): somebody watches, the link is `open` and an event frame arrived within the live window
 *    (`max(fullDetectMs, 2 x the telemetry interval seen`)). While live the health poller does not call `/status`; frames feed
 *    `health.liveFrame`. The moment a link stops being live, `health.liveLost` polls the device at once.
 */

export interface LinkConfig {
  /** Close the device socket this long after the last watcher left (default 10 s). */
  idleCloseMs: number;
  /** Socket open but no event frame for this long = `full` (default 20 s). */
  fullDetectMs: number;
  /** Poll interval of `GET /pins` while the link is `connecting` or `full` (default 5 s). */
  livePollMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Quiet time after the last hydrate frame before the `live` snapshot goes out (default 300 ms). */
  hydrateSettleMs: number;
  /** Upper bound for the hydrate burst (default 1500 ms). */
  hydrateMaxMs: number;
  /** Timeout of a command sent over the device socket (default 10 s). */
  cmdTimeoutMs: number;
}

export const LINK_DEFAULTS: LinkConfig = {
  idleCloseMs: 10_000,
  fullDetectMs: 20_000,
  livePollMs: 5000,
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  hydrateSettleMs: 300,
  hydrateMaxMs: 1500,
  cmdTimeoutMs: 10_000,
};

export type CmdResult = Extract<BrowserWsMessage, { t: "cmdResult" }>["res"];

/** Commands that always take the HTTP path: restarts (expected-restart mapping) and ones slower than the WS timeout. */
const HTTP_ONLY = new Set(["system.reboot", "system.factory_reset", "ota.rollback", "network.wifi.set", "network.wifi.scan"]);

export interface LinkService {
  /** Replace the set of devices this browser socket watches (unknown ids are ignored). */
  setWatch(ws: WebSocket, ids: readonly string[]): void;
  /** A browser socket closed. */
  unwatchAll(ws: WebSocket): void;
  stateOf(id: string): LinkState;
  /** Watched, `open` and frames are arriving: the health poller leaves the device alone (see the file comment). */
  isLive(id: string): boolean;
  /** One browser command: over the open device socket, else over HTTP. Never rejects. */
  command(id: string, body: { cmd: string; [k: string]: unknown }): Promise<CmdResult>;
  /** A command changed the pin/module configuration: push a fresh `live` snapshot to watchers. */
  configChanged(id: string): void;
  close(): void;
}

interface Pending {
  resolve(res: CmdResult): void;
  timer: NodeJS.Timeout;
}

interface DevLink {
  id: string;
  watchers: Set<WebSocket>;
  state: LinkState;
  sock: WebSocket | null;
  connectedHost: string;
  io: Map<string, IoState>;
  telemetry: TelemetrySnapshot | null;
  /** When the last event frame arrived (0 = none on this socket) and the gap between the last two telemetry frames. */
  lastFrameAt: number;
  lastTelemetryAt: number;
  telemetryGapMs: number;
  /** The last `updateLive` found the link live (a drop from true to false calls `health.liveLost`). */
  wasLive: boolean;
  liveTimer: NodeJS.Timeout | null;
  /** A `live` snapshot was sent for the current cache (polls send one first, then only diffs). */
  liveSent: boolean;
  hydrating: boolean;
  fresh: Map<string, IoState>;
  hydrateReply: { pins: number | null } | null;
  settleTimer: NodeJS.Timeout | null;
  maxTimer: NodeJS.Timeout | null;
  fullTimer: NodeJS.Timeout | null;
  idleTimer: NodeJS.Timeout | null;
  backoffTimer: NodeJS.Timeout | null;
  backoffMs: number;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
  refreshing: boolean;
  refreshAgain: boolean;
  pending: Map<string, Pending>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `io/*` topic for a state value, by its shape. */
export function topicForState(st: unknown): string | null {
  if (!isObject(st)) return null;
  if (st.type === "bme280") return "io/env";
  if (st.type === "mfrc522") return "io/rfid";
  switch (st.mode) {
    case "in":
    case "out":
      return "io/gpio";
    case "adc":
      return "io/adc";
    case "pwm":
      return "io/pwm";
    case "servo":
      return "io/servo";
    default:
      return null;
  }
}

/** Key of a state value in the I/O map: `gpio_4`, `adc_34` ... are the state's own `id`; add-on modules (they carry a `type`) are `mod_<id>`. */
export function stateKey(st: Record<string, unknown>): string | null {
  if (typeof st.id !== "string") return null;
  return typeof st.type === "string" ? `mod_${st.id}` : st.id;
}

/** `GET /pins` body -> the state values (objects only). */
function ioMapOf(body: unknown): Map<string, IoState> | null {
  if (!isObject(body)) return null;
  const m = new Map<string, IoState>();
  for (const [k, v] of Object.entries(body)) if (isObject(v)) m.set(k, v as unknown as IoState);
  return m;
}

export interface LinkDeps {
  /** Late-bound: the context is built after the services that use it. */
  getApp(): AppContext;
  registry: RegistryStore;
  health: HealthService;
  hub: BrowserHub;
  log?: (msg: string) => void;
  config?: Partial<LinkConfig>;
}

export function createLinkService(deps: LinkDeps): LinkService {
  const { registry, health, hub } = deps;
  const log = deps.log ?? (() => {});
  const cfg: LinkConfig = { ...LINK_DEFAULTS, ...deps.config };
  const links = new Map<string, DevLink>();
  const watched = new Map<WebSocket, Set<string>>();
  let closed = false;
  let seq = 0;

  const clear = (t: NodeJS.Timeout | null): null => {
    if (t) clearTimeout(t);
    return null;
  };
  const timer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  };

  function link(id: string): DevLink | undefined {
    let d = links.get(id);
    if (!d) {
      if (!registry.get(id)) return undefined;
      d = {
        id,
        watchers: new Set(),
        state: "closed",
        sock: null,
        connectedHost: "",
        io: new Map(),
        telemetry: null,
        lastFrameAt: 0,
        lastTelemetryAt: 0,
        telemetryGapMs: 0,
        wasLive: false,
        liveTimer: null,
        liveSent: false,
        hydrating: false,
        fresh: new Map(),
        hydrateReply: null,
        settleTimer: null,
        maxTimer: null,
        fullTimer: null,
        idleTimer: null,
        backoffTimer: null,
        backoffMs: cfg.backoffMinMs,
        pollTimer: null,
        polling: false,
        refreshing: false,
        refreshAgain: false,
        pending: new Map(),
      };
      links.set(id, d);
    }
    return d;
  }

  const emit = (d: DevLink, msg: BrowserWsMessage): void => {
    for (const ws of d.watchers) hub.send(ws, msg);
  };

  const liveMsg = (d: DevLink): BrowserWsMessage => ({
    t: "live",
    id: d.id,
    io: Object.fromEntries(d.io),
    telemetry: d.telemetry,
  });

  function setState(d: DevLink, s: LinkState): void {
    if (d.state === s) return;
    d.state = s;
    emit(d, { t: "link", id: d.id, ws: s });
    hub.deviceChanged(d.id);
    updatePolling(d);
    updateLive(d);
  }

  // ---- "live": the health poller may leave the device alone -------------------------------------------------------

  const liveWindowMs = (d: DevLink): number => Math.max(cfg.fullDetectMs, 2 * d.telemetryGapMs);
  const isLive = (d: DevLink): boolean => !closed && d.state === "open" && d.sock !== null && d.watchers.size > 0 && Date.now() - d.lastFrameAt <= liveWindowMs(d);

  /** Call after anything that can change `isLive`: a drop from live to not live polls the device now. */
  function updateLive(d: DevLink): void {
    const live = isLive(d);
    if (live) {
      d.wasLive = true;
      armLiveTimer(d);
      return;
    }
    if (!d.wasLive) return;
    d.wasLive = false;
    d.liveTimer = clear(d.liveTimer);
    health.liveLost(d.id);
  }

  /** Frames can stop without any event: one timer notices when the live window has run out. */
  function armLiveTimer(d: DevLink): void {
    if (d.liveTimer || closed) return;
    const wait = Math.max(10, liveWindowMs(d) - (Date.now() - d.lastFrameAt) + 10);
    d.liveTimer = timer(() => {
      d.liveTimer = null;
      updateLive(d);
    }, wait);
  }

  // ---- pending commands -----------------------------------------------------------------------------------------

  function failPending(d: DevLink, error: string): void {
    for (const p of d.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ v: 1, ok: false, error });
    }
    d.pending.clear();
  }

  // ---- socket lifecycle -----------------------------------------------------------------------------------------

  function resetBurst(d: DevLink): void {
    d.hydrating = false;
    d.fresh = new Map();
    d.hydrateReply = null;
    d.settleTimer = clear(d.settleTimer);
    d.maxTimer = clear(d.maxTimer);
    d.fullTimer = clear(d.fullTimer);
  }

  /** Drop the device socket without touching the state or scheduling anything. */
  function closeSocket(d: DevLink, why: string): void {
    const s = d.sock;
    d.sock = null;
    d.lastTelemetryAt = 0;
    resetBurst(d);
    failPending(d, why);
    if (s) {
      try {
        s.terminate();
      } catch {
        /* already gone */
      }
    }
  }

  function connect(d: DevLink): void {
    if (closed || d.sock) return;
    const reg = registry.get(d.id);
    if (!reg) return;
    d.backoffTimer = clear(d.backoffTimer);
    setState(d, "connecting");
    d.connectedHost = reg.host;
    let sock: WebSocket;
    try {
      sock = new WebSocket(`ws://${reg.host}/api/v1/ws`, { handshakeTimeout: 5000, perMessageDeflate: false });
    } catch (err) {
      log(`device link ${d.id}: cannot open socket: ${(err as Error).message}`);
      scheduleReconnect(d);
      return;
    }
    d.sock = sock;
    sock.on("open", () => onOpen(d, sock));
    sock.on("message", (data, isBinary) => {
      if (d.sock === sock && !isBinary) onFrame(d, data.toString());
    });
    sock.on("error", () => {
      /* the close event follows */
    });
    sock.on("close", () => onClose(d, sock));
  }

  function onOpen(d: DevLink, sock: WebSocket): void {
    if (d.sock !== sock || closed) return;
    resetBurst(d);
    d.hydrating = true;
    d.maxTimer = timer(() => settle(d), cfg.hydrateMaxMs);
    d.fullTimer = timer(() => {
      d.fullTimer = null;
      if (d.sock === sock && d.state === "connecting") setState(d, "full");
    }, cfg.fullDetectMs);
    sock.send(JSON.stringify({ cmd: "io.hydrate", corr: "mgr-hydrate" }));
  }

  function onClose(d: DevLink, sock: WebSocket): void {
    if (d.sock !== sock) return;
    d.sock = null;
    d.lastTelemetryAt = 0;
    resetBurst(d);
    failPending(d, "The device link closed before the device answered");
    if (closed) return;
    if (d.watchers.size > 0) {
      setState(d, "connecting");
      scheduleReconnect(d);
    } else {
      setState(d, "closed");
    }
  }

  function scheduleReconnect(d: DevLink): void {
    if (closed || d.backoffTimer || d.sock || d.watchers.size === 0) return;
    const delay = d.backoffMs;
    d.backoffMs = Math.min(d.backoffMs * 2, cfg.backoffMaxMs);
    d.backoffTimer = timer(() => {
      d.backoffTimer = null;
      if (d.watchers.size > 0) connect(d);
    }, delay);
  }

  /** Close everything for a device: socket, timers, cache. State becomes `closed`. */
  function closeLink(d: DevLink): void {
    d.idleTimer = clear(d.idleTimer);
    d.backoffTimer = clear(d.backoffTimer);
    d.pollTimer = clear(d.pollTimer);
    d.liveTimer = clear(d.liveTimer);
    closeSocket(d, "The device link was closed");
    d.io = new Map();
    d.telemetry = null;
    d.liveSent = false;
    d.backoffMs = cfg.backoffMinMs;
    setState(d, "closed");
  }

  // ---- frames ---------------------------------------------------------------------------------------------------

  function onFrame(d: DevLink, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    if (typeof msg.topic === "string") {
      onEvent(d, msg.topic, msg.data);
      return;
    }
    // Command replies (no topic) are never forwarded as events.
    if (typeof msg.corr !== "string") return;
    if (msg.corr === "mgr-hydrate") {
      const result = isObject(msg.result) ? msg.result : undefined;
      d.hydrateReply = { pins: msg.ok === true && typeof result?.pins === "number" ? result.pins : null };
      bumpSettle(d);
      return;
    }
    const p = d.pending.get(msg.corr);
    if (!p) return;
    d.pending.delete(msg.corr);
    clearTimeout(p.timer);
    p.resolve({
      v: 1,
      ok: msg.ok === true,
      ...(typeof msg.error === "string" ? { error: msg.error } : {}),
      ...(msg.result !== undefined ? { result: msg.result } : {}),
    });
  }

  function onEvent(d: DevLink, topic: string, data: unknown): void {
    if (d.state === "connecting" || d.state === "full") {
      d.fullTimer = clear(d.fullTimer);
      d.backoffMs = cfg.backoffMinMs;
      setState(d, "open");
    }
    const now = Date.now();
    d.lastFrameAt = now;
    if (topic === "telemetry" && isObject(data)) {
      if (d.lastTelemetryAt > 0) d.telemetryGapMs = Math.min(now - d.lastTelemetryAt, 10 * 60_000);
      d.lastTelemetryAt = now;
    }
    health.liveFrame(d.id, topic === "telemetry" && isObject(data) ? (data as unknown as TelemetrySnapshot) : undefined);
    updateLive(d);
    // Never forward (or log the content of) this frame: it carries the MQTT password.
    if (topic === "mqtt/reconfigure") return;
    const key = topic.startsWith("io/") && isObject(data) ? stateKey(data) : null;
    if (key !== null) {
      const st = data as unknown as IoState;
      if (d.hydrating) {
        d.fresh.set(key, st);
        bumpSettle(d);
        return;
      }
      d.io.set(key, st);
      emit(d, { t: "io", id: d.id, topic, data: st });
      return;
    }
    if (topic === "telemetry" && isObject(data)) d.telemetry = data as unknown as TelemetrySnapshot;
    if (topic === "identity/rename" && isObject(data) && typeof data.name === "string" && data.name) {
      registry.update(d.id, { name: data.name });
    }
    emit(d, { t: "event", id: d.id, topic, data });
  }

  function bumpSettle(d: DevLink): void {
    if (!d.hydrating) return;
    d.settleTimer = clear(d.settleTimer);
    d.settleTimer = timer(() => settle(d), cfg.hydrateSettleMs);
  }

  /** The hydrate burst is over: replace the cache with what arrived and push one `live` snapshot. */
  function settle(d: DevLink): void {
    if (!d.hydrating) return;
    const fresh = d.fresh;
    const answered = d.hydrateReply;
    d.hydrating = false;
    d.fresh = new Map();
    d.hydrateReply = null;
    d.settleTimer = clear(d.settleTimer);
    d.maxTimer = clear(d.maxTimer);
    // Nothing arrived and the device did not say it has nothing: it ignores us (full) or is old; keep the cache.
    if (fresh.size === 0 && answered?.pins !== 0) return;
    d.io = fresh;
    d.liveSent = true;
    emit(d, liveMsg(d));
  }

  // ---- polling (connecting / full) and refreshes ----------------------------------------------------------------

  async function fetchPins(id: string): Promise<Map<string, IoState> | null> {
    const dev = registry.get(id);
    if (!dev) return null;
    try {
      const res = await callDevice(deps.getApp(), dev, "GET", "/pins");
      if (res.status < 200 || res.status >= 300) return null;
      return ioMapOf(res.json);
    } catch (err) {
      if (!(err instanceof DeviceError) && !(err instanceof HttpError)) log(`device link ${id}: pins fetch failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Take a `GET /pins` result into the cache: a snapshot when keys vanished (or nothing was sent yet), else per-key `io`. */
  function applyPins(d: DevLink, next: Map<string, IoState>, forceLive: boolean): void {
    const removed = [...d.io.keys()].some((k) => !next.has(k));
    if (forceLive || !d.liveSent || removed) {
      d.io = next;
      d.liveSent = true;
      emit(d, liveMsg(d));
      return;
    }
    for (const [k, v] of next) {
      if (JSON.stringify(d.io.get(k)) === JSON.stringify(v)) continue;
      d.io.set(k, v);
      const topic = topicForState(v);
      if (topic) emit(d, { t: "io", id: d.id, topic, data: v });
    }
  }

  const wantsPolling = (d: DevLink): boolean => !closed && d.watchers.size > 0 && (d.state === "connecting" || d.state === "full");

  function updatePolling(d: DevLink): void {
    if (!wantsPolling(d)) {
      d.pollTimer = clear(d.pollTimer);
      return;
    }
    if (d.pollTimer || d.polling) return;
    d.pollTimer = timer(() => void pollOnce(d), cfg.livePollMs);
  }

  async function pollOnce(d: DevLink): Promise<void> {
    d.pollTimer = null;
    if (!wantsPolling(d)) return;
    d.polling = true;
    try {
      const map = await fetchPins(d.id);
      if (map && wantsPolling(d)) applyPins(d, map, false);
    } finally {
      d.polling = false;
      updatePolling(d);
    }
  }

  async function refresh(d: DevLink): Promise<void> {
    if (d.refreshing) {
      d.refreshAgain = true;
      return;
    }
    d.refreshing = true;
    try {
      do {
        d.refreshAgain = false;
        const map = await fetchPins(d.id);
        if (map && !closed && d.watchers.size > 0) applyPins(d, map, true);
      } while (d.refreshAgain);
    } finally {
      d.refreshing = false;
    }
  }

  // ---- reactions to the rest of the app -------------------------------------------------------------------------

  const offHealth = health.onChange((id) => {
    const d = links.get(id);
    if (!d || d.sock || !d.backoffTimer || d.watchers.size === 0) return;
    // The device answered a poll while we wait for the next reconnect: try now (e.g. after a reboot).
    if (health.stateOf(id).health === "online") connect(d);
  });

  const offRegistry = registry.onChange((c) => {
    if (c.kind === "removed") {
      const d = links.get(c.id);
      if (!d) return;
      d.watchers.clear();
      closeLink(d);
      links.delete(c.id);
    } else if (c.kind === "updated") {
      const d = links.get(c.id);
      if (!d || d.watchers.size === 0 || !d.connectedHost || c.device.host === d.connectedHost) return;
      // The device moved: reconnect to the new address now.
      d.backoffTimer = clear(d.backoffTimer);
      closeSocket(d, "The device address changed");
      connect(d);
    }
  });

  // ---- public API -----------------------------------------------------------------------------------------------

  function release(d: DevLink): void {
    if (d.watchers.size > 0 || d.idleTimer) return;
    d.idleTimer = timer(() => {
      d.idleTimer = null;
      if (d.watchers.size === 0) closeLink(d);
    }, cfg.idleCloseMs);
  }

  function setWatch(ws: WebSocket, ids: readonly string[]): void {
    if (closed) return;
    const next = new Set<string>();
    for (const id of ids) if (typeof id === "string" && registry.get(id)) next.add(id);
    const prev = watched.get(ws) ?? new Set<string>();
    if (next.size === 0) watched.delete(ws);
    else watched.set(ws, next);
    for (const id of prev) {
      if (next.has(id)) continue;
      const d = links.get(id);
      if (!d) continue;
      d.watchers.delete(ws);
      updateLive(d);
      release(d);
    }
    for (const id of next) {
      if (prev.has(id)) continue;
      const d = link(id);
      if (!d) continue;
      d.idleTimer = clear(d.idleTimer);
      if (d.state === "closed" && !d.sock) connect(d);
      d.watchers.add(ws);
      updatePolling(d);
      updateLive(d);
      hub.send(ws, { t: "link", id, ws: d.state });
      if (d.io.size > 0 || d.telemetry) hub.send(ws, liveMsg(d));
    }
  }

  async function viaHttp(id: string, body: { cmd: string; [k: string]: unknown }): Promise<CmdResult> {
    const dev = registry.get(id);
    if (!dev) return { v: 1, ok: false, error: `No device with id "${id}" is registered` };
    try {
      const res = await callDevice(deps.getApp(), dev, "POST", "/command", { json: body });
      const env = res.json;
      if (isObject(env) && typeof env.ok === "boolean") {
        return {
          v: 1,
          ok: env.ok,
          ...(typeof env.error === "string" ? { error: env.error } : {}),
          ...(env.result !== undefined ? { result: env.result } : {}),
        };
      }
      if (res.status === 400 && res.text.trim() === "json") {
        return { v: 1, ok: false, error: "The device rejected the command body as invalid JSON (HTTP 400 \"json\")" };
      }
      return { v: 1, ok: false, error: `The device answered HTTP ${res.status} without a command envelope` };
    } catch (err) {
      if (err instanceof DeviceError || err instanceof HttpError) return { v: 1, ok: false, error: err.message };
      return { v: 1, ok: false, error: (err as Error).message || "The command failed" };
    }
  }

  async function viaSocket(d: DevLink, sock: WebSocket, body: { cmd: string; [k: string]: unknown }): Promise<CmdResult> {
    const corr = `mgr-${++seq}`;
    const res = await new Promise<CmdResult>((resolve) => {
      const t = timer(() => {
        d.pending.delete(corr);
        resolve({ v: 1, ok: false, error: `The device did not answer ${body.cmd} within ${Math.round(cfg.cmdTimeoutMs / 100) / 10} s` });
      }, cfg.cmdTimeoutMs);
      d.pending.set(corr, { resolve, timer: t });
      sock.send(JSON.stringify({ ...body, corr }), (err) => {
        if (!err || !d.pending.delete(corr)) return;
        clearTimeout(t);
        resolve({ v: 1, ok: false, error: `Could not send ${body.cmd} to the device: ${err.message}` });
      });
    });
    applyCommandEffects(deps.getApp(), d.id, body.cmd, body, { ok: res.ok, result: res.result }, res.ok, false);
    return res;
  }

  return {
    setWatch,
    unwatchAll(ws) {
      setWatch(ws, []);
    },
    stateOf: (id) => links.get(id)?.state ?? "closed",
    isLive: (id) => {
      const d = links.get(id);
      return d !== undefined && isLive(d);
    },
    async command(id, body) {
      const dev = registry.get(id);
      if (!dev) return { v: 1, ok: false, error: `No device with id "${id}" is registered` };
      const d = links.get(id);
      const slow = HTTP_ONLY.has(body.cmd) || timeoutFor(body.cmd, "/command") > cfg.cmdTimeoutMs;
      if (d && d.state === "open" && d.sock && d.sock.readyState === WebSocket.OPEN && !slow) return viaSocket(d, d.sock, body);
      return viaHttp(id, body);
    },
    configChanged(id) {
      const d = links.get(id);
      if (!d || d.watchers.size === 0) return;
      void refresh(d);
    },
    close() {
      closed = true;
      offHealth();
      offRegistry();
      for (const d of links.values()) {
        d.watchers.clear();
        d.idleTimer = clear(d.idleTimer);
        d.backoffTimer = clear(d.backoffTimer);
        d.pollTimer = clear(d.pollTimer);
        d.liveTimer = clear(d.liveTimer);
        closeSocket(d, "The Manager is shutting down");
      }
      links.clear();
      watched.clear();
    },
  };
}
