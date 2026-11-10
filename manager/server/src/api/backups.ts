import { Type } from "@sinclair/typebox";
import { validateBackup } from "../backups";
import { DeviceError } from "../device/client";
import { HttpError } from "../http/errors";
import { defineRoute, type Route } from "../http/router";
import { DeviceTransportErrorSchema } from "../types/api";
import {
  BackupCloneBodySchema,
  BackupDownloadQuerySchema,
  BackupFileSchema,
  BackupIdParamsSchema,
  BackupListQuerySchema,
  BackupMetaSchema,
  BackupNowBodySchema,
  BackupPatchBodySchema,
  BackupPlanResponseSchema,
  BackupTargetsBodySchema,
  type BackupFile,
} from "../types/api-backups";
import { JobSchema } from "../types/api-jobs";
import { transportFailure } from "./deviceCall";

const DeviceIdParams = Type.Object({ id: Type.String() });

const unknownBackup = (bid: string): HttpError => new HttpError(404, "unknown_backup", `There is no backup with id "${bid}". List them with GET /api/backups.`);

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "backup";

/** Backups: snapshot, store, plan, apply, clone (spec 3.8). Documented in API.md under "Backups". */
export const backupRoutes: Route[] = [
  defineRoute({
    method: "GET",
    path: "/api/backups",
    summary: "List backups",
    description: "Stored backups, newest first. `deviceId` keeps only those made from that device.",
    tags: ["backups"],
    query: BackupListQuerySchema,
    response: Type.Array(BackupMetaSchema),
    handler: ({ query, app }) => ({ body: app.backups.store.list(query.deviceId) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/backup",
    summary: "Back up a device now",
    description: "Reads the device's pins, add-ons, rules, MQTT settings, name and board, and stores a backup file.",
    tags: ["backups"],
    params: DeviceIdParams,
    body: BackupNowBodySchema,
    optionalBody: true,
    response: BackupMetaSchema,
    responses: {
      201: { description: "The stored backup", schema: BackupMetaSchema },
      404: { description: "unknown_device" },
      409: { description: "device_offline" },
      502: { description: "Device unreachable / timed out / answered nonsense (transport:true)", schema: DeviceTransportErrorSchema },
    },
    handler: async ({ params, body, app }) => {
      try {
        return { status: 201, body: await app.backups.backupNow(params.id, body.note) };
      } catch (err) {
        if (err instanceof DeviceError) return transportFailure(err) as never;
        throw err;
      }
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/backups/import",
    summary: "Import a backup file",
    description: "The body is a backup file as downloaded. It is validated strictly; `422 invalid_backup` says what is wrong in plain words.",
    tags: ["backups"],
    body: Type.Record(Type.String(), Type.Unknown()),
    response: BackupMetaSchema,
    responses: { 201: { description: "The stored backup (new id)", schema: BackupMetaSchema }, 422: { description: "invalid_backup" } },
    handler: async ({ body, app }) => {
      const v = validateBackup(body);
      if (!v.ok) throw new HttpError(422, "invalid_backup", v.reason);
      return { status: 201, body: await app.backups.store.add(v.file) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/api/backups/:bid",
    summary: "Get a backup file",
    description: "The backup file JSON. `?download=1` adds a `Content-Disposition: attachment` header named `<name>-<date>.json`.",
    tags: ["backups"],
    params: BackupIdParamsSchema,
    query: BackupDownloadQuerySchema,
    response: BackupFileSchema,
    responses: { 404: { description: "unknown_backup" } },
    handler: async ({ params, query, app }) => {
      const file = await app.backups.store.read(params.bid);
      if (!file) throw unknownBackup(params.bid);
      const headers = query.download ? { "Content-Disposition": `attachment; filename="${safeName(file.name)}-${file.createdAt.slice(0, 10)}.json"` } : undefined;
      return { body: file, ...(headers ? { headers } : {}) };
    },
  }),

  defineRoute({
    method: "PATCH",
    path: "/api/backups/:bid",
    summary: "Change a backup's note",
    tags: ["backups"],
    params: BackupIdParamsSchema,
    body: BackupPatchBodySchema,
    response: BackupMetaSchema,
    responses: { 404: { description: "unknown_backup" } },
    handler: async ({ params, body, app }) => {
      const meta = await app.backups.store.setNote(params.bid, body.note);
      if (!meta) throw unknownBackup(params.bid);
      return { body: meta };
    },
  }),

  defineRoute({
    method: "DELETE",
    path: "/api/backups/:bid",
    summary: "Delete a backup",
    tags: ["backups"],
    params: BackupIdParamsSchema,
    response: Type.Null(),
    responses: { 204: { description: "Deleted" }, 404: { description: "unknown_backup" } },
    handler: async ({ params, app }) => {
      if (!(await app.backups.store.remove(params.bid))) throw unknownBackup(params.bid);
      return { status: 204 };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/backups/:bid/plan",
    summary: "Plan a restore",
    description:
      "Reads each target (reads only) and returns the steps that would make it match the backup, in the order they run. Nothing already equal produces a step. An unreachable target has `reachable: false` and an `error`. `include` defaults to everything.",
    tags: ["backups"],
    params: BackupIdParamsSchema,
    body: BackupTargetsBodySchema,
    response: BackupPlanResponseSchema,
    responses: { 404: { description: "unknown_backup or unknown_device" } },
    handler: async ({ params, body, app }) => {
      const file = await app.backups.store.read(params.bid);
      if (!file) throw unknownBackup(params.bid);
      const targets = app.backups.resolveTargets(body.targetIds);
      return { body: { plans: await app.backups.plan(file, targets, body.include, { clone: false }) } };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/backups/:bid/apply",
    summary: "Restore a backup onto devices",
    description: "Starts a `backup-apply` job: one device row per target, steps in plan order, a failed step stops that target only. See \"Backups\" above.",
    tags: ["backups"],
    params: BackupIdParamsSchema,
    body: BackupTargetsBodySchema,
    response: JobSchema,
    responses: { 201: { description: "The job", schema: JobSchema }, 404: { description: "unknown_backup or unknown_device" } },
    handler: async ({ params, body, app }) => {
      const file = await app.backups.store.read(params.bid);
      if (!file) throw unknownBackup(params.bid);
      const targets = app.backups.resolveTargets(body.targetIds);
      return { status: 201, body: app.backups.apply(file, params.bid, targets, body.include, { clone: false }) };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/clone/plan",
    summary: "Plan a clone",
    description: "Takes a fresh snapshot of the source (not stored) and plans it onto each target. `name` is excluded unless `include.name` is true. 400 `invalid_targets` when a target is the source.",
    tags: ["backups"],
    body: BackupCloneBodySchema,
    response: BackupPlanResponseSchema,
    responses: {
      404: { description: "unknown_device" },
      409: { description: "device_offline (the source)" },
      502: { description: "The source could not be read (transport:true)", schema: DeviceTransportErrorSchema },
    },
    handler: async ({ body, app }) => {
      const targets = app.backups.resolveTargets(body.targetIds, body.sourceId);
      try {
        const file: BackupFile = await app.backups.snapshot(body.sourceId);
        return { body: { plans: await app.backups.plan(file, targets, body.include, { clone: true }) } };
      } catch (err) {
        if (err instanceof DeviceError) return transportFailure(err) as never;
        throw err;
      }
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/clone",
    summary: "Clone one device onto others",
    description: "Snapshots the source now and starts a `backup-apply` job on the targets. The snapshot is kept as a normal backup only with `saveSnapshot: true`.",
    tags: ["backups"],
    body: BackupCloneBodySchema,
    response: JobSchema,
    responses: {
      201: { description: "The job", schema: JobSchema },
      400: { description: "invalid_targets" },
      404: { description: "unknown_device" },
      409: { description: "device_offline (the source)" },
      502: { description: "The source could not be read (transport:true)", schema: DeviceTransportErrorSchema },
    },
    handler: async ({ body, app }) => {
      const targets = app.backups.resolveTargets(body.targetIds, body.sourceId);
      try {
        const file = await app.backups.snapshot(body.sourceId);
        const saved = body.saveSnapshot ? await app.backups.store.add(file) : null;
        return { status: 201, body: app.backups.apply(file, saved?.id ?? null, targets, body.include, { clone: true }) };
      } catch (err) {
        if (err instanceof DeviceError) return transportFailure(err) as never;
        throw err;
      }
    },
  }),
];
