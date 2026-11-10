import type { SettingsService } from "../store/settings";
import type { RegistryStore } from "../store/registry";
import type { DeviceHealth } from "../types/api";
import type { DeviceStatus, TelemetrySnapshot } from "../types/device-api";
import { DeviceError, PROBE_TIMEOUT_MS, type DevicePool } from "./client";
import type { LastSummary } from "../store/registry";
import { lastFromStatus } from "./summary";

/**
 * Health poller (spec 3.4). Every registered device gets `GET /status` through its queue every
 * `pollIntervalS` seconds (staggered by a per-device phase), once immediately at start-up and after a manual add.
 *
 * States: unknown (not polled yet since start; a deviation from the spec) -> online | unreachable (1 failure) |
 * offline (>= 2 consecutive failures, or > 2 intervals since lastSeen) | rebooting (manager-initiated restart
 * window, polled every 2 s; ends on the first successful poll) | updating (an active firmware job owns the device; see `setUpdating`).
 *
 * While a browser watches a device and its live link is healthy (`isLive`: link open, event frames arriving) the timer does
 * not poll: the frames keep `lastSeen` (and, from telemetry, the cached `last`) fresh through `liveFrame`. The moment the link
 * stops being live the link service calls `liveLost` and the device is polled at once. `pollNow` (refresh button, discovery,
 * a restart window) always polls.
 */

export interface DeviceHealthState {
  health: DeviceHealth;
  /** The stored host answered as a different device id. */
  hostMismatch: boolean;
  /** Message of the last failed poll, if the latest poll failed. */
  lastError: string | null;
}

export interface HealthOptions {
  registry: RegistryStore;
  pool: DevicePool;
  settings: SettingsService;
  log?: (msg: string) => void;
  /** Test override of the poll interval (otherwise `settings.pollIntervalS * 1000`, live). */
  pollIntervalMs?: number;
  /** Timeout of one poll (default 2000). */
  pollTimeoutMs?: number;
  /** How long a manager-initiated restart may take before failures count again (default 60000). */
  rebootWindowMs?: number;
  /** True while the device's live link is open and its frames are arriving (the link service answers). Late-bound in `start()`. */
  isLive?: (id: string) => boolean;
}

export interface HealthService {
  /** Poll everything once now (staggered a little) and keep polling. */
  start(): void;
  stop(): void;
  stateOf(id: string): DeviceHealthState;
  /** Poll one device now. Concurrent calls share one poll. Resolves when the state is updated; never rejects. */
  pollNow(id: string): Promise<void>;
  /** Feed a `/status` answer obtained elsewhere (manual add probe) as a successful poll. */
  ingest(id: string, status: DeviceStatus): void;
  /** A restart that the Manager caused: state `rebooting` until a poll succeeds (or the window ends). */
  markRebooting(id: string): void;
  /** While set, `stateOf(id).health` reads `updating` (an active firmware job owns the device). Clearing re-polls it. */
  setUpdating(id: string, updating: boolean): void;
  /**
   * An event frame arrived on the device link: the device is reachable. Keeps `lastSeen` fresh (throttled), sets the state
   * `online` and, from a telemetry frame, refreshes the cached `last`. Ignored during a restart window.
   */
  liveFrame(id: string, telemetry?: TelemetrySnapshot): void;
  /** The live link stopped being live (closed, full, silent, nobody watches): poll this device now. */
  liveLost(id: string): void;
  onChange(fn: (id: string) => void): () => void;
}

interface Runtime {
  health: DeviceHealth;
  failures: number;
  hostMismatch: boolean;
  lastError: string | null;
  rebootingUntil: number;
  lastPollAt: number;
  /** Last time `liveFrame` wrote to the registry. */
  lastLiveWrite: number;
  timer: NodeJS.Timeout | null;
  inflight: Promise<void> | null;
}

const REBOOT_POLL_MS = 2000;
/** `liveFrame` writes `lastSeen` to the registry at most this often (telemetry frames always write). */
const LIVE_WRITE_MS = 5000;

