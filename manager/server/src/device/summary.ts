import type { AttentionFlag, DeviceHealth, DeviceSummary, LinkState } from "../types/api";
import type { DeviceStatus } from "../types/device-api";
import type { LastSummary, RegistryDevice, RegistryStore } from "../store/registry";

/** Attention flags derived from a `/status` payload (spec 3.4). Tolerates missing blocks (older firmware). */
export function attentionFromStatus(status: DeviceStatus): AttentionFlag[] {
  const flags: AttentionFlag[] = [];
  if (status.safe_mode) flags.push("safe_mode");
  if (status.boot_state !== "healthy") flags.push("boot_unhealthy");
  if (status.memory && status.memory.pressure !== "ok") flags.push("memory_pressure");
  if (status.memory?.alloc_failed) flags.push("alloc_failed");
  if (status.ota?.image_state === "pending_verify") flags.push("ota_pending_verify");
  if (status.ota?.session === "error") flags.push("ota_error");
  if (status.mqtt && typeof status.mqtt.uri === "string" && status.mqtt.uri !== "" && !status.mqtt.connected) flags.push("mqtt_disconnected");
  if (status.network?.state === "apsta_recovery") flags.push("wifi_recovery");
  return flags;
}

/** The cached summary stored in the registry after each successful poll (spec 3.2 `last`, plus a few extras). */
export function lastFromStatus(status: DeviceStatus): LastSummary {
  const io = status.io && typeof status.io === "object" ? Object.keys(status.io) : [];
  const last: LastSummary = {
    fw: status.fw,
    app_version: status.ota?.app_version,
    compile_date: status.ota?.compile_date,
    boot_state: status.boot_state,
    safe_mode: Boolean(status.safe_mode),
    safe_reason: status.safe_reason ?? "",
    uptime_s: status.uptime_s,
    rssi: status.network?.rssi,
    net_state: status.network?.state,
    pressure: status.memory?.pressure,
    mem_free: status.memory?.internal?.free,
    mem_total: status.memory?.internal?.total,
    mqtt_configured: typeof status.mqtt?.uri === "string" && status.mqtt.uri !== "",
    mqtt_connected: Boolean(status.mqtt?.connected),
    running_partition: status.ota?.running_partition,
    image_state: status.ota?.image_state,
    rollback_possible: status.ota?.rollback_possible,
    ota_busy: status.ota?.busy,
    io_count: io.filter((k) => !k.startsWith("mod_")).length,
    module_count: io.filter((k) => k.startsWith("mod_")).length,
    attention: attentionFromStatus(status),
    ip_mode: status.network?.ip_mode === "dhcp" || status.network?.ip_mode === "static" ? status.network.ip_mode : undefined,
  };
  // Not in the typed cache schema (it allows extra keys): the compile time, so the target comparison can use date and time.
  if (status.ota?.compile_time) (last as Record<string, unknown>).compile_time = status.ota.compile_time;
  // Drop undefined so the registry JSON stays tidy (a field the device did not send is simply absent).
  for (const k of Object.keys(last)) if ((last as Record<string, unknown>)[k] === undefined) delete (last as Record<string, unknown>)[k];
  return last;
}

export interface SummaryInput {
  device: RegistryDevice;
  health: DeviceHealth;
  /** Extra Manager-derived flags (host_mismatch). */
  extraAttention?: AttentionFlag[];
  queue: number;
  /** Device WebSocket link state (default `closed`). */
  link?: LinkState;
  /** The target firmware, when one is chosen (drives `fwMatchesTarget`). */
  target?: FirmwareTargetInfo | null;
}

/** What the comparison with a device needs to know about the target image. */
export interface FirmwareTargetInfo {
  version: string;
  date: string;
  time: string;
}

/** true/false by comparing `app_version` and the compile date/time; null without a target or before the device reported a version. */
export function matchesTarget(last: { app_version?: string; compile_date?: string; compile_time?: string }, target: FirmwareTargetInfo | null | undefined): boolean | null {
  if (!target || !last.app_version) return null;
  if (last.app_version !== target.version) return false;
  if (last.compile_date !== undefined && last.compile_date !== target.date) return false;
  if (last.compile_time !== undefined && last.compile_time !== target.time) return false;
  return true;
}

const n =<T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** Build the spec 3.10 object from the registry entry (whose `last` cache mirrors the latest status) and the live health. */
export function buildSummary(input: SummaryInput): DeviceSummary {
  const { device: d } = input;
  const last = d.last ?? {};
  const attention = [...((last.attention ?? []) as AttentionFlag[]), ...(input.extraAttention ?? [])];
  return {
    id: d.id,
    name: d.name,
    label: d.label,
    notes: d.notes,
    hostname: d.hostname,
    host: d.host,
    addedAt: d.addedAt,
    addedVia: d.addedVia,
    health: input.health,
    attention: [...new Set(attention)],
    lastSeen: n(d.lastSeen),
    fw: n(last.fw),
    app_version: n(last.app_version),
    compile_date: n(last.compile_date),
    fwMatchesTarget: matchesTarget(last as { app_version?: string; compile_date?: string; compile_time?: string }, input.target),
    uptime_s: n(last.uptime_s),
    boot_state: n(last.boot_state),
    safe_mode: n(last.safe_mode),
    safe_reason: n(last.safe_reason),
    rssi: n(last.rssi),
    net_state: n(last.net_state),
    mqtt: { configured: n(last.mqtt_configured), connected: n(last.mqtt_connected) },
    memory: { pressure: n(last.pressure), free: n(last.mem_free), total: n(last.mem_total) },
    ota: {
      running_partition: n(last.running_partition),
      image_state: n(last.image_state),
      rollback_possible: n(last.rollback_possible),
      busy: n(last.ota_busy),
    },
    io_count: n(last.io_count),
    module_count: n(last.module_count),
    ip_mode: n(last.ip_mode),
    link: input.link ?? "closed",
    queue: input.queue,
  };
}

/** Display title used for sorting: label, else name, else hostname, else id. */
export function titleOf(s: Pick<DeviceSummary, "label" | "name" | "hostname" | "id">): string {
  return s.label || s.name || s.hostname || s.id;
}

export interface Summaries {
  get(id: string): DeviceSummary | undefined;
  /** Sorted by title. */
  list(): DeviceSummary[];
  /** The firmware feature registers where the target image comes from (late-bound: summaries exist before it). */
  setTargetSource(fn: () => FirmwareTargetInfo | null): void;
}

export function createSummaries(deps: {
  registry: RegistryStore;
  health: { stateOf(id: string): { health: DeviceHealth; hostMismatch: boolean } };
  queueDepth(id: string): number;
  linkState?(id: string): LinkState;
}): Summaries {
  let targetSource: () => FirmwareTargetInfo | null = () => null;
  const build = (d: RegistryDevice): DeviceSummary => {
    const st = deps.health.stateOf(d.id);
    return buildSummary({
      target: targetSource(),
      device: d,
      health: st.health,
      extraAttention: st.hostMismatch ? ["host_mismatch"] : [],
      queue: deps.queueDepth(d.id),
      link: deps.linkState?.(d.id) ?? "closed",
    });
  };
  return {
    setTargetSource(fn) {
      targetSource = fn;
    },
    get(id) {
      const d = deps.registry.get(id);
      return d ? build(d) : undefined;
    },
    list() {
      return deps.registry
        .list()
        .map(build)
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
    },
  };
}
