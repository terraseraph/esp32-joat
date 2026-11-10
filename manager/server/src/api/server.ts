import type { IncomingMessage } from "node:http";
import { Type } from "@sinclair/typebox";
import type { AppContext } from "../appContext";
import { buildOpenApi } from "../http/openapi";
import { defineRoute } from "../http/router";
import { HttpError } from "../http/errors";
import { AccessResponseSchema, AccessUpdateSchema, HealthResponseSchema, type AccessResponse, type HealthResponse } from "../types/api";

/** Defence in depth: the security gate already ran, but the token and the switch are only for the local user or a token holder. */
function requireTrusted(app: AppContext, req: IncomingMessage): void {
  if (!app.access.isTrusted(req)) throw new HttpError(401, "unauthorized", "Access token required");
}

function describeAccess(app: AppContext, req: IncomingMessage): AccessResponse {
  requireTrusted(app, req);
  return app.access.describe(req, { trusted: true });
}

let openApiCache: { routes: unknown; doc: Record<string, unknown> } | undefined;

export const serverRoutes = [
  defineRoute({
    method: "GET",
    path: "/api/health",
    summary: "Server health",
    tags: ["server"],
    response: HealthResponseSchema,
    handler: ({ app }): { body: HealthResponse } => ({
      body: {
        version: app.version,
        lan: app.lan,
        dataDir: app.dataDir,
        uptime: Math.round((Date.now() - app.startedAt) / 1000),
        startedAt: app.startedAt,
        networkScan: app.networkScan,
        wifiAdapter: app.wifiAdapterKind,
      },
    }),
  }),

  defineRoute({
    method: "GET",
    path: "/api/access",
    summary: "How to reach this server",
    description:
      "Whether LAN access is on right now (live), the local and LAN URLs, the access token (masked and in full), a ready-to-open link with `?token=`, whether this request came from another device, and whether the switch is available. The token is only ever returned to a caller that already passed the security check as the local user or with the valid token.",
    tags: ["server"],
    response: AccessResponseSchema,
    responses: { 401: { description: "unauthorized (LAN mode, no valid token)" } },
    handler: ({ app, req }): { body: AccessResponse } => ({ body: describeAccess(app, req) }),
  }),

  defineRoute({
    method: "PUT",
    path: "/api/access",
    summary: "Switch LAN access on or off",
    description:
      "`{enabled}`: true re-binds the same port on all network interfaces and requires the access token (created the first time); false re-binds on this PC only and at once disconnects every other device (their HTTP connections and browser WebSockets). The choice is saved. Allowed for the local user and for a caller holding the token (a remote caller that switches it off loses access after this response). 409 `lan_unavailable` in the desktop app or when started with a fixed `--host`; 409 `rebind_failed` when the port cannot be bound on the new address (the Manager keeps listening where it was).",
    tags: ["server"],
    body: AccessUpdateSchema,
    response: AccessResponseSchema,
    responses: {
      409: { description: "lan_unavailable | rebind_failed" },
    },
    handler: async ({ app, req, res, body }): Promise<{ body: AccessResponse }> => {
      requireTrusted(app, req);
      await app.access.setLan(body.enabled, { req, res });
      // Trust was checked above: a remote caller that just switched LAN off is no longer "trusted" by the new rules.
      return { body: app.access.describe(req, { trusted: true }) };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/access/token",
    summary: "Regenerate the access token",
    description:
      "Creates a new token: the old token and every cookie that carries it stop working at once, and browser WebSockets of other devices are closed. A remote caller gets the new cookie in this response and keeps access; a local caller gets no cookie. 409 `lan_disabled` while LAN access is off.",
    tags: ["server"],
    response: AccessResponseSchema,
    responses: { 409: { description: "lan_disabled" } },
    handler: async ({ app, req }): Promise<{ body: AccessResponse; headers?: Record<string, string> }> => {
      requireTrusted(app, req);
      const token = await app.access.rotateToken();
      // Trust was checked above, with the old token: the caller's own token just changed under it.
      const body = app.access.describe(req, { trusted: true });
      // Only a remote browser needs the cookie: the local user needs no token at all.
      return body.remote ? { body, headers: { "Set-Cookie": app.access.cookieFor(token) } } : { body };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/api/openapi.json",
    summary: "OpenAPI document",
    description: "OpenAPI 3.1 description of every route in the table.",
    tags: ["server"],
    response: Type.Record(Type.String(), Type.Unknown()),
    handler: ({ app }) => {
      if (openApiCache?.routes !== app.routes) openApiCache = { routes: app.routes, doc: buildOpenApi(app.routes, app.version) };
      return { body: openApiCache.doc };
    },
  }),
];
