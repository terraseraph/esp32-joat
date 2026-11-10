/**
 * Batch 3: types and TypeBox schemas of the backups track. Owned by that track (nobody else edits this file).
 * Re-exported from `./api`, so the web app imports them as `import type { X } from "@shared/api"`.
 *
 * A backup is a plain JSON file (spec 3.8). `gaps` lists everything the device would not tell us, as stable
 * tokens: `wifi`, `ap_password`, `mqtt_credentials`, `modules_unavailable`, `rules_unavailable` and
 * `pin:<gpio>:<what>` (for example `pin:13:invert/pull/boot`: a pin that was read from the live state, which
 * does not report those options).
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

// ---------------------------------------------------------------------------------------------------------------
// The backup file
// ---------------------------------------------------------------------------------------------------------------

export const BackupPinSchema = Type.Object(
  {
    gpio: Type.Integer({ minimum: 0, maximum: 48 }),
    mode: Type.Union([Type.Literal("out"), Type.Literal("in"), Type.Literal("pwm"), Type.Literal("servo"), Type.Literal("adc")]),
    _from: Type.Union([Type.Literal("shadow"), Type.Literal("live")], {
      description: "shadow = the pin.configure the Manager last sent (complete) · live = derived from the device's live state (may lack invert, pulls, boot, irq)",
    }),
  },
  { additionalProperties: true, description: "A minimal pin.configure object plus `_from`. Other keys are the device's own option names (snake_case)." },
);
export type BackupPin = Static<typeof BackupPinSchema>;

export const BackupModuleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 16 }),
    type: Type.String({ minLength: 1, maxLength: 32 }),
    bus: Type.String({ maxLength: 16 }),
    enabled: Type.Boolean(),
    pins: Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: 48 })),
    settings: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
  },
  { additionalProperties: true },
);
export type BackupModule = Static<typeof BackupModuleSchema>;

const RuleActionSchema = Type.Object({ gpio: Type.Integer({ minimum: 0, maximum: 48 }), value: Type.Number() });

export const BackupRuleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 16 }),
    enabled: Type.Boolean(),
    on: Type.Object({
      gpio: Type.Integer({ minimum: 0, maximum: 48 }),
      op: Type.Union([Type.Literal("gt"), Type.Literal("ge"), Type.Literal("lt"), Type.Literal("le"), Type.Literal("eq"), Type.Literal("ne")]),
      value: Type.Number(),
    }),
    then: RuleActionSchema,
    else: Type.Optional(RuleActionSchema),
  },
  { additionalProperties: true },
);
export type BackupRule = Static<typeof BackupRuleSchema>;

export const BackupMqttSchema = Type.Object(
  { uri: Type.String({ maxLength: 200 }), root: Type.String({ maxLength: 64 }) },
  { additionalProperties: false, description: "Non-secret MQTT settings. The user name and password are never in a backup." },
);

export const BackupFileSchema = Type.Object(
  {
    kind: Type.Literal("de-esp32-backup"),
    v: Type.Literal(1),
    createdAt: Type.String({ minLength: 10, maxLength: 40, description: "ISO 8601" }),
    manager: Type.String({ maxLength: 40, description: "Manager version that made the file" }),
    source: Type.Object({
      id: Type.String({ maxLength: 64 }),
      name: Type.String({ maxLength: 80 }),
      app_version: Type.String({ maxLength: 40 }),
      board_id: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    name: Type.String({ maxLength: 80, description: "The device's name when the backup was made" }),
    pins: Type.Array(BackupPinSchema, { maxItems: 48 }),
    modules: Type.Array(BackupModuleSchema, { maxItems: 8 }),
    rules: Type.Array(BackupRuleSchema, { maxItems: 8 }),
    mqtt: Type.Union([BackupMqttSchema, Type.Null()], { description: "null when the device had no MQTT broker configured" }),
    gaps: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 200, description: "What could not be captured (stable tokens, see the file header)" }),
    note: Type.Optional(Type.String({ maxLength: 500, description: "Free text added in the Manager (not part of spec 3.8)" })),
  },
  { additionalProperties: false },
);
export type BackupFile = Static<typeof BackupFileSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------------------------

export const BackupMetaSchema = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  source: Type.Object({ id: Type.String(), name: Type.String(), app_version: Type.String() }),
  name: Type.String(),
  counts: Type.Object({ pins: Type.Integer(), modules: Type.Integer(), rules: Type.Integer() }),
  gaps: Type.Array(Type.String()),
  size: Type.Integer({ description: "Bytes of the stored file" }),
  note: Type.String({ description: "Empty when none" }),
});
export type BackupMeta = Static<typeof BackupMetaSchema>;

export const BackupIdParamsSchema = Type.Object({ bid: Type.String() });

export const BackupListQuerySchema = Type.Object({ deviceId: Type.Optional(Type.String({ description: "Only backups made from this device" })) });
export type BackupListQuery = Static<typeof BackupListQuerySchema>;

export const BackupNowBodySchema = Type.Object({ note: Type.Optional(Type.String({ maxLength: 500 })) });
export type BackupNowBody = Static<typeof BackupNowBodySchema>;

export const BackupDownloadQuerySchema = Type.Object({ download: Type.Optional(Type.Boolean({ description: "1 = send as an attachment named <name>-<date>.json" })) });

export const BackupPatchBodySchema = Type.Object({ note: Type.String({ maxLength: 500 }) });
export type BackupPatchBody = Static<typeof BackupPatchBodySchema>;

// ---------------------------------------------------------------------------------------------------------------
// Plan / apply / clone
// ---------------------------------------------------------------------------------------------------------------

export const BackupIncludeSchema = Type.Object(
  {
    pins: Type.Optional(Type.Boolean()),
    modules: Type.Optional(Type.Boolean()),
    rules: Type.Optional(Type.Boolean()),
    mqtt: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.Boolean()),
  },
  { description: "What to restore. Defaults: pins, modules, rules and mqtt true; `name` false for both restore and clone (opt in with `name: true`)." },
);
export type BackupInclude = Static<typeof BackupIncludeSchema>;

export const BackupTargetsBodySchema = Type.Object({
  targetIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
  include: Type.Optional(BackupIncludeSchema),
});
export type BackupTargetsBody = Static<typeof BackupTargetsBodySchema>;

export const BackupCloneBodySchema = Type.Object({
  sourceId: Type.String(),
  targetIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
  include: Type.Optional(BackupIncludeSchema),
  saveSnapshot: Type.Optional(Type.Boolean({ description: "Also keep the fresh snapshot of the source as a normal backup (POST /api/clone only)" })),
});
export type BackupCloneBody = Static<typeof BackupCloneBodySchema>;

export const BackupStepOpSchema = Type.Union([
  Type.Literal("rule.remove"),
  Type.Literal("module.remove"),
  Type.Literal("pin.disable"),
  Type.Literal("pin.configure"),
  Type.Literal("module.add"),
  Type.Literal("module.configure"),
  Type.Literal("rule.set"),
  Type.Literal("mqtt.configure"),
  Type.Literal("identity.set_name"),
]);
export type BackupStepOp = Static<typeof BackupStepOpSchema>;

export const BackupPlanStepSchema = Type.Object({
  id: Type.String({ description: "Unique within the plan, e.g. `pin.configure:4`" }),
  op: BackupStepOpSchema,
  summary: Type.String({ description: "Plain words, e.g. \"Set GPIO 4 to output (inverted)\"" }),
  cmd: Type.Record(Type.String(), Type.Unknown(), { description: "The exact device command that will be sent (`pin.disable` is a `pin.configure` with mode `disabled`)" }),
});
export type BackupPlanStep = Static<typeof BackupPlanStepSchema>;

export const BackupPlanSchema = Type.Object({
  targetId: Type.String(),
  targetName: Type.String(),
  reachable: Type.Boolean(),
  error: Nullable(Type.String()),
  steps: Type.Array(BackupPlanStepSchema, { description: "In the order they run. Empty = nothing to change" }),
  conflicts: Type.Array(Type.Object({ message: Type.String() }), { description: "Things that cannot be applied as asked; the steps that would collide are left out of `steps`" }),
  warnings: Type.Array(Type.String()),
  unchanged: Type.Object({ pins: Type.Integer(), modules: Type.Integer(), rules: Type.Integer() }, { description: "How many items already match the target (no step needed)" }),
});
export type BackupPlan = Static<typeof BackupPlanSchema>;

export const BackupPlanResponseSchema = Type.Object({ plans: Type.Array(BackupPlanSchema) });
export type BackupPlanResponse = Static<typeof BackupPlanResponseSchema>;

/** `result` of a device row of a `backup-apply` job. */
export const BackupApplyResultSchema = Type.Object({
  applied: Type.Integer({ description: "Steps that went through" }),
  total: Type.Integer({ description: "Steps in the plan" }),
  failedStep: Type.Optional(Type.String({ description: "Id of the step that stopped this device" })),
});
export type BackupApplyResult = Static<typeof BackupApplyResultSchema>;

/** `result` of a `backup-apply` job. */
export const BackupApplyJobResultSchema = Type.Object({
  backupId: Nullable(Type.String()),
  devices: Type.Integer(),
  ok: Type.Integer(),
  failed: Type.Integer(),
});
export type BackupApplyJobResult = Static<typeof BackupApplyJobResultSchema>;
