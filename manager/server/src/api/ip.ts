import { Type } from "@sinclair/typebox";
import { DeviceError } from "../device/client";
import { defineRoute, type Route } from "../http/router";
import { DeviceTransportErrorSchema } from "../types/api";
import { IpChangeBodySchema, IpCheckResultSchema, IpSettingsSchema } from "../types/api-ip";
import { JobSchema } from "../types/api-jobs";
import { transportFailure } from "./deviceCall";

/** The 502 body is not the route's 200 schema (documented in `responses`); the router does not check results against it. */
const failed = (err: DeviceError): never => transportFailure(err) as never;

const IdParams = Type.Object({ id: Type.String() });

/** Static IP / DHCP for a device (spec 3.12). Documented in API.md under "IP address". The change itself is a job of kind `ip-change`. */
export const ipRoutes: Route[] = [
  defineRoute({
    method: "GET",
    path: "/api/devices/:id/ip",
    summary: "Get a device's IP settings",
    description: "Current mode (dhcp/static), address, netmask, gateway, DNS and the device's own `ip_change` record. `supported` is false on firmware that does not report `ip_mode`.",
    tags: ["ip"],
    params: IdParams,
    response: IpSettingsSchema,
    responses: { 404: { description: "unknown_device" }, 502: { description: "The device could not be reached", schema: DeviceTransportErrorSchema } },
    handler: async ({ params, app }) => {
      try {
        return { body: await app.ipChange.settings(params.id) };
      } catch (err) {
        if (err instanceof DeviceError) return failed(err);
        throw err;
      }
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/ip/check",
    summary: "Dry-run an IP change",
    description: "Checks the same body as the change itself: the device's rules (errors) plus heads-ups that do not block (warnings). Sends nothing to the device except reading its status.",
    tags: ["ip"],
    params: IdParams,
    body: IpChangeBodySchema,
    response: IpCheckResultSchema,
    responses: { 404: { description: "unknown_device" } },
    handler: async ({ params, body, app }) => {
      try {
        return { body: await app.ipChange.check(params.id, body) };
      } catch (err) {
        if (err instanceof DeviceError) return failed(err);
        throw err;
      }
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/ip",
    summary: "Change a device's IP address",
    description:
      "Starts a job of kind `ip-change`. The device applies the new setting about 1.5 s after it answers; a static address must be confirmed at the new address within 90 s or the device goes back by itself.",
    tags: ["ip"],
    params: IdParams,
    body: IpChangeBodySchema,
    response: JobSchema,
    responses: {
      201: { description: "The job", schema: JobSchema },
      404: { description: "unknown_device" },
      409: { description: "ip_change_unsupported | ip_change_running | ip_change_refused" },
      422: { description: "invalid_ip_config (details = list of { field, message })" },
      502: { description: "The device could not be reached", schema: DeviceTransportErrorSchema },
    },
    handler: async ({ params, body, app }) => {
      try {
        return { status: 201, body: await app.ipChange.start(params.id, body) };
      } catch (err) {
        if (err instanceof DeviceError) return failed(err);
        throw err;
      }
    },
  }),
];
