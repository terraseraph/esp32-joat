import { mergeDevice, type DiscoveredDevice } from "node-red-contrib-de-esp32/lib/discover";
import { isOurs, summarize } from "node-red-contrib-de-esp32/lib/fingerprint";
import type { HealthService } from "../device/health";
import { formatHostAddr, splitStoredHost } from "../device/hostAddr";
import type { AddedVia, RegistryStore } from "../store/registry";
import type { SettingsService } from "../store/settings";
import type { DiscoveryClassification, DiscoveryResult, DiscoveryState, ScanPhase } from "../types/api";
import type { DeviceStatus } from "../types/device-api";
import type { BrowserHub } from "../ws/browserHub";
import { browseMdns, DEFAULT_MDNS_WINDOW_MS, realMdnsFactory, type MdnsFactory } from "./mdns";
import {
  buildSweepPlan,
  canonicalTarget,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SWEEP_CONCURRENCY,
  localInterfaces,
  parseSubnet,
  parseTarget,
  probeStatus,
  resolveTarget,
  runPool,
  SubnetError,
  TargetError,
  type IfaceAddr,
} from "./sweep";

/**
 * Discovery service (spec 3.3): scan state, results, classification, adopt/ignore, the background timer and the
 * `waitForDevice` library call for the setup jobs. See `CONTRIBUTING-AGENTS.md` ("Discovery (M3)").
 */

/** `StartOptions.discovery`: injection points (tests pass a fake mDNS and a tiny interface list). */
export interface DiscoveryConfig {
  /** `false` disables mDNS entirely; a factory replaces the real `multicast-dns` socket. */
  mdns?: false | MdnsFactory;
  /** Local IPv4 interfaces to sweep (default: the machine's non-internal, non-link-local ones). */
  interfaces?: () => IfaceAddr[];
  /** Port probed on swept hosts (default 80). Targets and registry hosts carry their own port. */
  sweepPort?: number;
  /** Timeout of one probe (default 800). */
  probeTimeoutMs?: number;
  /** Probes in flight (default 48). */
  concurrency?: number;
  /** mDNS browse window (default 2500). */
  mdnsWindowMs?: number;
  /** Background scan period override in ms (tests; otherwise `backgroundScan.periodMin`). */
  backgroundPeriodMs?: number;
}

export class ScanRunningError extends Error {
  readonly code = "scan_running";
  constructor() {
    super("A scan is already running. Wait for it to finish or cancel it (POST /api/discovery/cancel).");
    this.name = "ScanRunningError";
  }
}

export class DiscoveryInputError extends Error {
  readonly code = "invalid_body";
  constructor(
    message: string,
    readonly details: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "DiscoveryInputError";
  }
}

export interface StartScanOptions {
  mdns?: boolean;
  sweep?: boolean;
  subnets?: string[];
  targets?: string[];
}

export interface WaitForDeviceOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Pause between rounds (default 2000). */
  intervalMs?: number;
  /** Browse mDNS each round (default true; needs the server to have mDNS enabled). */
  mdns?: boolean;
  /** Sweep the local networks each round (default true). */
  sweep?: boolean;
  /** Extra `host[:port]` addresses probed each round (the settings' discovery targets and the device's registry address are always probed). */
  targets?: string[];
}

export interface FoundDevice {
  /** `ip` or `ip:port`. */
  host: string;
  status: DeviceStatus;
}

export interface DiscoveryService {
  /** Start a scan; throws `ScanRunningError` / `DiscoveryInputError`. Returns the state right after starting. */
  startScan(opts?: StartScanOptions): DiscoveryState;
  cancelScan(): Promise<DiscoveryState>;
  getState(): DiscoveryState;
  ignore(id: string): DiscoveryState;
  unignore(id: string): DiscoveryState;
  /** Add devices from the current results to the registry (and poll them). */
  adopt(ids: string[]): Promise<{ added: string[]; skipped: { id: string; reason: "unknown_id" | "already_known" }[] }>;
  /**
   * Library call for setup jobs (M4b, M8b): look for the device with this id until found, `timeoutMs` passed or
   * `signal` aborted. Each round probes the registry address, the targets and mDNS first, then sweeps. Works
   * while a UI scan runs and never touches its state, the registry or the WebSocket. Resolves null on timeout/abort.
   */
  waitForDevice(id: string, opts: WaitForDeviceOptions): Promise<FoundDevice | null>;
  /** Stop timers and any running scan. */
  close(): Promise<void>;
}

