import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors";
import type { Job, JobAction, JobDeviceResult, JobDeviceState, JobError, JobKind, JobState, JobStep, JobStepStatus } from "../types/api-jobs";
import type { BrowserHub } from "../ws/browserHub";
import { loadHistory, writeHistory } from "./history";
import { sanitizeParams } from "./sanitize";

export { sanitizeParams, SECRET_KEY_RE } from "./sanitize";

/**
 * Job service (batch 3): the one place that runs long operations (SoftAP setup, IP change, firmware update, applying a
 * backup). A feature calls `app.jobs.create(spec, run)`; the service owns the state machine, the cancel/pause plumbing,
 * retention and the throttled `{ t: "job", job }` WebSocket push. The contract is documented in `API.md` ("Jobs").
 */

/** `StartOptions.jobs`. */
export interface JobsConfig {
  /** Finished jobs kept in memory besides the active ones (default 50). */
  keepFinished?: number;
  /** Minimum time between two WebSocket messages of the same job in ms (default 150). The final state is always sent at once. */
  wsThrottleMs?: number;
  /** Delay before changed jobs are written to `jobs.json` (default 500 ms; 0 writes on the next tick). */
  persistDebounceMs?: number;
}

/** Throw from a job body to end it as `failed` with this code and message (plain words: a person reads them). */
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly step?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "JobFailure";
  }
}

export interface JobSpec {
  kind: JobKind;
  /** One line for a person. */
  title: string;
  deviceIds?: string[];
  /** Public summary of the request. Keys that look like secrets (`/pass|psk|secret|token|key$/i`) are dropped, at any depth. */
  params?: Record<string, unknown>;
  /** Job-level steps, all `pending` at the start. More can be added later by `ctl.step()` with a new id. */
  steps?: { id: string; label: string }[];
  /** Per-device rows, all `queued` at the start (`ctl.device()` adds more). */
  devices?: { deviceId: string; name?: string }[];
  /** Which optional actions the job body supports. `cancel` always works (through `ctl.signal`). */
  supports?: { pause?: boolean; retry?: boolean };
  /** Called after the state became `paused` (the body stops at its next `ctl.waitWhilePaused()`). */
  onPause?(job: Job): void | Promise<void>;
  /** Called after the state became `running` again. */
  onResume?(job: Job): void | Promise<void>;
  /**
   * `retry` is offered for finished `failed` / `partial` / `cancelled` jobs when `supports.retry` and this hook exist.
   * Typically starts a new job (`jobs.create`) and returns it; the route answers with the returned job (else the old one).
   * Retry can be used once per job.
   */
  onRetry?(job: Job): Job | void | Promise<Job | void>;
}

export interface StepPatch {
  status?: JobStepStatus;
  label?: string;
  /** `null` removes the line. */
  detail?: string | null;
  /** 0..1; `null` removes it. */
  progress?: number | null;
}

export interface DevicePatch {
  name?: string;
  state?: JobDeviceState;
  /** Current step id. */
  step?: string;
  progress?: number | null;
  message?: string | null;
  error?: JobError | null;
  result?: unknown;
}

export interface JobControl {
  readonly id: string;
  /** Aborted on cancel and on shutdown. Pass it to every wait/fetch the body makes. */
  readonly signal: AbortSignal;
  /** Change a step (a status string is shorthand for `{ status }`). An unknown id appends a new step (label defaults to the id). */
  step(id: string, patch: JobStepStatus | StepPatch): void;
  /** Change one device row (an unknown `deviceId` appends it, state `queued`). */
  device(deviceId: string, patch: DevicePatch): void;
  /** Overall progress 0..1, or `null` for indeterminate. Until the body calls this it is derived from the steps (else the devices) and is 1 on success. */
  progress(value: number | null, message?: string): void;
  /** Current human status line. */
  message(text: string): void;
  /** Kind-specific outcome (no secrets). */
  result(value: unknown): void;
  /** Record the error without stopping the body: when it returns, the job ends `failed`. To stop at once throw `JobFailure`. */
  fail(error: JobError): void;
  /** Resolves at once unless the job is paused; then when it is resumed or cancelled. */
  waitWhilePaused(): Promise<void>;
  isCancelled(): boolean;
}

