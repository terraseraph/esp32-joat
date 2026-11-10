import type { DeviceSummary, DiscoveryResult } from "@shared/api";

/** Name shown for a scan result: its name, else hostname, else id. */
export function resultTitle(r: Pick<DiscoveryResult, "name" | "hostname" | "id">): string {
  return r.name || r.hostname || r.id;
}

/** Secondary line parts: `hostname · address` (the hostname is dropped when it already is the title). */
export function resultSub(r: DiscoveryResult): string[] {
  const title = resultTitle(r);
  return [r.hostname && r.hostname !== title ? r.hostname : null, r.host].filter((p): p is string => Boolean(p));
}

const VIA_LABEL: Record<string, string> = { mdns: "mDNS", sweep: "sweep", target: "address", registry: "fleet" };

/** `mdns+sweep` -> `["mDNS", "sweep"]` (unknown sources are shown as they are). */
export function viaLabels(via: string): string[] {
  return via
    .split("+")
    .filter(Boolean)
    .map((v) => VIA_LABEL[v] ?? v);
}

export function deviceTitle(d: Pick<DeviceSummary, "label" | "name" | "hostname" | "id">): string {
  return d.label || d.name || d.hostname || d.id;
}

/** "just now", "4 min ago", "2 h ago", "3 d ago". */
export function formatAgo(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
