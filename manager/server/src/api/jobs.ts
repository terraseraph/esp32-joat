import { Type } from "@sinclair/typebox";
import { HttpError } from "../http/errors";
import { defineRoute } from "../http/router";
import { JobIdParamsSchema, JobListQuerySchema, JobSchema } from "../types/api-jobs";

const NOT_FOUND = { description: "not_found (unknown job id, or a finished job that was dropped from the last 50)" };
const UNAVAILABLE = { description: "job_action_unavailable (the action is not in the job's `actions`)" };

export const jobRoutes = [
  defineRoute({
    method: "GET",
    path: "/api/jobs",
    summary: "List jobs",
    description: "Active jobs plus the most recent finished ones (the Manager keeps the last 50 in memory), newest first. `kind` filters by kind, `active=true` keeps only unfinished jobs, `active=false` only finished ones.",
    tags: ["jobs"],
    query: JobListQuerySchema,
    response: Type.Array(JobSchema),
    handler: ({ app, query }) => ({
      body: app.jobs.list({ ...(query.kind !== undefined ? { kind: query.kind } : {}), ...(query.active !== undefined ? { active: query.active } : {}) }),
    }),
  }),

  defineRoute({
    method: "GET",
    path: "/api/jobs/:id",
    summary: "Get one job",
    tags: ["jobs"],
    params: JobIdParamsSchema,
    response: JobSchema,
    responses: { 404: NOT_FOUND },
    handler: ({ app, params }) => {
      const job = app.jobs.get(params.id);
      if (!job) throw new HttpError(404, "not_found", `There is no job with the id ${params.id}. Finished jobs are only kept for a while.`);
      return { body: job };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/jobs/:id/cancel",
    summary: "Cancel a job",
    description: "Asks the job to stop. It answers with the job in state `cancelling` and becomes `cancelled` once the job has wound down (undoing what it can). Idempotent: a finished or already cancelling job is returned unchanged.",
    tags: ["jobs"],
    params: JobIdParamsSchema,
    response: JobSchema,
    responses: { 404: NOT_FOUND },
    handler: ({ app, params }) => ({ body: app.jobs.cancel(params.id) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/jobs/:id/pause",
    summary: "Pause a job",
    description: "Only for jobs that list `pause` in `actions` (running jobs that support it). The job stops at its next safe point.",
    tags: ["jobs"],
    params: JobIdParamsSchema,
    response: JobSchema,
    responses: { 404: NOT_FOUND, 409: UNAVAILABLE },
    handler: async ({ app, params }) => ({ body: await app.jobs.pause(params.id) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/jobs/:id/resume",
    summary: "Resume a paused job",
    tags: ["jobs"],
    params: JobIdParamsSchema,
    response: JobSchema,
    responses: { 404: NOT_FOUND, 409: UNAVAILABLE },
    handler: async ({ app, params }) => ({ body: await app.jobs.resume(params.id) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/jobs/:id/retry",
    summary: "Retry a finished job",
    description: "Only for finished jobs that list `retry` in `actions`. Usually starts a NEW job and answers with it; use its `id` from then on. A job can be retried once.",
    tags: ["jobs"],
    params: JobIdParamsSchema,
    response: JobSchema,
    responses: { 404: NOT_FOUND, 409: UNAVAILABLE },
    handler: async ({ app, params }) => ({ body: await app.jobs.retry(params.id) }),
  }),
];