export interface JobListFilter {
  kind?: JobKind;
  /** true = not finished yet, false = finished. */
  active?: boolean;
}

export interface JobService {
  /**
   * Create a job; `run` starts on the next microtask (the returned snapshot is `queued`). When `run` resolves the job ends
   * `succeeded` (`partial` / `failed` when device rows say so, `cancelled` after a cancel); `JobFailure` ends it `failed`
   * with that error; any other throw ends it `failed` with `internal_error`.
   */
  create(spec: JobSpec, run: (ctl: JobControl) => Promise<void> | void): Job;
  get(id: string): Job | undefined;
  /** Newest first. */
  list(filter?: JobListFilter): Job[];
  /** Idempotent: a finished or already-cancelling job is returned as is. 404 `not_found` for an unknown id. */
  cancel(id: string): Job;
  /** 409 `job_action_unavailable` when the action is not in `job.actions`; 404 `not_found` for an unknown id. */
  pause(id: string): Promise<Job>;
  resume(id: string): Promise<Job>;
  retry(id: string): Promise<Job>;
  /** Resolves with the final snapshot once the job has finished (immediately for a finished job). */
  whenDone(id: string): Promise<Job>;
  /** Called on every change (not throttled) with a snapshot. Returns the unsubscribe function. */
  onChange(fn: (job: Job) => void): () => void;
  /** Cancel every running job and wait for them to settle (at most `timeoutMs`, default 15000), then stop. */
  close(opts?: { timeoutMs?: number }): Promise<void>;
}

export interface JobServiceDeps {
  hub?: Pick<BrowserHub, "broadcast">;
  log?: (msg: string) => void;
  config?: JobsConfig;
  /** Where `jobs.json` lives. Without it the history is memory only. */
  dataDir?: string;
}

export const DEFAULT_KEEP_FINISHED = 50;
export const DEFAULT_WS_THROTTLE_MS = 150;
export const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;
export const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

const TERMINAL: ReadonlySet<JobState> = new Set(["succeeded", "failed", "partial", "cancelled", "interrupted"]);
export const isTerminalJobState = (s: JobState): boolean => TERMINAL.has(s);
const DEVICE_DONE: ReadonlySet<JobDeviceState> = new Set(["done", "failed", "skipped", "cancelled", "rolled_back", "reverted"]);
const DEVICE_BAD: ReadonlySet<JobDeviceState> = new Set(["failed", "rolled_back", "reverted", "cancelled"]);
const STEP_FINISHED: ReadonlySet<JobStepStatus> = new Set(["done", "failed", "skipped", "cancelled"]);

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

interface Rec {
  job: Job;
  spec: JobSpec;
  run: (ctl: JobControl) => Promise<void> | void;
  abort: AbortController;
  done: Promise<Job>;
  resolveDone: (job: Job) => void;
  cancelRequested: boolean;
  manualProgress: boolean;
  failError: JobError | null;
  retried: boolean;
  finished: boolean;
  /** Loaded from `jobs.json`: nothing runs, so it can only be looked at. */
  restored: boolean;
  pauseWaiters: (() => void)[];
  lastSent: number;
  timer: NodeJS.Timeout | null;
}

