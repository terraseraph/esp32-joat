import { Type } from "@sinclair/typebox";
import { HttpError } from "../http/errors";
import { defineRoute, type Route } from "../http/router";
import { JobSchema } from "../types/api-jobs";
import {
  FirmwareBulkBodySchema,
  FirmwareIdParamsSchema,
  FirmwareImageSchema,
  FirmwareListResponseSchema,
  FirmwareTargetBodySchema,
  OtaStartBodySchema,
} from "../types/api-firmware";
import { MAX_IMAGE_BYTES } from "../firmware";

const DeviceIdParams = Type.Object({ id: Type.String() });

const tooLarge = (): HttpError =>
  new HttpError(422, "invalid_image", `This file is larger than ${MAX_IMAGE_BYTES / 1048576} MB, so it is not a firmware image.`, {
    reason: `This file is larger than ${MAX_IMAGE_BYTES / 1048576} MB, so it is not a firmware image.`,
  });

/** Firmware library, target, "Get latest", single/bulk OTA and rollback (batch 3). Documented in API.md under "Firmware". */
export const firmwareRoutes: Route[] = [
  defineRoute({
    method: "GET",
    path: "/api/firmware",
    summary: "List the firmware library",
    description: "Images (newest first), the target image id and the state of the last \"Get latest\".",
    tags: ["firmware"],
    response: FirmwareListResponseSchema,
    handler: ({ app }) => ({ body: app.firmware.list() }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/firmware",
    summary: "Add a firmware image",
    description: "Raw `application/octet-stream` body, name in the `X-Filename` header. 201 when new, 200 when the same file is already in the library.",
    tags: ["firmware"],
    rawBody: true,
    response: FirmwareImageSchema,
    responses: { 201: { description: "Added", schema: FirmwareImageSchema }, 422: { description: "invalid_image (reason in plain words)" } },
    handler: async ({ req, app }) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        await discard(req, 0);
        throw tooLarge();
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_IMAGE_BYTES) {
          await discard(req, size);
          throw tooLarge();
        }
        chunks.push(c as Buffer);
      }
      const header = req.headers["x-filename"];
      const filename = typeof header === "string" ? safeDecode(header) : "firmware.bin";
      const { image, created } = await app.firmware.addImage(Buffer.concat(chunks), filename, "upload");
      return { status: created ? 201 : 200, body: image };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/firmware/latest",
    summary: "Get the latest firmware from the firmware web page",
    description: "Fetches `<firmwareBaseUrl>/firmware/de_esp32_runtime.bin` and adds it to the library. 502 fetch_failed when it cannot be fetched.",
    tags: ["firmware"],
    response: FirmwareImageSchema,
    responses: { 201: { description: "Added", schema: FirmwareImageSchema }, 502: { description: "fetch_failed" }, 422: { description: "invalid_image" } },
    handler: async ({ app }) => {
      const { image, created } = await app.firmware.fetchLatest();
      return { status: created ? 201 : 200, body: image };
    },
  }),

  defineRoute({
    method: "PUT",
    path: "/api/firmware/target",
    summary: "Choose the target firmware",
    description: "`{ firmwareId: null }` clears it. Drives `fwMatchesTarget` of every device summary.",
    tags: ["firmware"],
    body: FirmwareTargetBodySchema,
    response: FirmwareListResponseSchema,
    responses: { 404: { description: "unknown_image" } },
    handler: async ({ app, body }) => ({ body: await app.firmware.setTarget(body.firmwareId) }),
  }),

  defineRoute({
    method: "DELETE",
    path: "/api/firmware/:fid",
    summary: "Remove a firmware image",
    description: "204. 404 unknown_image; 409 image_in_use while an active job uses it.",
    tags: ["firmware"],
    params: FirmwareIdParamsSchema,
    response: Type.Null(),
    responses: { 204: { description: "Removed" }, 404: { description: "unknown_image" }, 409: { description: "image_in_use" } },
    handler: async ({ app, params }) => {
      await app.firmware.removeImage(params.fid);
      return { status: 204 };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/firmware/update",
    summary: "Update many devices",
    description: "Starts a bulk firmware job (supports pause, resume, retry). Answers the Job.",
    tags: ["firmware"],
    body: FirmwareBulkBodySchema,
    response: JobSchema,
    responses: { 201: { description: "Started", schema: JobSchema }, 404: { description: "unknown_device / unknown_image" }, 409: { description: "ota_running" } },
    handler: ({ app, body }) => ({ status: 201, body: app.firmware.startBulk(body) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/ota",
    summary: "Update one device's firmware",
    description: "Checks the device, then starts an `ota` job. Answers the Job.",
    tags: ["firmware", "devices"],
    params: DeviceIdParams,
    body: OtaStartBodySchema,
    response: JobSchema,
    responses: {
      201: { description: "Started", schema: JobSchema },
      404: { description: "unknown_device / unknown_image" },
      409: { description: "device_offline / ota_busy / pending_verify / ota_running" },
      422: { description: "image_too_large" },
    },
    handler: async ({ app, params, body }) => ({ status: 201, body: await app.firmware.startUpdate(params.id, body.firmwareId) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/rollback",
    summary: "Roll a device back to its previous firmware",
    description: "Checks `rollback_possible`, sends `ota.rollback` and verifies the device came back on the other partition. Answers the Job.",
    tags: ["firmware", "devices"],
    params: DeviceIdParams,
    response: JobSchema,
    responses: { 201: { description: "Started", schema: JobSchema }, 404: { description: "unknown_device" }, 409: { description: "rollback_not_possible / device_offline / ota_running" } },
    handler: async ({ app, params }) => ({ status: 201, body: await app.firmware.startRollback(params.id) }),
  }),
];

/** Read and drop the rest of an oversize upload (so the client gets the answer, not a reset), but give up past 64 MB. */
async function discard(req: AsyncIterable<unknown>, already: number): Promise<void> {
  let n = already;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 64 * 1024 * 1024) break;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
