import type { AttentionFlag, DeviceSummary } from "@shared/api";
import { attentionLabel, deviceTitle, formatAgo } from "../../lib/format";

export type FleetFilter = "all" | "online" | "offline" | "attention" | "differs";
export type FleetSort = "name" | "health" | "seen" | "uptime" | "rssi";
export type FleetView = "cards" | "table";

export const SORT_OPTIONS: { value: FleetSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "health", label: "Health" },
  { value: "seen", label: "Last seen" },
  { value: "uptime", label: "Uptime" },
  { value: "rssi", label: "RSSI" },
];

/** Offline and unreachable are the two "cannot talk to it right now" states. */
export function isOffline(d: Pick<DeviceSummary, "health">): boolean {
  return d.health === "offline" || d.health === "unreachable";
}

export function isOnline(d: Pick<DeviceSummary, "health">): boolean {
  return d.health === "online";
}

export function needsAttention(d: Pick<DeviceSummary, "attention">): boolean {
  return d.attention.length > 0;
}

/** True only when the device is known to differ from the chosen target firmware. */
export function differsFromTarget(d: Pick<DeviceSummary, "fwMatchesTarget">): boolean {
  return d.fwMatchesTarget === false;
}

export interface FleetSummary {
  total: number;
  online: number;
  /** offline + unreachable */
  offline: number;
  offlineOnly: number;
  unreachable: number;
  attention: number;
  /** Online devices that also need attention. */
  onlineAttention: number;
  /** `null` until at least one device has a firmware verdict (no target chosen yet). */
  differs: number | null;
  /** Distinct attention flags across the fleet, most common first. */
  flags: AttentionFlag[];
}

export function summarize(list: readonly DeviceSummary[]): FleetSummary {
  let online = 0;
  let offlineOnly = 0;
  let unreachable = 0;
  let attention = 0;
  let onlineAttention = 0;
  let differs = 0;
  let known = false;
  const flagCount = new Map<AttentionFlag, number>();
  for (const d of list) {
    if (d.health === "online") online++;
    else if (d.health === "offline") offlineOnly++;
    else if (d.health === "unreachable") unreachable++;
    if (needsAttention(d)) {
      attention++;
      if (isOnline(d)) onlineAttention++;
      for (const f of d.attention) flagCount.set(f, (flagCount.get(f) ?? 0) + 1);
    }
    if (d.fwMatchesTarget !== null) known = true;
    if (differsFromTarget(d)) differs++;
  }
  const flags = [...flagCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  return {
    total: list.length,
    online,
    offline: offlineOnly + unreachable,
    offlineOnly,
    unreachable,
    attention,
    onlineAttention,
    differs: known ? differs : null,
    flags,
  };
}

export function matchesFilter(d: DeviceSummary, filter: FleetFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "online":
      return isOnline(d);
    case "offline":
      return isOffline(d);
    case "attention":
      return needsAttention(d);
    case "differs":
      return differsFromTarget(d);
  }
}

/** Case-insensitive match on name, label, hostname, host/IP and id. An empty query matches everything. */
export function matchesSearch(d: DeviceSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [deviceTitle(d), d.label, d.name, d.hostname, d.host, d.id].some((s) => s.toLowerCase().includes(q));
}

export function filterDevices(list: readonly DeviceSummary[], filter: FleetFilter, query: string): DeviceSummary[] {
  return list.filter((d) => matchesFilter(d, filter) && matchesSearch(d, query));
}

/** Per-filter counts for the chips (search is not applied: the chips describe the fleet). */
export function filterCounts(list: readonly DeviceSummary[]): Record<FleetFilter, number | null> {
  const s = summarize(list);
  return { all: s.total, online: s.online, offline: s.offline, attention: s.attention, differs: s.differs };
}

/** Lower = needs a look sooner: offline, unreachable, in transition, online with attention, healthy. */
export function healthRank(d: DeviceSummary): number {
  switch (d.health) {
    case "offline":
      return 0;
    case "unreachable":
      return 1;
    case "unknown":
    case "rebooting":
    case "updating":
      return 2;
    case "online":
      return needsAttention(d) ? 3 : 4;
  }
}