export function createJobService(deps: JobServiceDeps = {}): JobService {
  const log = deps.log ?? (() => {});
  const keepFinished = Math.max(0, deps.config?.keepFinished ?? DEFAULT_KEEP_FINISHED);
  const throttleMs = Math.max(0, deps.config?.wsThrottleMs ?? DEFAULT_WS_THROTTLE_MS);
  const records = new Map<string, Rec>();
  const finishedOrder: string[] = [];
  const listeners = new Set<(job: Job) => void>();
  let closed = false;
  const dataDir = deps.dataDir;
  const persistDebounceMs = Math.max(0, deps.config?.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS);
  let persistTimer: NodeJS.Timeout | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  /** Taken when `close()` starts: jobs that were still active then are written as they were (they come back `interrupted`). */
  let shutdownSnaps: Map<string, Job> | null = null;

  const now = (): string => new Date().toISOString();

  // ---- persisted history -------------------------------------------------------------------------------------------

  function writeNow(): Promise<void> {
    if (!dataDir) return Promise.resolve();
    writeChain = writeChain
      .then(() => writeHistory(dataDir, [...records.values()].map((r) => shutdownSnaps?.get(r.job.id) ?? snapshot(r))))
      .catch((err: Error) => log(`job history could not be saved: ${err.message}`));
    return writeChain;
  }

  function schedulePersist(): void {
    if (!dataDir || closed || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void writeNow();
    }, persistDebounceMs);
    persistTimer.unref();
  }

  function restore(job: Job): void {
    let resolveDone: (job: Job) => void = () => {};
    const done = new Promise<Job>((resolve) => (resolveDone = resolve));
    resolveDone(job);
    const rec: Rec = {
      job,
      spec: { kind: job.kind, title: job.title },
      run: () => {},
      abort: new AbortController(),
      done,
      resolveDone,
      cancelRequested: false,
      manualProgress: true,
      failError: null,
      retried: false,
      finished: true,
      restored: true,
      pauseWaiters: [],
      lastSent: 0,
      timer: null,
    };
    records.set(job.id, rec);
    finishedOrder.push(job.id);
  }

  // ---- derived fields ----------------------------------------------------------------------------------------------

  function actionsFor(rec: Rec): JobAction[] {
    const { state } = rec.job;
    if (state === "queued") return ["cancel"];
    if (state === "running") return rec.spec.supports?.pause ? ["cancel", "pause"] : ["cancel"];
    if (state === "paused") return ["cancel", "resume"];
    if (state === "cancelling") return [];
    const canRetry = (state === "failed" || state === "partial" || state === "cancelled") && rec.spec.supports?.retry === true && rec.spec.onRetry !== undefined && !rec.retried;
    return canRetry ? ["retry"] : [];
  }

  function autoProgress(job: Job): number | null {
    if (job.steps.length > 0) {
      let sum = 0;
      for (const s of job.steps) sum += s.status === "done" || s.status === "skipped" ? 1 : s.status === "running" ? Math.min(0.99, s.progress ?? 0) : 0;
      return sum / job.steps.length;
    }
    if (job.devices.length > 0) {
      let sum = 0;
      for (const d of job.devices) sum += DEVICE_DONE.has(d.state) ? 1 : d.state === "running" ? Math.min(0.99, d.progress ?? 0) : 0;
      return sum / job.devices.length;
    }
    return null;
  }

  function snapshot(rec: Rec): Job {
    const j = rec.job;
    return {
      ...j,
      steps: j.steps.map((s) => ({ ...s })),
      deviceIds: [...j.deviceIds],
      devices: j.devices.map((d) => ({ ...d })),
      params: structuredClone(j.params),
      actions: [...j.actions],
    };
  }

  // ---- broadcast ---------------------------------------------------------------------------------------------------

  function send(rec: Rec): void {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    rec.lastSent = Date.now();
    deps.hub?.broadcast({ t: "job", job: snapshot(rec) });
  }

  function publish(rec: Rec): void {
    if (closed && !isTerminalJobState(rec.job.state)) return;
    const wait = rec.lastSent + throttleMs - Date.now();
    if (isTerminalJobState(rec.job.state) || wait <= 0) return send(rec);
    if (rec.timer) return;
    rec.timer = setTimeout(() => send(rec), wait);
    rec.timer.unref();
  }

  /** Every mutation ends here: derived fields, listeners, throttled WebSocket push. */
  function changed(rec: Rec): void {
    const j = rec.job;
    if (!rec.manualProgress && !isTerminalJobState(j.state)) j.progress = autoProgress(j);
    j.actions = actionsFor(rec);
    j.updatedAt = now();
    schedulePersist();
    if (listeners.size > 0) {
      const snap = snapshot(rec);
      for (const fn of [...listeners]) {
        try {
          fn(snap);
        } catch (err) {
          log(`job listener failed: ${(err as Error).message}`);
        }
      }
    }
    publish(rec);
  }

  // ---- the control handed to the job body --------------------------------------------------------------------------

  function control(rec: Rec): JobControl {
    const j = rec.job;
    const live = (): boolean => !rec.finished;
    return {
      id: j.id,
      signal: rec.abort.signal,
      step(id, patch) {
        if (!live()) return;
        const p: StepPatch = typeof patch === "string" ? { status: patch } : patch;
        let step = j.steps.find((s) => s.id === id);
        if (!step) {
          step = { id, label: p.label ?? id, status: "pending" };
          j.steps.push(step);
        }
        if (p.label !== undefined) step.label = p.label;
        if (p.detail !== undefined) {
          if (p.detail === null) delete step.detail;
          else step.detail = p.detail;
        }
        if (p.progress !== undefined) {
          if (p.progress === null) delete step.progress;
          else step.progress = clamp01(p.progress);
        }
        if (p.status !== undefined && p.status !== step.status) {
          step.status = p.status;
          if (p.status === "running") {
            step.startedAt ??= now();
            delete step.finishedAt;
          } else if (STEP_FINISHED.has(p.status)) {
            step.finishedAt = now();
          }
          if (p.status !== "running") delete step.progress;
        }
        changed(rec);
      },
      device(deviceId, patch) {
        if (!live()) return;
        let dev = j.devices.find((d) => d.deviceId === deviceId);
        if (!dev) {
          dev = { deviceId, state: "queued" };
          j.devices.push(dev);
        }
        if (!j.deviceIds.includes(deviceId)) j.deviceIds.push(deviceId);
        if (patch.name !== undefined) dev.name = patch.name;
        if (patch.state !== undefined) dev.state = patch.state;
        if (patch.step !== undefined) dev.step = patch.step;
        if (patch.progress !== undefined) {
          if (patch.progress === null) delete dev.progress;
          else dev.progress = clamp01(patch.progress);
        }
        if (patch.message !== undefined) {
          if (patch.message === null) delete dev.message;
          else dev.message = patch.message;
        }
        if (patch.error !== undefined) {
          if (patch.error === null) delete dev.error;
          else dev.error = patch.error;
        }
        if ("result" in patch) dev.result = patch.result;
        changed(rec);
      },
      progress(value, message) {
        if (!live()) return;
        rec.manualProgress = true;
        j.progress = value === null ? null : clamp01(value);
        if (message !== undefined) j.message = message;
        changed(rec);
      },
      message(text) {
        if (!live()) return;
        j.message = text;
        changed(rec);
      },
      result(value) {
        if (!live()) return;
        j.result = value;
        changed(rec);
      },
      fail(error) {
        if (!live()) return;
        rec.failError = { ...error };
      },
      waitWhilePaused() {
        if (j.state !== "paused") return Promise.resolve();
        return new Promise<void>((resolve) => rec.pauseWaiters.push(resolve));
      },
      isCancelled: () => rec.cancelRequested,
    };
  }

  function wakePaused(rec: Rec): void {
    const waiters = rec.pauseWaiters;
    rec.pauseWaiters = [];
    for (const w of waiters) w();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  type Outcome = { threw: false } | { threw: true; error: unknown };

  function finish(rec: Rec, outcome: Outcome): void {
    if (rec.finished) return; // exactly once
    rec.finished = true;
    const j = rec.job;
    const t = now();
    let error: JobError | null = rec.failError;
    if (outcome.threw) {
      const e = outcome.error;
      if (e instanceof JobFailure) {
        error = { code: e.code, message: e.message, ...(e.step ? { step: e.step } : {}), ...(e.details !== undefined ? { details: e.details } : {}) };
      } else {
        log(`job ${j.id} (${j.kind}) crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        // A throw caused by our own abort is part of cancelling, not a bug.
        if (!rec.cancelRequested) error = { code: "internal_error", message: "Something went wrong inside the Manager. Its log has the details." };
      }
    }

    // Devices that never reported a final state.
    for (const d of j.devices) {
      if (d.state === "queued" || d.state === "running") {
        const running = d.state === "running";
        if (rec.cancelRequested) d.state = "cancelled";
        else if (running && error) {
          d.state = "failed";
          d.error ??= { code: error.code, message: error.message };
        } else if (running) {
          d.state = "failed";
          d.error ??= { code: "interrupted", message: "The job ended before this device finished." };
        } else d.state = "skipped";
        delete d.progress;
      }
    }

    let state: JobState;
    if (rec.cancelRequested) state = "cancelled";
    else if (error) state = "failed";
    else {
      const bad = j.devices.filter((d) => DEVICE_BAD.has(d.state)).length;
      const ok = j.devices.filter((d) => d.state === "done").length;
      if (bad === 0) state = "succeeded";
      else if (ok > 0) state = "partial";
      else {
        state = "failed";
        error = j.devices.find((d) => d.error)?.error ?? { code: "devices_failed", message: "The job did not finish on any device." };
      }
    }

    // Steps that never reached a final status.
    for (const s of j.steps) {
      if (s.status === "running") {
        s.status = state === "cancelled" ? "cancelled" : state === "failed" ? "failed" : "done";
        s.finishedAt = t;
        delete s.progress;
      } else if (s.status === "pending") {
        s.status = state === "cancelled" ? "cancelled" : "skipped";
      }
    }

    j.state = state;
    j.error = error;
    j.finishedAt = t;
    j.startedAt ??= t;
    if (state === "succeeded") j.progress = 1;
    else if (!rec.manualProgress) j.progress = autoProgress(j);
    changed(rec);
    wakePaused(rec);

    finishedOrder.push(j.id);
    while (finishedOrder.length > keepFinished) {
      const old = finishedOrder.shift();
      if (old) records.delete(old);
    }
    rec.resolveDone(snapshot(rec));
  }

  async function start(rec: Rec): Promise<void> {
    if (rec.finished) return;
    if (rec.cancelRequested) return finish(rec, { threw: false });
    const j = rec.job;
    j.state = "running";
    j.startedAt = now();
    changed(rec);
    try {
      await rec.run(control(rec));
      finish(rec, { threw: false });
    } catch (error) {
      finish(rec, { threw: true, error });
    }
  }

  function need(id: string): Rec {
    const rec = records.get(id);
    if (!rec) throw new HttpError(404, "not_found", `There is no job with the id ${id}. Finished jobs are only kept for a while.`);
    return rec;
  }

  function requestCancel(rec: Rec): void {
    if (rec.finished || rec.cancelRequested) return;
    rec.cancelRequested = true;
    rec.job.state = "cancelling";
    changed(rec);
    wakePaused(rec);
    rec.abort.abort();
  }

  function unavailable(rec: Rec, action: JobAction): HttpError {
    return new HttpError(409, "job_action_unavailable", `This job cannot be ${action === "retry" ? "retried" : action === "cancel" ? "cancelled" : action + "d"} right now (it is ${rec.job.state}).`, {
      state: rec.job.state,
      actions: rec.job.actions,
    });
  }

  async function runHook(rec: Rec, name: string, fn: (() => void | Promise<void>) | undefined): Promise<void> {
    try {
      await fn?.();
    } catch (err) {
      log(`job ${rec.job.id} ${name} hook failed: ${(err as Error).message}`);
    }
  }

  if (dataDir) {
    const loaded = loadHistory(dataDir, log, now());
    for (const job of keepFinished === 0 ? [] : loaded.jobs.slice(-keepFinished)) restore(job);
    if (loaded.dirty) schedulePersist();
  }

  // ---- public API --------------------------------------------------------------------------------------------------

  return {
    create(spec, run) {
      if (closed) throw new Error("The job service is closed.");
      const created = now();
      const devices: JobDeviceResult[] = (spec.devices ?? []).map((d) => ({ deviceId: d.deviceId, ...(d.name ? { name: d.name } : {}), state: "queued" }));
      const deviceIds = [...new Set([...(spec.deviceIds ?? []), ...devices.map((d) => d.deviceId)])];
      const steps: JobStep[] = (spec.steps ?? []).map((s) => ({ id: s.id, label: s.label, status: "pending" }));
      let resolveDone: (job: Job) => void = () => {};
      const done = new Promise<Job>((resolve) => {
        resolveDone = resolve;
      });
      const rec: Rec = {
        job: {
          id: randomUUID(),
          kind: spec.kind,
          title: spec.title,
          state: "queued",
          steps,
          progress: null,
          deviceIds,
          devices,
          params: sanitizeParams(spec.params),
          error: null,
          actions: [],
          createdAt: created,
          updatedAt: created,
          startedAt: null,
          finishedAt: null,
        },
        spec,
        run,
        abort: new AbortController(),
        done,
        resolveDone,
        cancelRequested: false,
        manualProgress: false,
        failError: null,
        retried: false,
        finished: false,
        restored: false,
        pauseWaiters: [],
        lastSent: 0,
        timer: null,
      };
      records.set(rec.job.id, rec);
      changed(rec);
      const first = snapshot(rec);
      queueMicrotask(() => void start(rec));
      return first;
    },

    get: (id) => {
      const rec = records.get(id);
      return rec ? snapshot(rec) : undefined;
    },

    list(filter = {}) {
      const out: Job[] = [];
      for (const rec of [...records.values()].reverse()) {
        if (filter.kind !== undefined && rec.job.kind !== filter.kind) continue;
        if (filter.active !== undefined && filter.active === rec.finished) continue;
        out.push(snapshot(rec));
      }
      return out;
    },

    cancel(id) {
      const rec = need(id);
      requestCancel(rec);
      return snapshot(rec);
    },

    async pause(id) {
      const rec = need(id);
      if (!rec.job.actions.includes("pause")) throw unavailable(rec, "pause");
      rec.job.state = "paused";
      changed(rec);
      const paused = snapshot(rec); // the state this call caused (the body may move on while the hook runs)
      await runHook(rec, "pause", () => rec.spec.onPause?.(paused));
      return paused;
    },

    async resume(id) {
      const rec = need(id);
      if (!rec.job.actions.includes("resume")) throw unavailable(rec, "resume");
      rec.job.state = "running";
      changed(rec);
      const resumed = snapshot(rec);
      wakePaused(rec);
      await runHook(rec, "resume", () => rec.spec.onResume?.(resumed));
      return resumed;
    },

    async retry(id) {
      const rec = need(id);
      if (rec.restored) {
        throw new HttpError(409, "job_action_unavailable", "This job was kept from before the Manager restarted, so it cannot be retried from here. Start the action again from its own screen.", {
          state: rec.job.state,
          actions: rec.job.actions,
        });
      }
      if (!rec.job.actions.includes("retry") || !rec.spec.onRetry) throw unavailable(rec, "retry");
      rec.retried = true;
      changed(rec);
      try {
        const next = await rec.spec.onRetry(snapshot(rec));
        return next ?? snapshot(rec);
      } catch (err) {
        rec.retried = false;
        changed(rec);
        throw err;
      }
    },

    whenDone: (id) => {
      const rec = need(id);
      return rec.done;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    async close(opts = {}) {
      if (closed) return;
      closed = true;
      const timeoutMs = opts.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
      const active = [...records.values()].filter((r) => !r.finished);
      if (dataDir) shutdownSnaps = new Map(active.map((r) => [r.job.id, snapshot(r)]));
      for (const rec of active) requestCancel(rec);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref();
      });
      await Promise.race([Promise.all(active.map((r) => r.done)), timeout]);
      if (timer) clearTimeout(timer);
      for (const rec of active) {
        if (!rec.finished) {
          log(`job ${rec.job.id} (${rec.job.kind}) did not stop within ${timeoutMs} ms; abandoning it`);
          finish(rec, { threw: false });
        }
      }
      for (const rec of records.values()) {
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = null;
      }
      listeners.clear();
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = null;
      await writeNow();
    },
  };
}
