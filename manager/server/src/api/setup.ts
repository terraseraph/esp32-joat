import { Type } from "@sinclair/typebox";
import { defineRoute, type Route } from "../http/router";
import { JobSchema } from "../types/api-jobs";
import {
  SetupAdapterStatusSchema,
  SetupApListQuerySchema,
  SetupApListSchema,
  SetupJobIdParamsSchema,
  SetupRecoveryStateSchema,
  SetupRestoreResultSchema,
  SetupStartBodySchema,
  SetupWifiBodySchema,
} from "../types/api-setup";

/** SoftAP setup routes (batch 3, SoftAP setup track). Documented in API.md under "SoftAP setup". */
export const setupRoutes: Route[] = [
  defineRoute({
    method: "GET",
    path: "/api/setup/adapter",
    summary: "Can this PC's Wi-Fi be used for setup?",
    description:
      "Whether the Manager can control this PC's Wi-Fi (`supported`, with a plain `reason` when not), which adapter it uses, and the network this PC is on right now.",
    tags: ["setup"],
    response: SetupAdapterStatusSchema,
    handler: async ({ app }) => ({ body: await app.setup.adapterStatus() }),
  }),

  defineRoute({
    method: "GET",
    path: "/api/setup/aps",
    summary: "Devices in setup mode that are nearby",
    description:
      "Setup Wi-Fi networks (`esp32-` plus six hex characters) visible right now. `refresh=true` scans again; otherwise the last scan is returned (the first call always scans). `knownDeviceId` is set when a device of the fleet has that id suffix.",
    tags: ["setup"],
    query: SetupApListQuerySchema,
    response: SetupApListSchema,
    responses: { 502: { description: "wifi_scan_failed (this PC's Wi-Fi did not answer)" } },
    handler: async ({ app, query }) => ({ body: await app.setup.listAps(query.refresh === true) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/setup/jobs",
    summary: "Start a SoftAP setup",
    description:
      "Moves this PC's Wi-Fi onto the device's setup network, sends the Wi-Fi details (or waits for them: `POST /api/setup/jobs/:id/wifi`), puts this PC's Wi-Fi back and adds the device. Answers 201 with the job (kind `setup`); follow it with `GET /api/jobs/:id` or the `job` WebSocket messages. Passwords are never stored or returned.",
    tags: ["setup"],
    body: SetupStartBodySchema,
    response: JobSchema,
    responses: {
      201: { description: "The job", schema: JobSchema },
      400: { description: "invalid_body" },
      409: { description: "setup_running · adapter_unsupported · recovery_pending (restore or dismiss the leftover marker first)" },
    },
    handler: async ({ app, body }) => ({ status: 201, body: await app.setup.start(body) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/setup/jobs/:id/wifi",
    summary: "Choose the network for the device",
    description: "Answers the `choose` step of a setup job that has no `wifi` yet. Answers the job.",
    tags: ["setup"],
    params: SetupJobIdParamsSchema,
    body: SetupWifiBodySchema,
    response: JobSchema,
    responses: { 404: { description: "not_found" }, 409: { description: "job_not_waiting" } },
    handler: ({ app, params, body }) => ({ body: app.setup.chooseWifi(params.id, body) }),
  }),

  defineRoute({
    method: "GET",
    path: "/api/setup/recovery",
    summary: "Did an earlier setup leave this PC's Wi-Fi switched?",
    description: "`pending` is true when a crash marker from a setup run that never finished exists. Nothing is switched automatically.",
    tags: ["setup"],
    response: SetupRecoveryStateSchema,
    handler: async ({ app }) => ({ body: await app.setup.recovery() }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/setup/recovery/restore",
    summary: "Put this PC's Wi-Fi back",
    description: "Reconnects the remembered network, deletes leftover temporary profiles and clears the marker. `restored` is false (and the marker is kept) when it could not.",
    tags: ["setup"],
    response: SetupRestoreResultSchema,
    responses: { 409: { description: "setup_running" } },
    handler: async ({ app }) => ({ body: await app.setup.restore() }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/setup/recovery/dismiss",
    summary: "Forget the crash marker",
    description: "Removes the marker without touching this PC's Wi-Fi.",
    tags: ["setup"],
    response: Type.Null(),
    responses: { 204: { description: "Dismissed" }, 409: { description: "setup_running" } },
    handler: async ({ app }) => {
      await app.setup.dismiss();
      return { status: 204 };
    },
  }),
];
