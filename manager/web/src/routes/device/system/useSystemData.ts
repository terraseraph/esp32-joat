import type { DeviceSummary } from "@shared/api";
import type { BootState, DeviceStatus, MemoryInfo, OtaProgress, OtaStatus, TelemetrySnapshot } from "@shared/device-api";
import { useEffect, useState } from "react";
import { useDeviceResource } from "../../../api/commands";
import { useDeviceEvent, useDeviceLive } from "../../../api/live";
import { createStore } from "../../../api/store";

/** Poll interval for memory / uptime while the device WebSocket is not delivering telemetry. */
export const REFRESH_MS = 15_000;

export interface SystemData {
  /** Last good `GET /status` (kept while a reload is running or failed). */
  status: DeviceStatus | null;
  ota: OtaStatus | null;
  memory: MemoryInfo | null;
  uptime_s: number | null;
  boot_count: number | null;
  reset_reason: number | null;
  boot_state: BootState | null;
  safe_mode: boolean | null;
  /** Live OTA session progress (`ota/progress` events), if any arrived. */
  progress: OtaProgress | null;
  /** True while the first load runs and nothing is known yet. */
  loading: boolean;
  /** Message of the latest failed status load (null when fine). */
  error: string | null;
  reload(): void;
  /** True when memory/uptime come from the live telemetry stream. */
  live: boolean;
}

/** Everything the System tab shows, from `v1/status`, `v1/ota`, live telemetry and `ota/progress` events. */
export function useSystemData(id: string): SystemData {
  const statusRes = useDeviceResource<DeviceStatus>(id, "status");
  const otaRes = useDeviceResource<OtaStatus>(id, "ota");
  const live = useDeviceLive(id);
  const [progress, setProgress] = useState<OtaProgress | null>(null);
  useDeviceEvent(id, "ota/progress", (d) => setProgress(d as OtaProgress));

  const [kept, setKept] = useState<DeviceStatus | null>(null);
  if (statusRes.data && statusRes.data !== kept) setKept(statusRes.data);
  const [keptOta, setKeptOta] = useState<OtaStatus | null>(null);
  if (otaRes.data && otaRes.data !== keptOta) setKeptOta(otaRes.data);

  const reloadStatus = statusRes.reload;
  const reloadOta = otaRes.reload;
  const streaming = live.link === "open" && live.telemetry !== null && live.telemetry.id === id;
  // Without the live stream, refresh the numbers that move (memory, uptime) every 15 s.
  useEffect(() => {
    if (streaming) return;
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      reloadStatus();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [streaming, reloadStatus]);

  const t: TelemetrySnapshot | DeviceStatus | null = streaming ? live.telemetry : kept;
  return {
    status: kept,
    ota: (streaming ? live.telemetry?.ota : null) ?? keptOta ?? kept?.ota ?? null,
    memory: t?.memory ?? null,
    uptime_s: t?.uptime_s ?? null,
    boot_count: t?.boot_count ?? null,
    reset_reason: t?.reset_reason ?? null,
    boot_state: t?.boot_state ?? null,
    safe_mode: t?.safe_mode ?? null,
    progress,
    loading: statusRes.loading && kept === null,
    error: statusRes.error ? statusRes.error.message : null,
    reload: () => {
      reloadStatus();
      reloadOta();
    },
    live: streaming,
  };
}

/** Uptime that ticks every second between telemetry updates. */
export function useTickingUptime(uptime_s: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState<{ s: number | null; at: number }>({ s: uptime_s, at: now });
  if (anchor.s !== uptime_s) setAnchor({ s: uptime_s, at: now });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (uptime_s === null || anchor.s === null) return uptime_s;
  return anchor.s + Math.max(0, Math.floor((now - anchor.at) / 1000));
}

// ---- factory reset aftermath (survives leaving the tab) ---------------------------------------------------------

export interface ResetMarker {
  at: number;
  name: string;
  apSsid: string;
}
export const resetStore = createStore<Readonly<Record<string, ResetMarker>>>({});

export function markFactoryReset(id: string, marker: ResetMarker): void {
  resetStore.set((m) => ({ ...m, [id]: marker }));
}
export function clearFactoryReset(id: string): void {
  resetStore.set((m) => {
    if (!(id in m)) return m;
    const { [id]: _drop, ...rest } = m;
    return rest;
  });
}

/** Offline-ish health where controls cannot work. */
export function isUnavailable(s: Pick<DeviceSummary, "health"> | null): boolean {
  return s !== null && (s.health === "offline" || s.health === "unreachable" || s.health === "rebooting" || s.health === "updating");
}
