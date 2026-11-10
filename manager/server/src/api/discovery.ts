import { Type } from "@sinclair/typebox";
import type { AppContext } from "../appContext";
import { DiscoveryInputError, ScanRunningError } from "../discovery";
import { HttpError } from "../http/errors";
import { defineRoute } from "../http/router";
import { AdoptBodySchema, AdoptResponseSchema, DiscoveryStateSchema, IgnoreBodySchema, ScanRequestSchema, type DeviceSummary } from "../types/api";

const ID_RE = /^[0-9a-f]{12}$/;

function normalizeId(raw: string): string {
  const id = raw.trim().toLowerCase();
  if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id", `"${raw}" is not a device id (12 hex characters, the MAC address).`);
  return id;
}

export const discoveryRoutes = [
  defineRoute({
    method: "POST",
    path: "/api/discovery/scan",
    summary: "Start a scan",
    description:
      "Starts a scan and returns the state right away (202); poll `GET /api/discovery` or watch the `scan` WebSocket messages. Phases: `mdns` (also probes the addresses of registered devices and the extra targets) then `sweep` (every local /24), then `done`. Defaults: `mdns` true, `sweep` true. `subnets` are CIDR ranges (wider than /24 is clamped to the /24 containing the given address); `targets` are `host[:port]` addresses probed exactly as given. Settings `discoveryTargets` and `extraSubnets` are added to every scan. The body may be omitted. Only one scan runs at a time (409 `scan_running`).",
    tags: ["discovery"],
    body: ScanRequestSchema,
    optionalBody: true,
    response: DiscoveryStateSchema,
    responses: {
      202: { description: "Scan started", schema: DiscoveryStateSchema },
      400: { description: "invalid_body (bad subnet or target; details lists each)" },
      409: { description: "scan_running" },
    },
    handler: ({ app, body }) => {
      try {
        return { status: 202, body: app.discovery.startScan(body) };
      } catch (err) {
        if (err instanceof ScanRunningError) throw new HttpError(409, "scan_running", err.message);
        if (err instanceof DiscoveryInputError) throw new HttpError(400, "invalid_body", err.message, err.details);
        throw err;
      }
    },
  }),

  defineRoute({
    method: "GET",
    path: "/api/discovery",
    summary: "Scan state and results",
    description:
      "The current or last scan: `running`, `phase` (idle, mdns, sweep, done, cancelled, error), `probed`/`total`, timestamps, `warnings` (e.g. mDNS blocked), the swept `subnets`, `results` (one per device id: classification known/new/ignored, `setup` for devices in setup/recovery mode, `ipChanged` when a known device moved) and the `ignored` id list.",
    tags: ["discovery"],
    response: DiscoveryStateSchema,
    handler: ({ app }) => ({ body: app.discovery.getState() }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/discovery/cancel",
    summary: "Cancel the running scan",
    description: "Stops the scan (in-flight probes are aborted) and keeps the results found so far. Answers 200 with the state even when no scan runs.",
    tags: ["discovery"],
    response: DiscoveryStateSchema,
    handler: async ({ app }) => ({ body: await app.discovery.cancelScan() }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/discovery/ignore",
    summary: "Ignore a found device",
    description: "Adds the id to the registry's ignore list; matching results are classified `ignored` from now on. Returns the discovery state.",
    tags: ["discovery"],
    body: IgnoreBodySchema,
    response: DiscoveryStateSchema,
    responses: { 400: { description: "invalid_id (not 12 hex characters)" } },
    handler: ({ app, body }) => ({ body: app.discovery.ignore(normalizeId(body.id)) }),
  }),

  defineRoute({
    method: "DELETE",
    path: "/api/discovery/ignore/:id",
    summary: "Stop ignoring a device",
    description: "Removes the id from the ignore list (idempotent: 200 even when it was not ignored). Returns the discovery state.",
    tags: ["discovery"],
    params: Type.Object({ id: Type.String() }),
    response: DiscoveryStateSchema,
    responses: { 400: { description: "invalid_id" } },
    handler: ({ app, params }) => ({ body: app.discovery.unignore(normalizeId(params.id)) }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/discovery/adopt",
    summary: "Add found devices to the fleet",
    description:
      "Registers each id from the CURRENT scan results using the address the scan found, and polls it. `addedVia` is `mdns` when it was found by mDNS, else `sweep`; a device found only through an address you typed (a target) is `manual`. Adopting an ignored id un-ignores it. Ids that are not in the results (`unknown_id`) or already registered (`already_known`) are listed in `skipped`.",
    tags: ["discovery"],
    body: AdoptBodySchema,
    response: AdoptResponseSchema,
    handler: async ({ app, body }) => {
      const { added, skipped } = await app.discovery.adopt(body.ids);
      return { body: { added: added.map((id) => summaryOf(app, id)), skipped } };
    },
  }),
];

function summaryOf(app: AppContext, id: string): DeviceSummary {
  const s = app.summaries.get(id);
  if (!s) throw new HttpError(500, "internal_error", `Adopted device ${id} vanished`);
  return s;
}
