import type { Job } from "@shared/api";

/** A running OTA job with sensible defaults for tests; override what the test is about. */
export function makeJob(over: Partial<Job> & { id: string }): Job {
  return {
    kind: "ota",
    title: "Update Bench node",
    state: "running",
    steps: [],
    progress: 0.25,
    deviceIds: [],
    devices: [],
    params: {},
    error: null,
    actions: ["cancel"],
    createdAt: "2026-11-10T09:00:00.000Z",
    updatedAt: "2026-11-10T09:00:01.000Z",
    startedAt: "2026-11-10T09:00:00.100Z",
    finishedAt: null,
    ...over,
  };
}
