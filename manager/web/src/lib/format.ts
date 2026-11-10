import type { AttentionFlag, DeviceHealth, DeviceSummary, LinkState } from "@shared/api";
import type { Tone } from "../components/ui/Chip";

type Titled = Pick<DeviceSummary, "id" | "label" | "name" | "hostname">;

/** Display name: the Manager label, else the device name, else its hostname, else the id. */
export function deviceTitle(d: Titled): string {
  return d.label || d.name || d.hostname || d.id;
}

/** `hostname · host`, skipping an empty hostname. */
export function deviceSubtitle(d: Pick<DeviceSummary, "hostname" | "host">): string {
  return [d.hostname, d.host].filter(Boolean).join(" · ");
}

/** "just now", "5 s ago", "3 min ago", "2 h ago", "4 days ago"; "never" for null/invalid input. */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** "3 d 4 h", "2 h 5 min", "12 min", "45 s"; "-" for null. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.floor(seconds);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** "512 B", "148 KB", "1.5 MB" (1024 based); "-" for null. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Signal strength: `label` is "-58 dBm · Good", `bars` 0 to 4. */
export function formatRssi(dbm: number | null | undefined): { label: string; bars: 0 | 1 | 2 | 3 | 4 } {
  if (dbm == null || !Number.isFinite(dbm)) return { label: "No signal", bars: 0 };
  let word: string;
  let bars: 0 | 1 | 2 | 3 | 4;
  if (dbm >= -55) [word, bars] = ["Excellent", 4];
  else if (dbm >= -65) [word, bars] = ["Good", 3];
  else if (dbm >= -75) [word, bars] = ["Fair", 2];
  else if (dbm >= -85) [word, bars] = ["Weak", 1];
  else [word, bars] = ["Very weak", 0];
  return { label: `${Math.round(dbm)} dBm · ${word}`, bars };
}

const HEALTH_LABEL: Record<DeviceHealth, string> = {
  unknown: "Checking",
  online: "Online",
  unreachable: "Unreachable",
  offline: "Offline",
  rebooting: "Restarting",
  updating: "Updating",
};
const HEALTH_TONE: Record<DeviceHealth, Tone> = {
  unknown: "off",
  online: "ok",
  unreachable: "warn",
  offline: "bad",
  rebooting: "acc",
  updating: "acc",
};

export function healthLabel(h: DeviceHealth): string {
  return HEALTH_LABEL[h] ?? h;
}
/** Tone for `<Chip tone>` / `<Dot>`. */
export function healthTone(h: DeviceHealth): Tone {
  return HEALTH_TONE[h] ?? "off";
}

const ATTENTION_LABEL: Record<AttentionFlag, string> = {
  safe_mode: "Safe mode",
  boot_unhealthy: "Last boot was not healthy",
  memory_pressure: "Low memory",
  alloc_failed: "Memory allocation failed",
  ota_pending_verify: "Update waiting to be confirmed",
  ota_error: "Update problem",
  mqtt_disconnected: "MQTT disconnected",
  wifi_recovery: "Wi-Fi recovery in progress",
  host_mismatch: "Another device answers at this address",
};

export function attentionLabel(flag: AttentionFlag): string {
  return ATTENTION_LABEL[flag] ?? String(flag).replace(/_/g, " ");
}

const LINK_LABEL: Record<LinkState, string> = {
  open: "Live",
  connecting: "Connecting",
  full: "WS full · polling",
  closed: "Not live",
};

export function linkLabel(link: LinkState): string {
  return LINK_LABEL[link] ?? link;
}
