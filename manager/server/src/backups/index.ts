import path from "node:path";
import type { AppContext } from "../appContext";
import { HttpError } from "../http/errors";
import type { Job } from "../types/api-jobs";
import type { BackupFile, BackupInclude, BackupMeta, BackupPlan } from "../types/api-backups";
import { planTarget, startApply, targetTitle } from "./apply";
import { resolveInclude } from "./planner";
import { snapshotDevice } from "./snapshot";
import { createBackupStore, type BackupStore } from "./store";

export { validateBackup } from "./store";

/**
 * Backups feature (batch 3, backups track). `start()` creates it right after the app context exists and closes it on
 * shutdown. Snapshot -> store -> plan -> apply, all through the normal device command path and the job service.
 */

export interface BackupsConfig {
  /** Where the files live (default `<dataDir>/backups`). */
  dir?: string;
}

export interface BackupsFeature {
  store: BackupStore;
  /** Read a device and build a backup file (not stored). Throws `HttpError` 409 `device_offline` / `DeviceError`. */
  snapshot(deviceId: string): Promise<BackupFile>;
  /** Snapshot and store. */
  backupNow(deviceId: string, note?: string): Promise<BackupMeta>;
  plan(backup: BackupFile, targetIds: string[], include: BackupInclude | undefined, opts: { clone: boolean }): Promise<BackupPlan[]>;
  apply(backup: BackupFile, backupId: string | null, targetIds: string[], include: BackupInclude | undefined, opts: { clone: boolean }): Job;
  /** Validate and normalise a list of target ids (known devices, no duplicates). */
  resolveTargets(ids: string[], exclude?: string): string[];
  close(): Promise<void>;
}

export async function createBackupsFeature(app: AppContext, config: BackupsConfig = {}): Promise<BackupsFeature> {
  const store = await createBackupStore(config.dir ?? path.join(app.dataDir, "backups"), (m) => app.log(m));

  const snapshot = async (deviceId: string): Promise<BackupFile> => {
    const dev = app.registry.get(deviceId);
    if (!dev) throw new HttpError(404, "unknown_device", `No device with id "${deviceId}" is registered. List them with GET /api/devices.`);
    if (app.health.stateOf(deviceId).health === "offline") {
      throw new HttpError(409, "device_offline", `${targetTitle(app, deviceId)} is offline right now, so it cannot be backed up. Switch it on or fix its network, then try again.`);
    }
    return snapshotDevice(app, dev);
  };

  return {
    store,
    snapshot,
    async backupNow(deviceId, note) {
      const file = await snapshot(deviceId);
      if (note) file.note = note;
      return store.add(file);
    },
    plan: (backup, targetIds, include, opts) => {
      const resolved = resolveInclude(include, opts);
      return Promise.all(targetIds.map((id) => planTarget(app, backup, id, resolved)));
    },
    apply(backup, backupId, targetIds, include, opts) {
      const resolved = resolveInclude(include, opts);
      const n = targetIds.length;
      const to = n === 1 ? targetTitle(app, targetIds[0] as string) : `${n} devices`;
      const title = opts.clone ? `Clone ${backup.name} to ${to}` : `Restore ${backup.name} to ${to}`;
      return startApply(app, { backup, backupId, targetIds, include: resolved, title, params: { clone: opts.clone } });
    },
    resolveTargets(ids, exclude) {
      const out: string[] = [];
      for (const id of ids) {
        if (!app.registry.get(id)) throw new HttpError(404, "unknown_device", `No device with id "${id}" is registered. List them with GET /api/devices.`);
        if (id === exclude) throw new HttpError(400, "invalid_targets", "A device cannot be cloned onto itself. Pick other devices as targets.");
        if (!out.includes(id)) out.push(id);
      }
      return out;
    },
    async close() {
      await store.flush();
    },
  };
}