/** Stable 0..1 phase from the id, so devices do not all poll in the same instant. */
function phaseOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return (h % 1000) / 1000;
}

/** A telemetry frame carries most of what a `/status` poll does: refresh those fields of the cached summary, keep the rest. */
function mergeTelemetry(old: LastSummary | undefined, telemetry: TelemetrySnapshot): LastSummary {
  const fresh = lastFromStatus(telemetry as DeviceStatus);
  delete fresh.safe_reason; // telemetry has no safe_reason: keep the one a poll saw
  return { ...(old ?? {}), ...fresh } as LastSummary;
}

export function createHealthService(opts: HealthOptions): HealthService {
  const { registry, pool, settings } = opts;
  const log = opts.log ?? (() => {});
  const pollTimeoutMs = opts.pollTimeoutMs ?? PROBE_TIMEOUT_MS;
  const rebootWindowMs = opts.rebootWindowMs ?? 60_000;
  const states = new Map<string, Runtime>();
  const updating = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  let running = false;
  let offRegistry: (() => void) | null = null;
  let offSettings: (() => void) | null = null;

  const intervalMs = (): number => opts.pollIntervalMs ?? settings.get().pollIntervalS * 1000;
  const emit = (id: string): void => {
    for (const fn of listeners) fn(id);
  };

  function rt(id: string): Runtime {
    let r = states.get(id);
    if (!r) {
      r = { health: "unknown", failures: 0, hostMismatch: false, lastError: null, rebootingUntil: 0, lastPollAt: 0, lastLiveWrite: 0, timer: null, inflight: null };
      states.set(id, r);
    }
    return r;
  }

  const isRebooting = (r: Runtime): boolean => r.health === "rebooting" && Date.now() < r.rebootingUntil;

  function schedule(id: string, mode: "first" | "next" | "now" | { afterMs: number }): void {
    if (!running) return;
    const r = rt(id);
    if (r.timer) clearTimeout(r.timer);
    let delay: number;
    if (typeof mode === "object") delay = mode.afterMs;
    else if (mode === "now") delay = 0;
    else if (isRebooting(r)) delay = Math.min(REBOOT_POLL_MS, intervalMs());
    else if (mode === "first") delay = Math.round(intervalMs() * (0.5 + 0.5 * phaseOf(id)));
    else delay = Math.max(0, r.lastPollAt + intervalMs() - Date.now());
    r.timer = setTimeout(() => {
      r.timer = null;
      tick(id);
    }, delay);
    r.timer.unref();
  }

  /** The poll timer fired: skip the request while the live link vouches for the device, else poll. */
  function tick(id: string): void {
    const r = rt(id);
    if (!isRebooting(r) && !updating.has(id) && registry.get(id) && opts.isLive?.(id) === true) {
      r.lastPollAt = Date.now();
      schedule(id, "next");
      return;
    }
    void pollNow(id);
  }

  function success(id: string, status: DeviceStatus): void {
    const r = rt(id);
    r.failures = 0;
    r.hostMismatch = false;
    r.lastError = null;
    r.rebootingUntil = 0;
    r.health = "online";
    registry.update(id, {
      lastSeen: new Date().toISOString(),
      name: status.name || status.hostname || undefined,
      hostname: status.hostname || undefined,
      last: lastFromStatus(status),
    });
    emit(id);
  }

  function failure(id: string, message: string, mismatch: boolean): void {
    const r = rt(id);
    r.failures++;
    r.hostMismatch = mismatch;
    r.lastError = message;
    if (!isRebooting(r)) {
      const seen = Date.parse(registry.get(id)?.lastSeen ?? "");
      const stale = Number.isFinite(seen) && Date.now() - seen > 2 * intervalMs();
      r.health = r.failures >= 2 || stale ? "offline" : "unreachable";
    }
    emit(id);
  }

  async function doPoll(id: string): Promise<void> {
    const dev = registry.get(id);
    if (!dev) return;
    const r = rt(id);
    r.lastPollAt = Date.now();
    const client = pool.forDevice(id, dev.host);
    let status: DeviceStatus;
    try {
      status = await client.status({ timeoutMs: pollTimeoutMs });
    } catch (err) {
      if (!running || !registry.get(id)) return;
      failure(id, err instanceof DeviceError ? err.message : String(err), false);
      return;
    }
    if (!running || !registry.get(id)) return;
    const answered = typeof status?.id === "string" ? status.id.toLowerCase() : null;
    if (answered === null) failure(id, `${dev.host} answered without a device id`, false);
    else if (answered !== id) failure(id, `${dev.host} now answers as device ${answered}, not ${id}`, true);
    else success(id, status);
  }

  function pollNow(id: string): Promise<void> {
    const r = rt(id);
    if (r.inflight) return r.inflight;
    if (!registry.get(id)) return Promise.resolve();
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = null;
    }
    const p = doPoll(id)
      .catch((err) => log(`health poll of ${id} crashed: ${(err as Error).stack ?? err}`))
      .finally(() => {
        r.inflight = null;
        if (registry.get(id)) schedule(id, "next");
      });
    r.inflight = p;
    return p;
  }

  function forget(id: string): void {
    const r = states.get(id);
    if (r?.timer) clearTimeout(r.timer);
    states.delete(id);
    pool.drop(id);
  }

  return {
    start() {
      if (running) return;
      running = true;
      offRegistry = registry.onChange((c) => {
        if (c.kind === "added") schedule(c.id, "now");
        else if (c.kind === "removed") forget(c.id);
      });
      offSettings = settings.onChange(() => {
        for (const id of states.keys()) if (states.get(id)?.timer) schedule(id, "next");
      });
      registry.list().forEach((d, i) => schedule(d.id, { afterMs: Math.min(i * 20, 1500) }));
    },
    stop() {
      running = false;
      offRegistry?.();
      offSettings?.();
      for (const r of states.values()) if (r.timer) clearTimeout(r.timer);
    },
    stateOf(id) {
      const r = states.get(id);
      return { health: updating.has(id) ? "updating" : (r?.health ?? "unknown"), hostMismatch: r?.hostMismatch ?? false, lastError: r?.lastError ?? null };
    },
    pollNow,
    ingest(id, status) {
      if (!registry.get(id)) return;
      success(id, status);
      const r = rt(id);
      r.lastPollAt = Date.now();
      schedule(id, "first");
    },
    markRebooting(id) {
      if (!registry.get(id)) return;
      const r = rt(id);
      r.health = "rebooting";
      r.rebootingUntil = Date.now() + rebootWindowMs;
      r.failures = 0;
      r.hostMismatch = false;
      r.lastError = null;
      schedule(id, { afterMs: Math.min(REBOOT_POLL_MS, intervalMs()) });
      emit(id);
    },
    setUpdating(id, on) {
      if (on === updating.has(id)) return;
      if (on) updating.add(id);
      else updating.delete(id);
      emit(id);
      if (!on) void pollNow(id);
    },
    liveFrame(id, telemetry) {
      const dev = registry.get(id);
      if (!dev) return;
      const r = rt(id);
      if (isRebooting(r)) return;
      const t = Date.now();
      const stateChanged = r.health !== "online" || r.failures !== 0 || r.hostMismatch || r.lastError !== null;
      r.health = "online";
      r.failures = 0;
      r.hostMismatch = false;
      r.lastError = null;
      r.rebootingUntil = 0;
      if (telemetry !== undefined || t - r.lastLiveWrite >= LIVE_WRITE_MS) {
        r.lastLiveWrite = t;
        registry.update(id, { lastSeen: new Date(t).toISOString(), ...(telemetry ? { last: mergeTelemetry(dev.last, telemetry) } : {}) });
      }
      if (stateChanged) emit(id);
    },
    liveLost(id) {
      const r = states.get(id);
      if (!running || !r || !registry.get(id) || isRebooting(r)) return;
      void pollNow(id);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
