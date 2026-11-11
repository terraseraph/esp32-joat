/**
 * Fake device: OPT-IN emulation of the PENDING firmware (branch `claude/wifi-change-fallback-ab5ac7`, unmerged,
 * untested on hardware; spec §2.9). Enabled with `FakeDeviceOptions.pendingFirmware` (CLI `--pending-firmware`).
 * With the flag off nothing in here runs and every payload is byte-identical to current `main` firmware.
 *
 * Covers: `wifi_change` on the network status, static IP (`network.ip.set` / `network.ip.confirm`, `ip_mode`,
 * `netmask`, `gateway`, `dns`, `ap_clients`, `ip_change`) with the apply-delay / confirm-window / revert behaviour.
 *
 * LIMITATION: a fake device listens on one loopback port and cannot really move to a new IP. The "new address" is
 * state only (`network.sta_ip` and friends change; the HTTP listener does not). Code under test that must reach the
 * device at its new address needs a second listener (a later batch may add one).
 *
 * Error strings: the README (`network_manager_README.md`, "Static IP") lists the refusal CONDITIONS but not their
 * text, so every message here is invented and marked as such.
 */
import type { IpChange, IpMode, NetworkStatus, WifiChangeReason } from "../src/types/device-api";
import type { FakeState, ResolvedOptions } from "./state";

// ---------------------------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------------------------

/** Injectable time source for the pending-firmware timers (apply delay, confirm window), so tests need not wait 90 s. */
export interface FakeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: FakeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

export interface IpConfig {
  mode: IpMode;
  ip: string;
  netmask: string;
  gateway: string;
  dns: string;
}

export interface FakePending {
  clock: FakeClock;
  applyDelayMs: number;
  confirmWindowMs: number;
  /** What the DHCP server hands out (the device's address before any static config). */
  dhcp: IpConfig;
  /** The persisted config (NVS): survives reboots; only changed by a confirm, a DHCP switch or a Wi-Fi change. */
  saved: IpConfig;
  /** The config being tried by the pending `network.ip.set`. */
  target?: IpConfig;
  wifiSeq: number;
  ipSeq: number;
  wifiTesting: boolean;
  applyTimer?: unknown;
  revertTimer?: unknown;
  /** `clock.now()` at which an applied, unconfirmed change reverts. */
  deadline: number;
}

type Notify = () => void;

export function createPending(o: ResolvedOptions): FakePending {
  const dhcp: IpConfig = { mode: "dhcp", ip: "192.168.1.42", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: "192.168.1.1" };
  return {
    clock: o.clock,
    applyDelayMs: o.ipApplyDelayMs,
    confirmWindowMs: o.ipConfirmWindowMs,
    dhcp,
    saved: { ...dhcp },
    wifiSeq: 0,
    ipSeq: 0,
    wifiTesting: false,
    deadline: 0,
  };
}

/** Initial extra network fields of a pending-firmware device. */
export function initialNetworkFields(p: FakePending): Partial<NetworkStatus> {
  return {
    wifi_change: { result: "none" },
    ip_mode: "dhcp",
    netmask: p.dhcp.netmask,
    gateway: p.dhcp.gateway,
    dns: p.dhcp.dns,
    ap_clients: 0,
    ip_change: { result: "none" },
  };
}

const uptime = (state: FakeState): number => Math.max(0, Math.floor((Date.now() - state.bootAt) / 1000));

/** Make `cfg` the live STA config (what `ip_mode`/`netmask`/`gateway`/`dns`/`sta_ip` report). */
function liveFromConfig(state: FakeState, cfg: IpConfig): void {
  const net = state.network;
  net.ip_mode = cfg.mode;
  if (net.sta_connected) {
    net.sta_ip = cfg.mode === "static" ? cfg.ip : state.pending!.dhcp.ip;
    net.netmask = cfg.netmask;
    net.gateway = cfg.gateway;
    net.dns = cfg.dns;
  } else {
    net.netmask = "";
    net.gateway = "";
    net.dns = "";
  }
}

