import type { Job, JobAction, JobKind } from "@shared/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, apiFetch } from "./client";
import { createStore, useStore } from "./store";
import { getBrowserWs } from "./ws";

/**
 * Jobs store (batch 3): every `{ t: "job" }` WebSocket message replaces the job it carries, `GET /api/jobs` seeds the store on
 * first use (and again whenever the socket reopens, to catch what was missed). Features start jobs through their own endpoints
 * and then follow them with `useJob(id)`; `useJobs()` lists them. Contract: `API.md` "Jobs".
 */

interface JobsState {
  byId: Readonly<Record<string, Job>>;
  /** Newest first (createdAt, then id). */
  list: readonly Job[];
  /** True once `GET /api/jobs` answered. */
  loaded: boolean;
  /** Last failure of the list request. */
  error: ApiError | null;
  /** Ids the server does not know (404 on `GET /api/jobs/:id`). */
  missing: Readonly<Record<string, ApiError>>;
}

const EMPTY: JobsState = { byId: {}, list: [], loaded: false, error: null, missing: {} };
export const jobsStore = createStore<JobsState>(EMPTY);

const FINISHED = new Set<Job["state"]>(["succeeded", "failed", "partial", "cancelled", "interrupted"]);
/** A job that will not change any more. */
export const isJobFinished = (job: Pick<Job, "state">): boolean => FINISHED.has(job.state);

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError(0, "unknown", e instanceof Error ? e.message : String(e)));

function sorted(byId: Record<string, Job>): Job[] {
  return Object.values(byId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
}

/** Insert or replace jobs. An older copy (smaller `updatedAt`) never replaces a newer one, and a finished job never goes back. */
export function upsertJobs(incoming: readonly Job[]): void {
  jobsStore.set((p) => {
    let byId: Record<string, Job> | null = null;
    for (const job of incoming) {
      const have = (byId ?? p.byId)[job.id];
      if (have && (have.updatedAt > job.updatedAt || (isJobFinished(have) && !isJobFinished(job)))) continue;
      if (have && JSON.stringify(have) === JSON.stringify(job)) continue;
      byId ??= { ...p.byId };
      byId[job.id] = job;
    }
    if (!byId) return p;
    const missing: Record<string, ApiError> = { ...p.missing };
    for (const job of incoming) delete missing[job.id];
    return { ...p, byId, list: sorted(byId), missing };
  });
}

export function upsertJob(job: Job): void {
  upsertJobs([job]);
}

let started = false;
let unsubs: Array<() => void> = [];
let fetchSeq = 0;
const singles = new Set<string>();

async function fetchList(): Promise<void> {
  const mine = ++fetchSeq;
  try {
    const list = await apiFetch<Job[]>("/api/jobs");
    if (mine !== fetchSeq) return;
    upsertJobs(list);
    jobsStore.set((p) => ({ ...p, loaded: true, error: null }));
  } catch (err) {
    if (mine !== fetchSeq) return;
    jobsStore.set((p) => ({ ...p, error: asApiError(err) }));
  }
}

/** Subscribe to the WebSocket and fetch the list. Idempotent; the hooks call it. */
export function startJobs(): void {
  if (started) return;
  started = true;
  const ws = getBrowserWs();
  let last = ws.store.get().state;
  unsubs = [
    ws.subscribe("job", (m) => upsertJob(m.job)),
    ws.store.subscribe(() => {
      const next = ws.store.get().state;
      if (next === "open" && last !== "open") void fetchList(); // updates may have been missed while the socket was down
      last = next;
    }),
  ];
  void fetchList();
}

/** Tests only. */
export function resetJobs(): void {
  for (const u of unsubs) u();
  unsubs = [];
  started = false;
  fetchSeq++;
  singles.clear();
  jobsStore.set(EMPTY);
}

/** GET one job that the list did not contain (older than the server's retention, or created before this page loaded). */
async function fetchOne(id: string): Promise<void> {
  if (singles.has(id)) return;
  singles.add(id);
  try {
    upsertJob(await apiFetch<Job>(`/api/jobs/${encodeURIComponent(id)}`));
  } catch (err) {
    const error = asApiError(err);
    jobsStore.set((p) => ({ ...p, missing: { ...p.missing, [id]: error } }));
  } finally {
    singles.delete(id);
  }
}

const jobPath = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;

/**
 * POST /api/jobs/:id/<action>. Resolves with the job the server answered with: for `retry` usually a NEW job (follow its id).
 * The answer is put into the store at once; later changes arrive over the WebSocket.
 */
export async function runJobAction(id: string, action: JobAction): Promise<Job> {
  const job = await apiFetch<Job>(`${jobPath(id)}/${action}`, { method: "POST" });
  upsertJob(job);
  return job;
}

export interface UseJob {
  job: Job | null;
  /** True until the job is known (or known not to exist). */
  loading: boolean;
  /** Why the job could not be loaded (`not_found` when the server has dropped it) or the last action failed. */
  error: ApiError | null;
  /** Each resolves with the job the server answered with, or null when the request failed (then `error` is set). `retry` may return a different job. */
  cancel(): Promise<Job | null>;
  pause(): Promise<Job | null>;
  resume(): Promise<Job | null>;
  retry(): Promise<Job | null>;
}

/** One job by id, live. `id` undefined = nothing to follow. */
export function useJob(id: string | undefined): UseJob {
  useEffect(() => startJobs(), []);
  const job = useStore(jobsStore, (s) => (id ? (s.byId[id] ?? null) : null));
  const loaded = useStore(jobsStore, (s) => s.loaded);
  const listError = useStore(jobsStore, (s) => s.error);
  const missing = useStore(jobsStore, (s) => (id ? (s.missing[id] ?? null) : null));
  const [action, setAction] = useState<{ id: string | undefined; error: ApiError | null }>({ id, error: null });

  useEffect(() => {
    if (id && !job && (loaded || listError) && !missing) void fetchOne(id);
  }, [id, job, loaded, listError, missing]);

  const run = useCallback(
    async (a: JobAction): Promise<Job | null> => {
      if (!id) return null;
      setAction({ id, error: null });
      try {
        return await runJobAction(id, a);
      } catch (err) {
        setAction({ id, error: asApiError(err) });
        return null;
      }
    },
    [id],
  );

  const actionError = action.id === id ? action.error : null;
  return {
    job,
    loading: id !== undefined && !job && !missing,
    error: actionError ?? missing ?? (job ? null : listError),
    cancel: useCallback(() => run("cancel"), [run]),
    pause: useCallback(() => run("pause"), [run]),
    resume: useCallback(() => run("resume"), [run]),
    retry: useCallback(() => run("retry"), [run]),
  };
}

export interface JobsFilter {
  kind?: JobKind;
  /** true = not finished yet, false = finished. */
  active?: boolean;
}

/** All known jobs, newest first, optionally filtered. */
export function useJobs(filter: JobsFilter = {}): { jobs: Job[]; loaded: boolean; error: ApiError | null } {
  useEffect(() => startJobs(), []);
  const list = useStore(jobsStore, (s) => s.list) as Job[];
  const loaded = useStore(jobsStore, (s) => s.loaded);
  const error = useStore(jobsStore, (s) => s.error);
  const { kind, active } = filter;
  const jobs = useMemo(
    () => list.filter((j) => (kind === undefined || j.kind === kind) && (active === undefined || active === !isJobFinished(j))),
    [list, kind, active],
  );
  return { jobs, loaded, error };
}
