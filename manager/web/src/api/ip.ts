import type { IpChange } from "@shared/device-api";
import type { IpChangeBody, IpCheckResult, IpJobResult, IpSettings, Job } from "@shared/api";
import { apiFetch } from "./client";
import { upsertJob } from "./jobs";
import { useApi, type ApiResource } from "./useApi";

export type { IpChangeBody, IpCheckResult, IpJobResult, IpMode, IpSettings } from "@shared/api";

/** The device's own `ip_change` record (passed through by the server as plain JSON). */
export function ipChangeOf(s: Pick<IpSettings, "ipChange">): IpChange | null {
  return s.ipChange as IpChange | null;
}

const base = (id: string) => `/api/devices/${encodeURIComponent(id)}/ip`;

/** The device's IP settings. `reload()` after a change. */
export function useIpSettings(id: string): ApiResource<IpSettings> {
  return useApi<IpSettings>(base(id));
}

/** Dry run: the device's rules plus the Manager's warnings. Never changes anything. */
export function checkIpChange(id: string, body: IpChangeBody, signal?: AbortSignal): Promise<IpCheckResult> {
  return apiFetch<IpCheckResult>(`${base(id)}/check`, { method: "POST", body, signal });
}

/** Starts the "Change IP" job. The job is put into the jobs store at once; follow it with `useJob(job.id)`. */
export async function startIpChange(id: string, body: IpChangeBody): Promise<Job> {
  const job = await apiFetch<Job>(base(id), { method: "POST", body });
  upsertJob(job);
  return job;
}

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "reverted", "no_dhcp_lease", "failed", "unknown"]);

/** `job.result` as an `IpJobResult`, or null when it is missing or not that shape. */
export function readIpJobResult(job: Pick<Job, "result">): IpJobResult | null {
  const r = job.result as Partial<IpJobResult> | null | undefined;
  if (!r || typeof r !== "object" || typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) return null;
  return {
    outcome: r.outcome,
    reason: typeof r.reason === "string" ? r.reason : null,
    host: typeof r.host === "string" ? r.host : null,
    ipMode: r.ipMode === "static" ? "static" : "dhcp",
  };
}