function clearTimers(p: FakePending): void {
  if (p.applyTimer !== undefined) p.clock.clearTimeout(p.applyTimer);
  if (p.revertTimer !== undefined) p.clock.clearTimeout(p.revertTimer);
  p.applyTimer = undefined;
  p.revertTimer = undefined;
}

/** Cancel every timer (device closed). */
export function disposePending(state: FakeState): void {
  if (state.pending) clearTimers(state.pending);
}

/** Serializer hook: a copy of the network status with `confirm_left_s` computed from the clock. */
export function decorateNetwork(state: FakeState, out: NetworkStatus): NetworkStatus {
  const p = state.pending;
  if (!p) return out;
  if (out.wifi_change) out.wifi_change = { ...out.wifi_change };
  if (out.ip_change) {
    const ic: IpChange = { ...out.ip_change };
    if (ic.applied) ic.confirm_left_s = Math.max(0, Math.ceil((p.deadline - p.clock.now()) / 1000));
    out.ip_change = ic;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (`parse_ip4`, `validate_static` in the README)
// ---------------------------------------------------------------------------------------------------------------

/** Strict dotted quad (no leading zeros) to an unsigned 32-bit number, or `null`. */
export function parseIp4(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v;
}

const maskOf = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** Prefix length of a contiguous netmask in /1../30, else `null`. */
function prefixOf(mask: number): number | null {
  for (let p = 1; p <= 30; p++) if (maskOf(p) === mask) return p;
  return null;
}

/** Unicast host address: not 0.x.x.x, not loopback, not multicast/reserved. */
function isUnicast(a: number): boolean {
  const first = Math.floor(a / 0x1000000);
  return first !== 0 && first !== 127 && first < 224;
}

const SOFTAP_NET = 0xc0a80400; // 192.168.4.0/24

/** Validate a static config exactly like the README rules; returns the config or an (invented) error message. */
export function validateStatic(req: { ip?: unknown; netmask?: unknown; gateway?: unknown; dns?: unknown }): IpConfig | string {
  const ip = parseIp4(req.ip);
  if (ip === null) return "ip must be a dotted-quad IPv4 address";
  const mask = parseIp4(req.netmask);
  if (mask === null) return "netmask must be a dotted-quad IPv4 address";
  const gw = parseIp4(req.gateway);
  if (gw === null) return "gateway must be a dotted-quad IPv4 address";
  const prefix = prefixOf(mask);
  if (prefix === null) return "netmask must be contiguous, /1 to /30";
  if (!isUnicast(ip)) return "ip must be a unicast host address";
  if (!isUnicast(gw)) return "gateway must be a unicast host address";
  if (((ip & mask) >>> 0) !== ((gw & mask) >>> 0)) return "gateway must be in the same subnet as ip";
  if (ip === gw) return "ip and gateway must be different";
  const host = (a: number): number => (a & ~mask) >>> 0;
  const bcast = (~mask) >>> 0;
  for (const [label, a] of [["ip", ip], ["gateway", gw]] as const) {
    if (host(a) === 0 || host(a) === bcast) return `${label} must not be the network or broadcast address`;
  }
  const wide = maskOf(Math.min(prefix, 24));
  if (((ip & wide) >>> 0) === ((SOFTAP_NET & wide) >>> 0)) return "subnet must not overlap 192.168.4.0/24";
  let dnsText = String(req.gateway);
  if (req.dns !== undefined && req.dns !== "") {
    const dns = parseIp4(req.dns);
    if (dns === null || !isUnicast(dns)) return "dns must be a unicast IPv4 address";
    dnsText = String(req.dns);
  }
  return { mode: "static", ip: String(req.ip), netmask: String(req.netmask), gateway: String(req.gateway), dns: dnsText };
}

// ---------------------------------------------------------------------------------------------------------------
// network.ip.set / network.ip.confirm
// ---------------------------------------------------------------------------------------------------------------

/**
 * Handle `network.ip.set`. Returns an error message (refusal) or `null` after scheduling the apply. The caller
 * replies with the network status (`ip_change.result` is `pending`, `applied` false) straight away.
 */
export function ipSet(state: FakeState, req: Record<string, unknown>, notify: Notify): string | null {
  const p = state.pending!;
  const net = state.network;
  if (req.mode !== "static" && req.mode !== "dhcp") return "mode must be static or dhcp";
  if (!net.provisioned) return "no saved wifi network";
  if (p.wifiTesting) return "wifi change in progress";
  if (net.ip_change?.result === "pending") return "ip change already pending";
  let target: IpConfig;
  if (req.mode === "static") {
    if (!net.sta_connected) return "station not connected";
    const v = validateStatic(req);
    if (typeof v === "string") return v;
    target = v;
  } else {
    target = { ...p.dhcp, mode: "dhcp" };
  }
  const seq = ++p.ipSeq;
  const record: IpChange = { result: "pending", mode: target.mode };
  if (target.mode === "static") Object.assign(record, { ip: target.ip, netmask: target.netmask, gateway: target.gateway, dns: target.dns });
  if (target.mode === "dhcp" && !net.sta_connected) {
    // Offline switch to DHCP: saved at once, nothing to confirm against.
    p.saved = target;
    liveFromConfig(state, target);
    net.ip_change = { ...record, result: "ok", reason: "offline", applied: false, uptime_s: uptime(state), time: 0, seq };
    return null;
  }
  net.ip_change = { ...record, applied: false, uptime_s: uptime(state), time: 0, seq };
  p.target = target;
  p.applyTimer = p.clock.setTimeout(() => applyChange(state, notify), p.applyDelayMs);
  return null;
}

/** About `ipApplyDelayMs` after the reply the device applies the config. */
function applyChange(state: FakeState, notify: Notify): void {
  const p = state.pending!;
  const net = state.network;
  p.applyTimer = undefined;
  const target = p.target;
  if (!target || net.ip_change?.result !== "pending") return;
  liveFromConfig(state, target);
  if (target.mode === "dhcp") {
    // A switch to DHCP confirms itself when the lease arrives.
    p.saved = target;
    net.ip_change = { ...net.ip_change, result: "ok", reason: "dhcp_lease", applied: false };
  } else {
    net.ip_change = { ...net.ip_change, applied: true };
    p.deadline = p.clock.now() + p.confirmWindowMs;
    p.revertTimer = p.clock.setTimeout(() => revertChange(state, notify), p.confirmWindowMs);
  }
  notify();
}

/** No confirm in time: restore the previous (saved) config. */
function revertChange(state: FakeState, notify: Notify): void {
  const p = state.pending!;
  p.revertTimer = undefined;
  const ic = state.network.ip_change;
  if (!ic || ic.result !== "pending") return;
  liveFromConfig(state, p.saved);
  const { confirm_left_s: _drop, ...rest } = ic;
  void _drop;
  state.network.ip_change = { ...rest, result: "reverted", reason: "not_confirmed", applied: false };
  notify();
}

/** Handle `network.ip.confirm`. Returns an error message or `null`. */
export function ipConfirm(state: FakeState, req: Record<string, unknown>, notify: Notify): string | null {
  const p = state.pending!;
  const ic = state.network.ip_change;
  if (!ic || ic.result !== "pending") return "no ip change to confirm";
  if (!ic.applied) return "ip change not applied yet";
  if (req.seq !== undefined && req.seq !== ic.seq) return "seq does not match ip_change.seq";
  if (p.revertTimer !== undefined) p.clock.clearTimeout(p.revertTimer);
  p.revertTimer = undefined;
  if (p.target) p.saved = p.target;
  const { confirm_left_s: _drop, ...rest } = ic;
  void _drop;
  state.network.ip_change = { ...rest, result: "ok", reason: "confirmed", applied: false };
  notify();
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Wi-Fi change interplay
// ---------------------------------------------------------------------------------------------------------------

/** What `network.wifi.set` must be able to put back when the test fails. */
export interface WifiSnapshot {
  state: NetworkStatus["state"];
  sta_ip: string;
  sta_connected: boolean;
  rssi: number;
  provisioned: boolean;
}

/** Failure reason by SSID, for tests: `noap` no_ap, `noip` no_ip, `timeout` timeout, `connect` connect_failed, `savefail` save_failed, else auth. */
export function wifiFailReason(ssid: string): WifiChangeReason {
  switch (ssid) {
    case "noap":
      return "no_ap";
    case "noip":
      return "no_ip";
    case "timeout":
      return "timeout";
    case "connect":
      return "connect_failed";
    case "savefail":
      return "save_failed";
    default:
      return "auth";
  }
}

const DISCONNECT_REASON: Record<WifiChangeReason, number> = { auth: 15, no_ap: 201, no_ip: 0, timeout: 0, connect_failed: 205, save_failed: 0 };

/** A Wi-Fi test starts: cancel an unconfirmed IP change (`reverted`, `wifi_change`) and record `testing`. */
export function wifiStart(state: FakeState, ssid: string, notify: Notify): WifiSnapshot {
  const p = state.pending!;
  const net = state.network;
  const snap: WifiSnapshot = { state: net.state, sta_ip: net.sta_ip, sta_connected: net.sta_connected, rssi: net.rssi, provisioned: net.provisioned };
  const ic = net.ip_change;
  if (ic && ic.result === "pending") {
    clearTimers(p);
    liveFromConfig(state, p.saved);
    const { confirm_left_s: _drop, ...rest } = ic;
    void _drop;
    net.ip_change = { ...rest, result: "reverted", reason: "wifi_change", applied: false };
  }
  p.wifiTesting = true;
  net.wifi_change = { result: "testing", ssid, uptime_s: uptime(state), time: 0, seq: ++p.wifiSeq };
  notify();
  return snap;
}

/** The test failed: back to the saved network with its saved IP mode (static included). */
export function wifiFailed(state: FakeState, ssid: string, reason: WifiChangeReason, snap: WifiSnapshot): void {
  const p = state.pending!;
  const net = state.network;
  p.wifiTesting = false;
  net.wifi_change = {
    result: "failed",
    ssid,
    reason,
    disconnect_reason: DISCONNECT_REASON[reason],
    restored_previous: snap.provisioned && reason !== "save_failed",
    uptime_s: uptime(state),
    time: 0,
    seq: p.wifiSeq,
  };
  if (snap.provisioned) {
    net.state = snap.state;
    net.sta_ip = snap.sta_ip;
    net.sta_connected = snap.sta_connected;
    net.rssi = snap.rssi;
    liveFromConfig(state, p.saved);
  } else {
    // First-time provisioning: nothing to go back to, the SoftAP and captive portal stay up.
    net.state = "ap_only";
    net.sta_ip = "";
    net.sta_connected = false;
    liveFromConfig(state, p.saved);
  }
}

/** The test succeeded: the new network starts on DHCP (a dropped static config is reported as `reset`). */
export function wifiSucceeded(state: FakeState, ssid: string): void {
  const p = state.pending!;
  const net = state.network;
  p.wifiTesting = false;
  net.wifi_change = { result: "ok", ssid, uptime_s: uptime(state), time: 0, seq: p.wifiSeq };
  if (p.saved.mode === "static") {
    p.saved = { ...p.dhcp };
    net.ip_change = { result: "reset", reason: "wifi_change", mode: "dhcp", applied: false, uptime_s: uptime(state), time: 0, seq: ++p.ipSeq };
  }
  liveFromConfig(state, p.saved);
}

/** `network.wifi.clear` and factory reset go back to DHCP. */
export function resetToDhcp(state: FakeState): void {
  const p = state.pending;
  if (!p) return;
  clearTimers(p);
  p.saved = { ...p.dhcp };
  p.wifiTesting = false;
  const ic = state.network.ip_change;
  if (ic && ic.result === "pending") {
    const { confirm_left_s: _drop, ...rest } = ic;
    void _drop;
    state.network.ip_change = { ...rest, result: "reverted", reason: "wifi_change", applied: false };
  }
  liveFromConfig(state, p.saved);
}

/** Reboot: RAM records are lost, an unconfirmed static config is gone, the saved config applies. */
export function pendingOnBoot(state: FakeState): void {
  const p = state.pending;
  if (!p) return;
  clearTimers(p);
  p.wifiTesting = false;
  state.network.wifi_change = { result: "none" };
  state.network.ip_change = { result: "none" };
  liveFromConfig(state, p.saved);
}