export interface DiscoveryDeps {
  registry: RegistryStore;
  health: HealthService;
  settings: SettingsService;
  hub: BrowserHub;
  log?: (msg: string) => void;
  config?: DiscoveryConfig;
}

// ---- background timer -----------------------------------------------------------------------------------------

export const BACKGROUND_MAX_DEVICES = 50;

export type BackgroundDecision = "scan" | "skip_disabled" | "skip_running" | "skip_many";

/** What a background tick does (spec 3.3: skipped when a scan runs, and automatically with more than 50 devices). */
export function backgroundDecision(s: { enabled: boolean; running: boolean; deviceCount: number }): BackgroundDecision {
  if (!s.enabled) return "skip_disabled";
  if (s.running) return "skip_running";
  if (s.deviceCount > BACKGROUND_MAX_DEVICES) return "skip_many";
  return "scan";
}

export interface BackgroundTimer {
  /** Re-read the config and restart the countdown (call when settings change). */
  reschedule(): void;
  stop(): void;
}

/** Calls `tick` every `periodMs` while `enabled` (the first tick comes one period after enabling). */
export function createBackgroundTimer(opts: { getConfig: () => { enabled: boolean; periodMs: number }; tick: () => void }): BackgroundTimer {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clear();
    if (stopped) return;
    const c = opts.getConfig();
    if (!c.enabled) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        opts.tick();
      } finally {
        arm();
      }
    }, Math.max(10, c.periodMs));
    timer.unref();
  };
  return {
    reschedule: arm,
    stop() {
      stopped = true;
      clear();
    },
  };
}

// ---- helpers ----------------------------------------------------------------------------------------------------

const VIA_ORDER = ["mdns", "sweep", "target", "registry"];

interface Entry {
  host: string;
  port: number;
  vias: Set<string>;
  txt?: Record<string, string>;
}

