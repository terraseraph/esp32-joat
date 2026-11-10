/**
 * Batch 3: types and TypeBox schemas of the firmware / OTA track. Owned by that track (nobody else edits this file).
 * Re-exported from `./api`, so the web app imports them as `import type { X } from "@shared/api"`.
 *
 * Routes (documented in `API.md` under "Firmware"): `GET/POST /api/firmware`, `POST /api/firmware/latest`,
 * `DELETE /api/firmware/:fid`, `PUT /api/firmware/target`, `POST /api/firmware/update` (bulk),
 * `POST /api/devices/:id/ota`, `POST /api/devices/:id/rollback`. The OTA jobs themselves are generic `Job`s (kind `ota`).
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const FirmwareImageSourceSchema = Type.Union([Type.Literal("upload"), Type.Literal("latest")], {
  description: "upload = added from a file · latest = fetched from the firmware web page (the \"Pages URL\")",
});
export type FirmwareImageSource = Static<typeof FirmwareImageSourceSchema>;

export const FirmwareImageSchema = Type.Object({
  id: Type.String({ description: "SHA-256 of the file (64 lower-case hex chars). Adding the same file twice gives the same id." }),
  filename: Type.String({ description: "Name the file had when it was added" }),
  size: Type.Integer({ description: "Bytes" }),
  version: Type.String({ description: "The image's `app_version` (what a device reports as `ota.app_version`), e.g. `1bf09cc`" }),
  project: Type.String({ description: "Always `de_esp32_runtime`; other projects are refused" }),
  date: Type.String({ description: "Build date as the compiler wrote it, e.g. `Sep 24 2026`" }),
  time: Type.String({ description: "Build time, e.g. `10:32:26`" }),
  idfVer: Type.String({ description: "ESP-IDF version the image was built with, e.g. `v5.4.2`" }),
  chip: Type.Literal("esp32", { description: "Chip the image is for. Only the classic ESP32 is accepted" }),
  source: FirmwareImageSourceSchema,
  addedAt: Type.String({ description: "ISO time the image was added to the library" }),
});
export type FirmwareImage = Static<typeof FirmwareImageSchema>;

export const FirmwareLatestInfoSchema = Type.Object({
  baseUrl: Type.String({ description: "The \"Pages URL\" (setting `firmwareBaseUrl`); the image is fetched from `<baseUrl>/firmware/de_esp32_runtime.bin`" }),
  checkedAt: Nullable(Type.String({ description: "ISO time of the last attempt to fetch the latest image (null = never since the Manager started)" })),
  imageId: Nullable(Type.String({ description: "Library id of the image the last successful fetch produced" })),
  error: Nullable(Type.String({ description: "Plain-words reason the last attempt failed (null = it worked or never ran)" })),
});
export type FirmwareLatestInfo = Static<typeof FirmwareLatestInfoSchema>;

export const FirmwareListResponseSchema = Type.Object({
  images: Type.Array(FirmwareImageSchema, { description: "Newest first" }),
  targetId: Nullable(Type.String({ description: "Id of the target image, null = none chosen (then `fwMatchesTarget` of every device is null)" })),
  latest: FirmwareLatestInfoSchema,
});
export type FirmwareListResponse = Static<typeof FirmwareListResponseSchema>;

export const FirmwareIdParamsSchema = Type.Object({ fid: Type.String() });

export const FirmwareTargetBodySchema = Type.Object(
  { firmwareId: Nullable(Type.String({ description: "Image id, or null to clear the target" })) },
  { additionalProperties: false },
);
export type FirmwareTargetBody = Static<typeof FirmwareTargetBodySchema>;

export const OtaStartBodySchema = Type.Object({ firmwareId: Type.String({ description: "Id of an image in the library" }) }, { additionalProperties: false });
export type OtaStartBody = Static<typeof OtaStartBodySchema>;

export const FirmwareBulkBodySchema = Type.Object(
  {
    deviceIds: Type.Array(Type.String(), { minItems: 1, maxItems: 200, description: "Devices to update (registered ids)" }),
    firmwareId: Type.String({ description: "Id of an image in the library" }),
    concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Devices updated at the same time (default 2)" })),
    stopOnFailures: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 200, description: "The job pauses itself after this many devices failed or rolled back (default 1)" }),
    ),
    skipSame: Type.Optional(Type.Boolean({ description: "Skip devices that already run this image (default true)" })),
  },
  { additionalProperties: false },
);
export type FirmwareBulkBody = Static<typeof FirmwareBulkBodySchema>;

/** `step` ids a device row (and the job steps of a single-device update) go through. */
export const OTA_STEPS = ["checking", "uploading", "rebooting", "verifying"] as const;
export type OtaStep = (typeof OTA_STEPS)[number];

/** `JobDeviceResult.result` of a finished device in an `ota` job (also `Job.result` of a single-device update or rollback). */
export interface OtaDeviceResult {
  fromVersion: string;
  toVersion: string;
  /** Partition the device runs from afterwards (`ota_0` / `ota_1`) */
  partition: string;
}

/** `Job.result` of a bulk update. */
export interface OtaBulkResult {
  updated: number;
  skipped: number;
  failed: number;
  rolledBack: number;
  cancelled: number;
}
