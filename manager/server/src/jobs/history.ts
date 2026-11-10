import { Value } from "@sinclair/typebox/value";
import { readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { atomicWrite } from "../store/atomicWrite";
import { JobSchema, type Job, type JobState } from "../types/api-jobs";
import { sanitizeParams, sanitizeValue } from "./sanitize";

/**
 * Persisted job history (`<dataDir>/jobs.json`, spec 3.7). The file holds the public `Job` objects exactly as the API
 * returns them, oldest first. Jobs that were not finished when the file was written come back as `interrupted`.
 */

export const HISTORY_FILE = "jobs.json";
export const INTERRUPTED_MESSAGE = "The Manager stopped while this job was running";

const FINISHED_STATES: ReadonlySet<JobState> = new Set(["succeeded", "failed", "partial", "cancelled", "interrupted"]);

interface HistoryFile {
  version: 1;
  jobs: Job[];
}

/** A copy of `job` that is safe to write: params, results and error details are cleaned of secret-looking keys again. */
export function scrubJob(job: Job): Job {
  const out: Job = {
    ...job,
    params: sanitizeParams(job.params),
    devices: job.devices.map((d) => {
      const { result, error, ...rest } = d;
      return {
        ...rest,
        ...(error ? { error: scrubError(error) } : {}),
        ...(result !== undefined ? { result: sanitizeValue(result) } : {}),
      };
    }),
    error: job.error ? scrubError(job.error) : null,
  };
  if (job.result !== undefined) out.result = sanitizeValue(job.result);
  return out;
}

function scrubError(e: NonNullable<Job["error"]>): NonNullable<Job["error"]> {
  const { details, ...rest } = e;
  return details === undefined ? rest : { ...rest, details: sanitizeValue(details) };
}

export async function writeHistory(dataDir: string, jobs: Job[]): Promise<void> {
  const body: HistoryFile = { version: 1, jobs: jobs.map(scrubJob) };
  await atomicWrite(path.join(dataDir, HISTORY_FILE), JSON.stringify(body));
}

/** A job that was not finished when the Manager stopped: a terminal `interrupted` job with no actions. */
export function interruptedJob(job: Job, loadedAt: string): Job {
  const finishedAt = typeof job.updatedAt === "string" && job.updatedAt !== "" ? job.updatedAt : loadedAt;
  return {
    ...job,
    state: "interrupted",
    message: INTERRUPTED_MESSAGE,
    error: { code: "interrupted", message: INTERRUPTED_MESSAGE },
    actions: [],
    startedAt: job.startedAt ?? finishedAt,
    finishedAt,
    steps: job.steps.map((s) => {
      if (s.status === "running") {
        const { progress: _p, ...rest } = s;
        return { ...rest, status: "failed", finishedAt };
      }
      return s.status === "pending" ? { ...s, status: "skipped" } : s;
    }),
    devices: job.devices.map((d) => {
      if (d.state === "queued") return { ...d, state: "skipped" };
      if (d.state !== "running") return d;
      const { progress: _p, ...rest } = d;
      return { ...rest, state: "failed", error: d.error ?? { code: "interrupted", message: INTERRUPTED_MESSAGE } };
    }),
  };
}

export interface LoadedHistory {
  /** Oldest first, all finished (unfinished ones already turned into `interrupted`). */
  jobs: Job[];
  /** Something was converted or dropped: the file should be rewritten. */
  dirty: boolean;
}

/**
 * Read the history synchronously (the job service is created synchronously). A missing file is an empty history; a corrupt
 * one is logged and moved aside as `jobs.json.corrupt-<time>`; entries that do not look like jobs are dropped. Never throws.
 */
export function loadHistory(dataDir: string, log: (msg: string) => void, loadedAt: string): LoadedHistory {
  const file = path.join(dataDir, HISTORY_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`job history ${file} cannot be read: ${(err as Error).message}`);
    return { jobs: [], dirty: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    quarantine(file, `it is not valid JSON (${(err as Error).message})`, log);
    return { jobs: [], dirty: false };
  }
  const list = (parsed as Partial<HistoryFile> | null)?.jobs;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(list)) {
    quarantine(file, "it has no jobs list", log);
    return { jobs: [], dirty: false };
  }
  const jobs: Job[] = [];
  let dirty = false;
  const seen = new Set<string>();
  for (const item of list) {
    if (!Value.Check(JobSchema, item) || seen.has(item.id)) {
      dirty = true;
      continue;
    }
    seen.add(item.id);
    if (FINISHED_STATES.has(item.state)) {
      jobs.push(item.actions.length > 0 ? { ...item, actions: [] } : item);
    } else {
      jobs.push(interruptedJob(item, loadedAt));
      dirty = true;
    }
  }
  if (dirty) log(`job history: ${list.length - jobs.length} unusable entries dropped, unfinished jobs marked interrupted`);
  return { jobs, dirty };
}

function quarantine(file: string, why: string, log: (msg: string) => void): void {
  const aside = `${file}.corrupt-${Date.now()}`;
  log(`job history ${file} ignored: ${why}; moved to ${aside}`);
  try {
    renameSync(file, aside);
  } catch (err) {
    log(`could not move ${file} aside: ${(err as Error).message}`);
  }
}