const byName = (a: DeviceSummary, b: DeviceSummary) => {
  const ka = deviceTitle(a).toLowerCase();
  const kb = deviceTitle(b).toLowerCase();
  return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Larger first, `null` always last. */
function desc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function seenMs(d: DeviceSummary): number | null {
  if (!d.lastSeen) return null;
  const t = Date.parse(d.lastSeen);
  return Number.isNaN(t) ? null : t;
}

/** Uptime of a device that is not reachable is stale, so it sorts as unknown. */
function uptimeOf(d: DeviceSummary): number | null {
  return isOffline(d) ? null : d.uptime_s;
}

function rssiOf(d: DeviceSummary): number | null {
  return isOffline(d) ? null : d.rssi;
}

/** New array; ties fall back to name so the order is stable while values tick. */
export function sortDevices(list: readonly DeviceSummary[], sort: FleetSort): DeviceSummary[] {
  const out = [...list];
  out.sort((a, b) => {
    let c = 0;
    switch (sort) {
      case "name":
        break;
      case "health":
        c = healthRank(a) - healthRank(b);
        break;
      case "seen":
        c = desc(seenMs(a), seenMs(b));
        break;
      case "uptime":
        c = desc(uptimeOf(a), uptimeOf(b));
        break;
      case "rssi":
        c = desc(rssiOf(a), rssiOf(b));
        break;
    }
    return c || byName(a, b);
  });
  return out;
}

export type AttentionTone = "none" | "warn" | "bad";

export interface AttentionText {
  tone: AttentionTone;
  /** `alert` for problems, `clock` for last-seen lines, `none` for "No issues". */
  icon: "alert" | "clock" | "none";
  text: string;
}

const BAD_FLAGS: ReadonlySet<AttentionFlag> = new Set(["safe_mode", "alloc_failed", "ota_error"]);

/** The one plain-words line under a card title. */
export function attentionText(d: DeviceSummary, now: number = Date.now()): AttentionText {
  const ago = formatAgo(d.lastSeen, now);
  if (d.health === "offline") return { tone: "none", icon: "clock", text: `Last seen ${ago}` };
  if (d.health === "unreachable") return { tone: "warn", icon: "alert", text: `Not answering · last seen ${ago}` };
  if (d.health === "rebooting") return { tone: "none", icon: "clock", text: "Restarting, it will be back in a few seconds" };
  if (d.health === "updating") return { tone: "none", icon: "clock", text: "Updating firmware" };
  if (d.health === "unknown") return { tone: "none", icon: "clock", text: "Checking this device" };
  if (d.attention.length === 0) return { tone: "none", icon: "none", text: "No issues" };
  const parts = d.attention.map((f) => (f === "safe_mode" && d.safe_reason ? `${attentionLabel(f)}: ${d.safe_reason}` : attentionLabel(f)));
  return { tone: d.attention.some((f) => BAD_FLAGS.has(f)) ? "bad" : "warn", icon: "alert", text: parts.join(" · ") };
}

export type MemoryTone = "ok" | "warn" | "bad";

/** `null` when the device has not reported memory. */
export function memoryInfo(d: DeviceSummary): { tone: MemoryTone; label: string } | null {
  const p = d.memory.pressure;
  if (p === null) return null;
  const tone: MemoryTone = p === "ok" ? "ok" : p === "warn" ? "warn" : "bad";
  const word = p === "ok" ? "OK" : p === "warn" ? "warn" : p;
  return { tone, label: word };
}

export function mqttInfo(d: DeviceSummary): { tone: "ok" | "warn" | "off"; label: string } | null {
  const { configured, connected } = d.mqtt;
  if (connected === true) return { tone: "ok", label: "connected" };
  if (configured === true) return { tone: "warn", label: "disconnected" };
  if (configured === false) return { tone: "off", label: "not set" };
  return null;
}

/** "Workshop node, Greenhouse and 2 more" for confirm dialogs. */
export function nameList(list: readonly DeviceSummary[], max = 5): string {
  const names = list.map(deviceTitle);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

// ---- remembered view and sort --------------------------------------------------------------------------

export interface FleetPrefs {
  view: FleetView;
  sort: FleetSort;
}

export const PREFS_KEY = "deesp32-fleet-prefs";
export const DEFAULT_PREFS: FleetPrefs = { view: "cards", sort: "name" };

export function loadPrefs(): FleetPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<FleetPrefs> | null;
    const view = p?.view === "table" || p?.view === "cards" ? p.view : DEFAULT_PREFS.view;
    const sort = SORT_OPTIONS.some((o) => o.value === p?.sort) ? (p?.sort as FleetSort) : DEFAULT_PREFS.sort;
    return { view, sort };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: FleetPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}