/** The de-duplicating list of addresses to probe in one scan/round. */
class ProbeSet {
  readonly entries = new Map<string, Entry>();
  /** Adds an address; returns the entry when it is new (it must be probed), null when it was known (its vias/TXT are merged). */
  add(host: string, port: number, via: string, txt?: Record<string, string>): Entry | null {
    const key = `${host}:${port}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.vias.add(via);
      if (txt) existing.txt = { ...existing.txt, ...txt };
      return null;
    }
    const entry: Entry = { host, port, vias: new Set([via]), ...(txt ? { txt } : {}) };
    this.entries.set(key, entry);
    return entry;
  }
}

const statusId = (status: DeviceStatus | null): string | null => {
  if (!status || typeof status.id !== "string" || !/^[0-9a-f]{12}$/i.test(status.id) || !isOurs(status)) return null;
  return status.id.toLowerCase();
};

const hostOf = (e: Entry): string => formatHostAddr({ host: e.host, port: e.port, isIp: true });
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

interface Extra {
  id: string;
  /** formatted host -> vias (the Set is shared with the probe entry, so later vias show up) */
  hosts: Map<string, Set<string>>;
  status: DeviceStatus;
  lastSeen: string;
  txt?: Record<string, string>;
  ipChanged?: { from: string; to: string };
}

interface Job {
  ctrl: AbortController;
  done: Promise<void>;
  /** Background scans only broadcast their final message. */
  broadcast: boolean;
}

const SETUP_STATES = new Set(["ap_only", "apsta_recovery"]);
const PROGRESS_INTERVAL_MS = 250; // <= 4 messages per second

export function createDiscoveryService(deps: DiscoveryDeps): DiscoveryService {
  const { registry, health, settings, hub } = deps;
  const log = deps.log ?? (() => {});
  const cfg = deps.config ?? {};
  const mdnsFactory: MdnsFactory | null = cfg.mdns === false ? null : (cfg.mdns ?? realMdnsFactory);
  const interfaces = cfg.interfaces ?? localInterfaces;
  const sweepPort = cfg.sweepPort ?? 80;
  const probeTimeoutMs = cfg.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const concurrency = cfg.concurrency ?? DEFAULT_SWEEP_CONCURRENCY;
  const mdnsWindowMs = cfg.mdnsWindowMs ?? DEFAULT_MDNS_WINDOW_MS;

  let phase: ScanPhase = "idle";
  let probed = 0;
  let total = 0;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  let warnings: string[] = [];
  let subnets: string[] = [];
  let extras = new Map<string, Extra>();
  let merged = new Map<string, DiscoveredDevice>();
  let job: Job | null = null;
  let closed = false;

  // ---- results ----------------------------------------------------------------------------------------------

  /** The address to use for a device: the registered one when it answered, else the one matching its reported STA address, else the first. */
  function chooseHost(ex: Extra, stored: string | undefined): string {
    const hosts = [...ex.hosts.keys()];
    if (stored && hosts.includes(stored)) return stored;
    const sta = ex.status.network?.sta_ip;
    if (sta) {
      const m = hosts.find((h) => splitStoredHost(h).hostname === sta);
      if (m) return m;
    }
    return hosts[0] as string;
  }

  const viaOf = (ex: Extra): string => {
    const all = new Set<string>();
    for (const vias of ex.hosts.values()) for (const v of vias) all.add(v);
    return VIA_ORDER.filter((v) => all.has(v)).join("+");
  };

  const classify = (id: string): DiscoveryClassification => (registry.get(id) ? "known" : registry.isIgnored(id) ? "ignored" : "new");

  function toResult(ex: Extra): DiscoveryResult {
    const stored = registry.get(ex.id);
    const host = chooseHost(ex, stored?.host);
    const sum = merged.get(ex.id);
    const txt = ex.txt;
    const netState = ex.status.network?.state ?? "";
    const board = sum?.board || txt?.board || "";
    const appVersion = ex.status.ota?.app_version;
    const ipChanged = ex.ipChanged ?? (stored && stored.host !== host ? { from: stored.host, to: host } : undefined);
    return {
      id: ex.id,
      host,
      name: sum?.name || txt?.name || sum?.hostname || "",
      hostname: sum?.hostname || "",
      fw: sum?.fw || txt?.fw || "",
      ...(appVersion ? { app_version: appVersion } : {}),
      ...(board ? { board } : {}),
      via: viaOf(ex),
      classification: classify(ex.id),
      // apsta_recovery with a working STA link is a set-up board whose setup Wi-Fi is merely still on (the firmware
      // never closes it until a restart); only ap_only, or recovery without a STA link, needs setting up.
      setup: netState === "ap_only" || (netState === "apsta_recovery" && ex.status.network?.sta_connected !== true),
      setupApOpen: SETUP_STATES.has(netState),
      netState,
      ...(ipChanged ? { ipChanged } : {}),
      ...(txt ? { txt } : {}),
      lastSeen: ex.lastSeen,
    };
  }

  const snapshot = (): DiscoveryResult[] =>
    [...extras.values()].map(toResult).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id));

  function getState(): DiscoveryState {
    return { running: job !== null, phase, probed, total, startedAt, finishedAt, warnings: [...warnings], subnets: [...subnets], results: snapshot(), ignored: registry.ignoredIds() };
  }

  // ---- WebSocket progress (<= 4/s) --------------------------------------------------------------------------------

  let lastEmit = 0;
  let trailing: NodeJS.Timeout | null = null;
  const send = (): void => {
    if (trailing) clearTimeout(trailing);
    trailing = null;
    lastEmit = Date.now();
    hub.broadcast({ t: "scan", phase, probed, total, found: snapshot() });
  };
  /** `progress` is throttled (a trailing message follows); `now` (phase change, end) always sends immediately. */
  function emit(kind: "progress" | "now", forJob?: Job | null): void {
    if (forJob && !forJob.broadcast && kind !== "now") return;
    if (kind === "now") return send();
    const wait = lastEmit + PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) return send();
    if (trailing) return;
    trailing = setTimeout(send, wait);
    trailing.unref();
  }
  const setPhase = (p: ScanPhase, j: Job | null): void => {
    phase = p;
    if (!j || j.broadcast || p === "done" || p === "cancelled" || p === "error") emit("now");
  };

  registry.onChange(() => {
    // Classification is computed on read; just tell the browsers when results exist.
    if (extras.size > 0 && !closed && !(job && !job.broadcast)) emit("progress");
  });

  // ---- probing -------------------------------------------------------------------------------------------------

  function onStatus(entry: Entry, status: DeviceStatus | null): void {
    const id = statusId(status);
    if (!id || !status) return;
    const host = hostOf(entry);
    const sum = summarize(host, status, [...entry.vias].join("+"));
    mergeDevice(merged, { ...sum, id });
    let ex = extras.get(id);
    if (!ex) {
      ex = { id, hosts: new Map(), status, lastSeen: new Date().toISOString() };
      extras.set(id, ex);
    }
    ex.hosts.set(host, entry.vias);
    ex.status = status;
    ex.lastSeen = new Date().toISOString();
    if (entry.txt) ex.txt = { ...ex.txt, ...entry.txt };
  }

  async function probeAll(entries: Entry[], signal: AbortSignal, onEach: (entry: Entry, status: DeviceStatus | null) => boolean | void): Promise<void> {
    await runPool(
      entries,
      concurrency,
      async (e) => {
        const st = await probeStatus(e.host, e.port, { timeoutMs: probeTimeoutMs, signal });
        if (signal.aborted) return true;
        return onEach(e, st);
      },
      signal,
    );
  }

  /** Registry addresses + explicit targets, as probe entries (names resolved; failures become warnings). */
  async function quickEntries(set: ProbeSet, targets: string[], warn: (m: string) => void, onlyRegistryId?: string): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const dev of registry.list()) {
      if (onlyRegistryId !== undefined && dev.id !== onlyRegistryId) continue;
      try {
        const { hostname, port } = splitStoredHost(dev.host);
        const e = set.add(hostname, port, "registry");
        if (e) out.push(e);
      } catch {
        /* a malformed stored host is the poller's problem */
      }
    }
    for (const t of targets) {
      let addr;
      try {
        addr = parseTarget(t);
      } catch (err) {
        warn(`Ignoring target "${t}": ${(err as Error).message}`);
        continue;
      }
      const resolved = addr.isIp ? addr : await resolveTarget(addr);
      if (!resolved) {
        warn(`Could not resolve "${t}" to an IP address; skipped.`);
        continue;
      }
      const e = set.add(resolved.host, resolved.port, "target");
      if (e) out.push(e);
    }
    return out;
  }

  // ---- scan ------------------------------------------------------------------------------------------------------

  async function finalizeKnown(wait: boolean): Promise<void> {
    const polls: Promise<void>[] = [];
    for (const ex of extras.values()) {
      const stored = registry.get(ex.id);
      if (!stored) continue;
      const host = chooseHost(ex, stored.host);
      const sum = merged.get(ex.id);
      if (host !== stored.host) ex.ipChanged = { from: stored.host, to: host };
      registry.upsert({
        id: ex.id,
        host,
        ...(sum?.hostname ? { hostname: sum.hostname } : {}),
        ...(sum?.name ? { name: sum.name } : {}),
        addedVia: stored.addedVia,
      });
      registry.update(ex.id, { lastSeen: ex.lastSeen });
      polls.push(health.pollNow(ex.id));
    }
    if (wait) await Promise.all(polls);
  }

  type Plan = { subnets: string[]; hosts: string[] };

  async function execute(j: Job, req: Required<Pick<StartScanOptions, "mdns" | "sweep">>, targets: string[], plan: Plan): Promise<void> {
    const signal = j.ctrl.signal;
    const warn = (m: string): void => {
      if (!warnings.includes(m)) warnings.push(m);
    };
    try {
      const set = new ProbeSet();
      const quick = await quickEntries(set, targets, warn);

      total = quick.length + plan.hosts.length;
      if (j.broadcast) emit("now");

      // Phase 1: registered addresses and targets, while mDNS is browsed in parallel.
      const mdnsRun =
        req.mdns && mdnsFactory
          ? browseMdns(mdnsFactory, { windowMs: mdnsWindowMs, signal, log })
          : Promise.resolve({ candidates: [], warnings: [] as string[] });
      await probeAll(quick, signal, (e, st) => {
        onStatus(e, st);
        probed++;
        emit("progress", j);
      });
      const m = await mdnsRun;
      m.warnings.forEach(warn);
      const fresh: Entry[] = [];
      for (const c of m.candidates.slice(0, 128)) {
        const e = set.add(c.ip, c.port, "mdns", c.txt);
        if (e) fresh.push(e);
      }
      total += fresh.length;
      emit("progress", j);
      await probeAll(fresh, signal, (e, st) => {
        onStatus(e, st);
        probed++;
        emit("progress", j);
      });

      // Phase 2: the sweep (addresses already probed above only gain their via).
      if (!signal.aborted && req.sweep && plan.hosts.length > 0) {
        setPhase("sweep", j);
        const sweepEntries: Entry[] = [];
        for (const h of plan.hosts) {
          const e = set.add(h, sweepPort, "sweep");
          if (e) sweepEntries.push(e);
          else probed++;
        }
        await probeAll(sweepEntries, signal, (e, st) => {
          onStatus(e, st);
          probed++;
          emit("progress", j);
        });
      }

      const cancelled = signal.aborted;
      await finalizeKnown(!cancelled);
      finishedAt = new Date().toISOString();
      job = null;
      setPhase(cancelled ? "cancelled" : "done", j);
    } catch (err) {
      log(`scan failed: ${(err as Error).stack ?? err}`);
      warn(`The scan stopped because of an error: ${(err as Error).message}`);
      finishedAt = new Date().toISOString();
      job = null;
      setPhase("error", j);
    }
  }

  function startScan(opts: StartScanOptions = {}, background = false): DiscoveryState {
    if (closed) throw new Error("discovery is closed");
    if (job) throw new ScanRunningError();
    const problems: { path: string; message: string }[] = [];
    const reqTargets: string[] = [];
    (opts.targets ?? []).forEach((t, i) => {
      try {
        reqTargets.push(canonicalTarget(t));
      } catch (err) {
        if (!(err instanceof TargetError)) throw err;
        problems.push({ path: `/targets/${i}`, message: err.message });
      }
    });
    const reqSubnets: string[] = [];
    (opts.subnets ?? []).forEach((s, i) => {
      try {
        parseSubnet(s);
        reqSubnets.push(s.trim());
      } catch (err) {
        if (!(err instanceof SubnetError)) throw err;
        problems.push({ path: `/subnets/${i}`, message: err.message });
      }
    });
    if (problems.length) throw new DiscoveryInputError(`Invalid scan request: ${problems[0]?.message}`, problems);

    const s = settings.get();
    const targets = [...new Set([...s.discoveryTargets, ...reqTargets])];
    const extraSubnets = [...new Set([...s.extraSubnets, ...reqSubnets])].filter((x) => {
      try {
        parseSubnet(x);
        return true;
      } catch {
        return false;
      }
    });

    extras = new Map();
    merged = new Map();
    warnings = [];
    probed = 0;
    const useMdns = opts.mdns ?? true;
    const useSweep = opts.sweep ?? true;
    // The sweep plan is known right away (the state returned by POST /api/discovery/scan already lists the subnets).
    let plan: Plan = { subnets: [], hosts: [] };
    if (useSweep) {
      try {
        const ifaces = interfaces();
        plan = buildSweepPlan(ifaces, extraSubnets);
        if (ifaces.length === 0 && extraSubnets.length === 0) warnings.push("No local IPv4 network was found, so there was nothing to sweep. Add a subnet or a target if the devices are elsewhere.");
      } catch (err) {
        warnings.push(`Sweep skipped: ${(err as Error).message}`);
      }
    }
    subnets = plan.subnets;
    total = plan.hosts.length + registry.list().length + targets.length;
    startedAt = new Date().toISOString();
    finishedAt = null;
    const ctrl = new AbortController();
    const j: Job = { ctrl, broadcast: !background, done: Promise.resolve() };
    job = j;
    setPhase("mdns", j);
    j.done = execute(j, { mdns: useMdns, sweep: useSweep }, targets, plan);
    return getState();
  }

  // ---- adopt / ignore --------------------------------------------------------------------------------------------

  const addedViaOf = (ex: Extra): AddedVia => {
    const via = viaOf(ex).split("+");
    return via.includes("mdns") ? "mdns" : via.includes("sweep") ? "sweep" : "manual"; // a hand-typed target counts as manual
  };

  // ---- waitForDevice -----------------------------------------------------------------------------------------------

  async function lookRound(id: string, o: WaitForDeviceOptions, signal: AbortSignal): Promise<FoundDevice | null> {
    let found: FoundDevice | null = null;
    const round = new AbortController();
    const stopRound = (): void => round.abort();
    signal.addEventListener("abort", stopRound, { once: true });
    const check = (e: Entry, st: DeviceStatus | null): boolean => {
      if (st && statusId(st) === id) {
        found = { host: hostOf(e), status: st };
        round.abort();
        return true;
      }
      return false;
    };
    try {
      const set = new ProbeSet();
      const targets = [...new Set([...settings.get().discoveryTargets, ...(o.targets ?? []).flatMap((t) => { try { return [canonicalTarget(t)]; } catch { return []; } })])];
      const quick = await quickEntries(set, targets, () => {}, id);
      await probeAll(quick, round.signal, check);
      if (found || round.signal.aborted) return found;

      if (o.mdns !== false && mdnsFactory) {
        const m = await browseMdns(mdnsFactory, { windowMs: mdnsWindowMs, signal: round.signal, log });
        const fresh: Entry[] = [];
        for (const c of m.candidates.slice(0, 128)) {
          const e = set.add(c.ip, c.port, "mdns", c.txt);
          if (e) fresh.push(e);
        }
        await probeAll(fresh, round.signal, check);
        if (found || round.signal.aborted) return found;
      }

      if (o.sweep !== false) {
        let plan = { subnets: [] as string[], hosts: [] as string[] };
        try {
          plan = buildSweepPlan(interfaces(), settings.get().extraSubnets.filter((x) => { try { parseSubnet(x); return true; } catch { return false; } }));
        } catch {
          /* no sweep this round */
        }
        const entries: Entry[] = [];
        for (const h of plan.hosts) {
          const e = set.add(h, sweepPort, "sweep");
          if (e) entries.push(e);
        }
        await probeAll(entries, round.signal, check);
      }
      return found;
    } finally {
      signal.removeEventListener("abort", stopRound);
    }
  }

  async function waitForDevice(rawId: string, o: WaitForDeviceOptions): Promise<FoundDevice | null> {
    const id = String(rawId).trim().toLowerCase();
    const outer = new AbortController();
    const onAbort = (): void => outer.abort();
    if (o.signal?.aborted) return null;
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => outer.abort(), Math.max(0, o.timeoutMs));
    try {
      while (!outer.signal.aborted && !closed) {
        const hit = await lookRound(id, o, outer.signal);
        if (hit) return hit;
        await sleep(o.intervalMs ?? 2000, outer.signal);
      }
      return null;
    } finally {
      clearTimeout(timeout);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }

  // ---- background scanning ---------------------------------------------------------------------------------------

  const bgConfig = (): { enabled: boolean; periodMs: number } => {
    const b = settings.get().backgroundScan;
    return { enabled: b.enabled, periodMs: cfg.backgroundPeriodMs ?? b.periodMin * 60_000 };
  };
  const timer = createBackgroundTimer({
    getConfig: bgConfig,
    tick: () => {
      const d = backgroundDecision({ enabled: bgConfig().enabled, running: job !== null, deviceCount: registry.list().length });
      if (d === "skip_many") log(`background scan skipped: more than ${BACKGROUND_MAX_DEVICES} devices are registered`);
      if (d !== "scan") return;
      try {
        startScan({}, true);
      } catch (err) {
        log(`background scan could not start: ${(err as Error).message}`);
      }
    },
  });
  let bgKey = JSON.stringify(bgConfig());
  const offSettings = settings.onChange(() => {
    const key = JSON.stringify(bgConfig());
    if (key === bgKey) return;
    bgKey = key;
    timer.reschedule();
  });
  timer.reschedule();

  return {
    startScan: (opts) => startScan(opts),
    async cancelScan() {
      const j = job;
      if (j) {
        j.ctrl.abort();
        await j.done;
      }
      return getState();
    },
    getState,
    ignore(id) {
      registry.ignore(id);
      emit("progress");
      return getState();
    },
    unignore(id) {
      registry.unignore(id);
      emit("progress");
      return getState();
    },
    async adopt(ids) {
      const added: string[] = [];
      const skipped: { id: string; reason: "unknown_id" | "already_known" }[] = [];
      for (const raw of [...new Set(ids.map((i) => String(i).trim().toLowerCase()))]) {
        const ex = extras.get(raw);
        if (!ex) {
          skipped.push({ id: raw, reason: "unknown_id" });
          continue;
        }
        if (registry.get(raw)) {
          skipped.push({ id: raw, reason: "already_known" });
          continue;
        }
        const r = toResult(ex);
        registry.upsert({ id: raw, host: r.host, hostname: r.hostname, name: r.name || r.hostname, addedVia: addedViaOf(ex) });
        registry.unignore(raw);
        added.push(raw);
      }
      await Promise.all(added.map((id) => health.pollNow(id)));
      emit("progress");
      return { added, skipped };
    },
    waitForDevice,
    async close() {
      closed = true;
      timer.stop();
      offSettings();
      if (trailing) clearTimeout(trailing);
      trailing = null;
      const j = job;
      if (j) {
        j.ctrl.abort();
        await j.done;
      }
    },
  };
}
