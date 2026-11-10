import type { DeviceSummary, Job, JobDeviceState } from "@shared/api";
import type { FirmwareImage } from "../../api/firmware";

/** How a device compares with the target image. `unknown` = no target, or the device has not reported its build. */
export type FirmwareClass = "differs" | "same" | "unknown";

export interface Eligibility {
  /** Can an update be started on it right now? */
  ok: boolean;
  /** Why not (plain words), or a short note when it can. */
  note: string;
  /** Tone of the note. */
  tone?: "ok" | "warn";
}

/** Compare by the Manager's verdict (`fwMatchesTarget`), which already looks at version and build date. */
export function firmwareClass(d: Pick<DeviceSummary, "fwMatchesTarget">): FirmwareClass {
  return d.fwMatchesTarget === false ? "differs" : d.fwMatchesTarget === true ? "same" : "unknown";
}

/** Whether a device can be updated now, and why not. `busyIds` = devices that are in an unfinished firmware job. */
export function eligibility(d: DeviceSummary, busyIds: ReadonlySet<string>): Eligibility {
  if (busyIds.has(d.id) || d.health === "updating") return { ok: false, note: "Already being updated", tone: "warn" };
  switch (d.health) {
    case "offline":
      return { ok: false, note: "Offline, can't update" };
    case "unreachable":
      return { ok: false, note: "Unreachable, can't update" };
    case "rebooting":
      return { ok: false, note: "Restarting right now", tone: "warn" };
    case "unknown":
      return { ok: false, note: "Still checking this device" };
    case "online":
      break;
  }
  if (d.ota.image_state === "pending_verify") return { ok: false, note: "Still verifying its last update", tone: "warn" };
  if (d.ota.busy) return { ok: false, note: "Busy with another update", tone: "warn" };
  const cls = firmwareClass(d);
  if (cls === "differs") return { ok: true, note: "Ready to update", tone: "ok" };
  if (cls === "same") return { ok: true, note: "Up to date · select to reinstall" };
  return { ok: true, note: "Ready to update" };
}

export interface DeviceRow {
  device: DeviceSummary;
  cls: FirmwareClass;
  elig: Eligibility;
}

export function buildRows(devices: readonly DeviceSummary[], busyIds: ReadonlySet<string>): DeviceRow[] {
  return devices.map((device) => ({ device, cls: firmwareClass(device), elig: eligibility(device, busyIds) }));
}

export type DeviceFilter = "all" | "differs" | "same" | "cant";

export function matchesDeviceFilter(r: DeviceRow, f: DeviceFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "differs":
      return r.cls === "differs";
    case "same":
      return r.cls === "same";
    case "cant":
      return !r.elig.ok;
  }
}

export interface RowCounts {
  all: number;
  differs: number;
  same: number;
  cant: number;
  /** Can be updated now. */
  ready: number;
  /** Differ from the target and can be updated now. */
  readyDiffer: number;
}

export function countRows(rows: readonly DeviceRow[]): RowCounts {
  const c: RowCounts = { all: rows.length, differs: 0, same: 0, cant: 0, ready: 0, readyDiffer: 0 };
  for (const r of rows) {
    if (r.cls === "differs") c.differs++;
    if (r.cls === "same") c.same++;
    if (!r.elig.ok) c.cant++;
    else {
      c.ready++;
      if (r.cls === "differs") c.readyDiffer++;
    }
  }
  return c;
}

/** The devices a fresh page has ticked: the ones that differ and can be updated. */
export function defaultSelection(rows: readonly DeviceRow[]): Set<string> {
  return new Set(rows.filter((r) => r.elig.ok && r.cls === "differs").map((r) => r.device.id));
}

/** "Build 9dcba89 from Nov 10 2026 09:12" for an image. */
export function imageBuilt(i: Pick<FirmwareImage, "date" | "time">): string {
  return `${i.date} ${i.time.slice(0, 5)}`.trim();
}

export function isRollbackJob(j: Pick<Job, "params">): boolean {
  return j.params["action"] === "rollback";
}

// ---- job summaries -----------------------------------------------------------------------------------------------------

const WAITING: ReadonlySet<JobDeviceState> = new Set(["queued"]);

/** "2 updated · 1 failed · 1 rolled back · 2 waiting", or "" while nothing is known. */
export function jobTally(job: Pick<Job, "devices">): string {
  const n = (states: JobDeviceState[]) => job.devices.filter((d) => states.includes(d.state)).length;
  const parts: string[] = [];
  const done = n(["done"]);
  const failed = n(["failed"]);
  const back = n(["rolled_back", "reverted"]);
  const skipped = n(["skipped"]);
  const cancelled = n(["cancelled"]);
  const waiting = job.devices.filter((d) => WAITING.has(d.state)).length;
  const running = n(["running"]);
  if (done) parts.push(`${done} updated`);
  if (failed) parts.push(`${failed} failed`);
  if (back) parts.push(`${back} rolled back`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (cancelled) parts.push(`${cancelled} not started`);
  if (running) parts.push(`${running} in progress`);
  if (waiting) parts.push(`${waiting} waiting`);
  return parts.join(" · ");
}

/** What a finished device row reports about versions (`result: { fromVersion, toVersion, partition }`). */
export function rowVersions(result: unknown): { from: string | null; to: string | null } {
  const r = (result ?? {}) as { fromVersion?: unknown; toVersion?: unknown };
  return { from: typeof r.fromVersion === "string" ? r.fromVersion : null, to: typeof r.toVersion === "string" ? r.toVersion : null };
}

export const deviceCountLabel = (n: number) => `${n} ${n === 1 ? "device" : "devices"}`;
