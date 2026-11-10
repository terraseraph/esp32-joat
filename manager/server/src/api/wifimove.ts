import { Type } from "@sinclair/typebox";
import { DeviceError } from "../device/client";
import { defineRoute, type Route } from "../http/router";
import { DeviceTransportErrorSchema } from "../types/api";
import { JobSchema } from "../types/api-jobs";
import { WifiMoveBodySchema, WifiMoveCheckBodySchema, WifiMoveCheckResultSchema, WifiMoveSettingsSchema } from "../types/api-wifimove";
import { transportFailure } from "./deviceCall";

/** The 502 body is not the route's 200 schema (documented in `responses`); the router does not check results against it. */
const failed = (err: DeviceError): never => transportFailure(err) as never;

const IdParams = Type.Object({ id: Type.String() });

/** Moving a device to another Wi-Fi network (L1). Documented in API.md under "Wi-Fi move". The move itself is a job of kind `wifi-move`. */
export const wifiMoveRoutes: Route[] = [
  defineRoute({
    method: "GET",
    path: "/api/devices/:id/wifi",
    summary: "Get a device's Wi-Fi state",
    description:
      "Whether the device can move to another network (`supported`: it reports `wifi_change`), its state and address, its last Wi-Fi change in words, whether it uses a fixed address, and the network this PC is on when the Wi-Fi adapter can tell.",
    tags: ["wifi"],
    params: IdParams,
    response: WifiMoveSettingsSchema,
    responses: { 404: { description: "unknown_device" }, 502: { description: "The device could not be reached", schema: DeviceTransportErrorSchema } },
    handler: async ({ params, app }) => {
      try {
        return { body: await app.wifiMove.settings(params.id) };
      } catch (err) {
        if (err instanceof DeviceError) return failed(err);
        throw err;
      }
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/wifi/check",
    summary: "Dry-run a Wi-Fi move",
    description:
      "Checks the same body as the move: errors the request would be refused for, and warnings that do not block (this PC is not on that network or the Manager cannot tell; a fixed address resets to DHCP). Changes nothing; the password is only checked for length.",
    tags: ["wifi"],
    params: IdParams,
    body: WifiMoveCheckBodySchema,
    response: WifiMoveCheckResultSchema,
    responses: { 404: { description: "unknown_device" } },
    handler: async ({ params, body, app }) => ({ body: await app.wifiMove.check(params.id, body) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/wifi",
    summary: "Move a device to another Wi-Fi network",
    description:
      "Starts a job of kind `wifi-move`. The device tests the network for up to 20 s and keeps its old one if that fails. The password is kept in memory for the job only. The job ends `succeeded` (found again on the new network, registry address updated), `failed` with the device's reason (it went back to the old network) or `failed` / `not_found` (never seen again).",
    tags: ["wifi"],
    params: IdParams,
    body: WifiMoveBodySchema,
    response: JobSchema,
    responses: {
      202: { description: "The job", schema: JobSchema },
      404: { description: "unknown_device" },
      409: { description: "wifi_change_unsupported | device_offline | device_busy | job_running" },
      422: { description: "invalid_wifi_config (details = list of { field, message })" },
      502: { description: "The device could not be reached", schema: DeviceTransportErrorSchema },
    },
    handler: async ({ params, body, app }) => {
      try {
        return { status: 202, body: await app.wifiMove.start(params.id, body) };
      } catch (err) {
        if (err instanceof DeviceError) return failed(err);
        throw err;
      }
    },
  }),
];
