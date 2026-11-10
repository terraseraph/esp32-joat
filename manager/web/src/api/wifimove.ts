import type { AccessPoint } from "@shared/device-api";
import type { Job, WifiMoveBody, WifiMoveCheckBody, WifiMoveCheckResult, WifiMoveJobResult, WifiMoveSettings } from "@shared/api";
import { deviceGet } from "./commands";
import { apiFetch } from "./client";
import { upsertJob } from "./jobs";
import { useApi, type ApiResource } from "./useApi";

export type { WifiMoveBody, WifiMoveCheckBody, WifiMoveCheckResult, WifiMoveJobResult, WifiMoveSettings } from "@shared/api";

const base = (id: string) => `/api/devices/${encodeURIComponent(id)}/wifi`;

/** The device's Wi-Fi state for the move feature. Pass `false` to skip (a device without `wifi_change`). `reload()` after a move. */
export function useWifiMoveSettings(id: string, enabled = true): ApiResource<WifiMoveSettings> {
  return useApi<WifiMoveSettings>(enabled ? base(id) : null);
}

/** Dry run: errors the move would be refused for, and warnings. Never changes anything. */
export function checkWifiMove(id: string, body: WifiMoveCheckBody, signal?: AbortSignal): Promise<WifiMoveCheckResult> {
  return apiFetch<WifiMoveCheckResult>(`${base(id)}/check`, { method: "POST", body, signal });
}

/** Starts the "move to another Wi-Fi network" job. The job is put into the jobs store at once; follow it with `useJob(job.id)`. */
export async function startWifiMove(id: string, body: WifiMoveBody): Promise<Job> {
  const job = await apiFetch<Job>(base(id), { method: "POST", body });
  upsertJob(job);
  return job;
}

/** The networks the device itself can see (blocks the device for a few seconds). */
export function scanDeviceNetworks(id: string): Promise<AccessPoint[]> {
  return deviceGet<AccessPoint[]>(id, "network/scan");
}

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "failed", "not_found", "unknown"]);

/** `job.result` as a `WifiMoveJobResult`, or null when it is missing or not that shape. */
export function readWifiMoveResult(job: Pick<Job, "result">): WifiMoveJobResult | null {
  const r = job.result as Partial<WifiMoveJobResult> | null | undefined;
  if (!r || typeof r !== "object" || typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    outcome: r.outcome,
    ssid: typeof r.ssid === "string" ? r.ssid : "",
    reason: str(r.reason),
    reasonCode: str(r.reasonCode),
    restoredPrevious: typeof r.restoredPrevious === "boolean" ? r.restoredPrevious : null,
    oldHost: typeof r.oldHost === "string" ? r.oldHost : "",
    newHost: str(r.newHost),
    addressChanged: r.addressChanged === true,
    staticIpReset: r.staticIpReset === true,
  };
}
