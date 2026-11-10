import type { AppContext } from "../appContext";
import { DeviceError } from "../device/client";
import type { Job, JobDeviceResult } from "../types/api-jobs";
import type { BackupApplyJobResult, BackupApplyResult, BackupFile, BackupPlan } from "../types/api-backups";
import { readDeviceState, runCommand } from "./deviceState";
import { planBackup, type ResolvedInclude } from "./planner";

/** Planning and applying a backup on targets. Both go through the normal command path (`callDevice`), so the pin shadow and rename bookkeeping stay right. */

const CODE_BY_KIND: Record<string, string> = { timeout: "device_timeout", refused: "device_unreachable", unreachable: "device_unreachable", reset: "device_reset" };

export function describeDeviceError(err: unknown): { code: string; message: string } {
  if (err instanceof DeviceError) return { code: CODE_BY_KIND[err.kind] ?? `device_${err.kind}`, message: err.message };
  return { code: "internal_error", message: err instanceof Error ? err.message : String(err) };
}

export function targetTitle(app: AppContext, id: string): string {
  const d = app.registry.get(id);
  return d ? d.label || d.name || d.hostname || id : id;
}

const lowerFirst = (s: string): string => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** Plan one target against its live state. Never throws: an unreachable device becomes `reachable: false`. */
export async function planTarget(app: AppContext, backup: BackupFile, targetId: string, include: ResolvedInclude): Promise<BackupPlan> {
  const dev = app.registry.get(targetId);
  const base = { targetId, targetName: targetTitle(app, targetId) };
  const unreachable = (error: string): BackupPlan => ({
    ...base,
    reachable: false,
    error,
    steps: [],
    conflicts: [],
    warnings: [],
    unchanged: { pins: 0, modules: 0, rules: 0 },
  });
  if (!dev) return unreachable("This device is not in the Manager any more.");
  if (app.health.stateOf(targetId).health === "offline") return unreachable(`${base.targetName} is offline right now. Switch it on or fix its network, then try again.`);
  try {
    const state = await readDeviceState(app, dev);
    return { ...base, reachable: true, error: null, ...planBackup(backup, state, include) };
  } catch (err) {
    if (err instanceof DeviceError) return unreachable(`Could not reach ${base.targetName}: ${err.message}`);
    throw err;
  }
}

export interface ApplyRequest {
  backup: BackupFile;
  backupId: string | null;
  targetIds: string[];
  include: ResolvedInclude;
  title: string;
  /** Extra public params (never secrets). */
  params?: Record<string, unknown>;
}

const CONCURRENCY = 3;

export function startApply(app: AppContext, req: ApplyRequest): Job {
  const { backup, targetIds, include } = req;
  const job = app.jobs.create(
    {
      kind: "backup-apply",
      title: req.title,
      deviceIds: targetIds,
      devices: targetIds.map((deviceId) => ({ deviceId, name: targetTitle(app, deviceId) })),
      params: { backupId: req.backupId, sourceName: backup.name, targetIds, include, ...req.params },
      supports: { retry: true },
      onRetry: (old: Job): Job | void => {
        const redo = old.devices.filter((d: JobDeviceResult) => d.state !== "done").map((d) => d.deviceId);
        if (redo.length === 0) return;
        return startApply(app, { ...req, targetIds: redo, title: `${req.title} (retry)` });
      },
    },
    async (ctl) => {
      let ok = 0;
      let failed = 0;
      const queue = [...targetIds];

      const runTarget = async (id: string): Promise<void> => {
        if (ctl.isCancelled()) return;
        ctl.device(id, { state: "running", message: "Reading the device", progress: 0 });
        const plan = await planTarget(app, backup, id, include);
        if (ctl.isCancelled()) return;
        if (!plan.reachable) {
          failed++;
          ctl.device(id, { state: "failed", message: plan.error ?? "Could not reach the device.", error: { code: "device_unreachable", message: plan.error ?? "Could not reach the device." } });
          return;
        }
        const total = plan.steps.length;
        const dev = app.registry.get(id);
        if (!dev) return;
        let applied = 0;
        for (const s of plan.steps) {
          if (ctl.isCancelled()) return;
          ctl.device(id, { step: s.id, progress: total === 0 ? 1 : applied / total, message: s.summary });
          let failure: { code: string; message: string } | null = null;
          try {
            const out = await runCommand(app, dev, s.cmd);
            if (!out.ok) failure = { code: "step_failed", message: `Could not ${lowerFirst(s.summary)}: ${out.error}` };
          } catch (err) {
            const d = describeDeviceError(err);
            failure = { code: d.code, message: `Could not ${lowerFirst(s.summary)}: ${d.message}` };
          }
          if (failure) {
            failed++;
            const result: BackupApplyResult = { applied, total, failedStep: s.id };
            ctl.device(id, {
              state: "failed",
              step: s.id,
              message: `Stopped after ${applied} of ${total} change${total === 1 ? "" : "s"}`,
              error: { ...failure, step: s.id },
              result,
            });
            return;
          }
          applied++;
        }
        ok++;
        const result: BackupApplyResult = { applied, total };
        const left = plan.conflicts.length > 0 ? ` ${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? " was" : "s were"} left as they were.` : "";
        ctl.device(id, {
          state: "done",
          progress: 1,
          message: (total === 0 ? "Already matches the backup." : `Applied ${applied} change${applied === 1 ? "" : "s"}.`) + left,
          result,
        });
      };

      const worker = async (): Promise<void> => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined || ctl.isCancelled()) return;
          try {
            await runTarget(id);
          } catch (err) {
            failed++;
            const d = describeDeviceError(err);
            ctl.device(id, { state: "failed", message: d.message, error: d });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targetIds.length) }, () => worker()));
      const result: BackupApplyJobResult = { backupId: req.backupId, devices: targetIds.length, ok, failed };
      ctl.result(result);
      ctl.message(failed === 0 ? "Done." : ok === 0 ? "Nothing could be applied." : "Some devices were not fully updated.");
    },
  );
  return job;
}
