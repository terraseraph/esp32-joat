import type { BackupFile, BackupInclude, BackupMeta, BackupPlan, Job } from "@shared/api";
import { useEffect } from "react";
import { ApiError, apiFetch } from "./client";
import { upsertJob } from "./jobs";
import { createStore, useStore } from "./store";

export type {
  BackupApplyResult,
  BackupFile,
  BackupInclude,
  BackupMeta,
  BackupModule,
  BackupPin,
  BackupPlan,
  BackupPlanStep,
  BackupRule,
  BackupStepOp,
} from "@shared/api";

// ---- list store -------------------------------------------------------------------------------------------

interface BackupsState {
  /** Newest first. */
  list: readonly BackupMeta[];
  loaded: boolean;
  error: ApiError | null;
}

const EMPTY: BackupsState = { list: [], loaded: false, error: null };
export const backupsStore = createStore<BackupsState>(EMPTY);

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError(0, "unknown", e instanceof Error ? e.message : String(e)));
const newestFirst = (list: readonly BackupMeta[]): BackupMeta[] => [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));

let fetchSeq = 0;

/** GET /api/backups into the store (the page does this on every visit). */
export async function loadBackups(): Promise<void> {
  const mine = ++fetchSeq;
  try {
    const list = await apiFetch<BackupMeta[]>("/api/backups");
    if (mine !== fetchSeq) return;
    backupsStore.set({ list: newestFirst(list), loaded: true, error: null });
  } catch (err) {
    if (mine !== fetchSeq) return;
    backupsStore.set((p) => ({ ...p, error: asApiError(err) }));
  }
}

function upsertBackup(meta: BackupMeta): void {
  backupsStore.set((p) => ({ ...p, list: newestFirst([...p.list.filter((b) => b.id !== meta.id), meta]) }));
}

/** Tests only. */
export function resetBackups(): void {
  fetchSeq++;
  backupsStore.set(EMPTY);
}

export function useBackups(): { list: BackupMeta[]; loaded: boolean; error: ApiError | null; reload(): Promise<void> } {
  useEffect(() => {
    void loadBackups();
  }, []);
  const list = useStore(backupsStore, (s) => s.list) as BackupMeta[];
  const loaded = useStore(backupsStore, (s) => s.loaded);
  const error = useStore(backupsStore, (s) => s.error);
  return { list, loaded, error, reload: loadBackups };
}

// ---- calls ------------------------------------------------------------------------------------------------

const enc = encodeURIComponent;

/** POST /api/devices/:id/backup: reads the live device and saves a backup. */
export async function createBackup(deviceId: string): Promise<BackupMeta> {
  const meta = await apiFetch<BackupMeta>(`/api/devices/${enc(deviceId)}/backup`, { method: "POST", body: {} });
  upsertBackup(meta);
  return meta;
}

export interface BackupOutcome {
  id: string;
  name: string;
  meta: BackupMeta | null;
  error: unknown;
}

/** Back up several devices in parallel; never rejects. `onEach` fires as each device finishes. */
export async function backupDevices(devices: readonly { id: string; name: string }[], onEach?: (o: BackupOutcome) => void): Promise<BackupOutcome[]> {
  return Promise.all(
    devices.map(async (d): Promise<BackupOutcome> => {
      let outcome: BackupOutcome;
      try {
        outcome = { id: d.id, name: d.name, meta: await createBackup(d.id), error: null };
      } catch (error) {
        outcome = { id: d.id, name: d.name, meta: null, error };
      }
      onEach?.(outcome);
      return outcome;
    }),
  );
}

/** GET /api/backups/:id: the saved file. */
export function getBackup(id: string): Promise<BackupFile> {
  return apiFetch<BackupFile>(`/api/backups/${enc(id)}`);
}

/** Link for the browser's own download (`Content-Disposition: attachment`). */
export const backupDownloadUrl = (id: string): string => `/api/backups/${enc(id)}?download=1`;

/** POST /api/backups/import with a parsed backup file. */
export async function importBackup(file: unknown): Promise<BackupMeta> {
  const meta = await apiFetch<BackupMeta>("/api/backups/import", { method: "POST", body: file });
  upsertBackup(meta);
  return meta;
}

export async function updateBackupNote(id: string, note: string): Promise<BackupMeta> {
  const meta = await apiFetch<BackupMeta>(`/api/backups/${enc(id)}`, { method: "PATCH", body: { note } });
  upsertBackup(meta);
  return meta;
}

export async function deleteBackup(id: string): Promise<void> {
  await apiFetch<void>(`/api/backups/${enc(id)}`, { method: "DELETE" });
  backupsStore.set((p) => ({ ...p, list: p.list.filter((b) => b.id !== id) }));
}

/** Where a restore or clone comes from: a saved backup, or a fresh snapshot of a device (clone only). */
export type PlanSource = { kind: "backup"; backupId: string } | { kind: "device"; deviceId: string };

export interface PlanRequest {
  source: PlanSource;
  targetIds: string[];
  include: BackupInclude;
}

function planPath(source: PlanSource, what: "plan" | "apply"): string {
  if (source.kind === "backup") return `/api/backups/${enc(source.backupId)}/${what}`;
  return what === "plan" ? "/api/clone/plan" : "/api/clone";
}

function planBody({ source, targetIds, include }: PlanRequest, extra?: Record<string, unknown>): Record<string, unknown> {
  return source.kind === "device" ? { sourceId: source.deviceId, targetIds, include, ...extra } : { targetIds, include };
}

/** Dry run: what would change on each target. Nothing is sent to a device. */
export async function planRestore(req: PlanRequest): Promise<BackupPlan[]> {
  const res = await apiFetch<{ plans: BackupPlan[] }>(planPath(req.source, "plan"), { method: "POST", body: planBody(req) });
  return res.plans;
}

/** Start the apply job (restore, or clone when the source is a device). `saveSnapshot` keeps the fresh clone snapshot. */
export async function applyRestore(req: PlanRequest, opts: { saveSnapshot?: boolean } = {}): Promise<Job> {
  const extra = req.source.kind === "device" && opts.saveSnapshot ? { saveSnapshot: true } : undefined;
  const job = await apiFetch<Job>(planPath(req.source, "apply"), { method: "POST", body: planBody(req, extra) });
  upsertJob(job); // follow it at once; later changes arrive over the WebSocket
  return job;
}
