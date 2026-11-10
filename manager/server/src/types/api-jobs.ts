/**
 * Generic job contract (batch 3). Every long-running thing the Manager does (SoftAP setup, IP change, firmware
 * update, applying a backup) is a Job: the server runs it, the web app renders it with the shared `JobProgress`
 * component. Documented in `API.md` under "Jobs". Web code must only `import type` from here.
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const JobKindSchema = Type.Union([Type.Literal("setup"), Type.Literal("ip-change"), Type.Literal("ota"), Type.Literal("backup-apply"), Type.Literal("wifi-move")], {
  description: "What the job does: setup (SoftAP setup of a new board) · ip-change · ota (firmware update) · backup-apply (restore a backup) · wifi-move (move a device to another Wi-Fi network)",
});
export type JobKind = Static<typeof JobKindSchema>;

export const JobStateSchema = Type.Union(
  [
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("cancelling"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("partial"),
    Type.Literal("cancelled"),
    Type.Literal("interrupted"),
  ],
  {
    description:
      "queued (just created) · running · paused · cancelling (cancel asked, the job is still winding down) · succeeded · failed · partial (finished; some devices ok, some not) · cancelled · interrupted (the Manager stopped while the job was running; only seen on jobs loaded from the history after a restart)",
  },
);
export type JobState = Static<typeof JobStateSchema>;

export const JobStepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("cancelled"),
]);
export type JobStepStatus = Static<typeof JobStepStatusSchema>;

export const JobStepSchema = Type.Object({
  id: Type.String(),
  label: Type.String({ description: "Plain words for a person" }),
  status: JobStepStatusSchema,
  detail: Type.Optional(Type.String({ description: "Extra line under the label (current device, address, retry count ...)" })),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "0..1, only while the step has a measurable progress" })),
  startedAt: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.String()),
});
export type JobStep = Static<typeof JobStepSchema>;

export const JobErrorSchema = Type.Object({
  code: Type.String({ description: "snake_case machine code" }),
  message: Type.String({ description: "Plain words for a person" }),
  step: Type.Optional(Type.String({ description: "Id of the step that failed" })),
  details: Type.Optional(Type.Unknown()),
});
export type JobError = Static<typeof JobErrorSchema>;

export const JobDeviceStateSchema = Type.Union(
  [
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
    Type.Literal("cancelled"),
    Type.Literal("rolled_back"),
    Type.Literal("reverted"),
  ],
  { description: "Per-device outcome inside a multi-device job. rolled_back / reverted: the change was undone (by the device or by the Manager)." },
);
export type JobDeviceState = Static<typeof JobDeviceStateSchema>;

export const JobDeviceResultSchema = Type.Object({
  deviceId: Type.String(),
  name: Type.Optional(Type.String()),
  state: JobDeviceStateSchema,
  step: Type.Optional(Type.String({ description: "Id of the step this device is on" })),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  message: Type.Optional(Type.String()),
  error: Type.Optional(JobErrorSchema),
  result: Type.Optional(Type.Unknown()),
});
export type JobDeviceResult = Static<typeof JobDeviceResultSchema>;

export const JobActionSchema = Type.Union([Type.Literal("cancel"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("retry")]);
export type JobAction = Static<typeof JobActionSchema>;

export const JobSchema = Type.Object({
  id: Type.String(),
  kind: JobKindSchema,
  title: Type.String({ description: "One line for a person, e.g. \"Update 3 devices to 0.2.0\"" }),
  state: JobStateSchema,
  steps: Type.Array(JobStepSchema, { description: "Job-level steps (single-device jobs and setup); may be empty for bulk jobs" }),
  progress: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
  message: Type.Optional(Type.String({ description: "Current human status line" })),
  deviceIds: Type.Array(Type.String()),
  devices: Type.Array(JobDeviceResultSchema, { description: "One entry per device (empty for setup jobs until a device is known)" }),
  params: Type.Record(Type.String(), Type.Unknown(), { description: "Public summary of the request. Never contains secrets" }),
  result: Type.Optional(Type.Unknown({ description: "Kind-specific outcome" })),
  error: Nullable(JobErrorSchema),
  actions: Type.Array(JobActionSchema, { description: "What the caller may do right now" }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  startedAt: Nullable(Type.String()),
  finishedAt: Nullable(Type.String()),
});
export type Job = Static<typeof JobSchema>;

export const JobListQuerySchema = Type.Object({
  kind: Type.Optional(JobKindSchema),
  active: Type.Optional(Type.Boolean({ description: "true = only jobs that have not finished, false = only finished ones" })),
});
export type JobListQuery = Static<typeof JobListQuerySchema>;

export const JobIdParamsSchema = Type.Object({ id: Type.String() });

/** States a job never leaves. The WebSocket push is `{ t: "job", job }` (see `BrowserWsMessage`). */
export const TERMINAL_JOB_STATES: readonly JobState[] = ["succeeded", "failed", "partial", "cancelled", "interrupted"];
