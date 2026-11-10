import type { IncomingMessage } from "node:http";
import { Type } from "@sinclair/typebox";
import { DeviceError, MAX_DEVICE_BODY } from "../device/client";
import { HttpError, sendJson } from "../http/errors";
import { defineRoute } from "../http/router";
import { callDevice, requireDevice, transportFailure } from "./deviceCall";

/**
 * Generic passthrough `/api/devices/:id/v1/*` -> `http://<device>/api/v1/*` (spec 3.5). Same queue, timeouts and
 * restart rules as the explicit `POST /api/devices/:id/command`; the device's status code and body come back
 * unchanged (non-JSON bodies with their content type). Transport failures are HTTP 502 `{ok:false, error, code, transport:true}`.
 */

const ProxyParams = Type.Object({ id: Type.String(), wildcard: Type.String() });
const Passthrough = Type.Record(Type.String(), Type.Unknown());

const HARD_LIMIT = 1024 * 1024;

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > HARD_LIMIT) throw new HttpError(413, "payload_too_large", `Body exceeds ${HARD_LIMIT} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function checkedPath(wildcard: string): string {
  if (!wildcard || !/^[A-Za-z0-9_\-./]+$/.test(wildcard) || wildcard.split("/").some((s) => s === "..")) {
    throw new HttpError(400, "invalid_path", `"${wildcard}" is not a valid device API path. Example: GET /api/devices/<id>/v1/status`);
  }
  return `/${wildcard.replace(/\/+$/, "")}`;
}

const PROXY_RESPONSES = {
  400: { description: "invalid_path | use_ota_endpoint | use_ws_link (or the device's own 400 passed through)" },
  404: { description: "unknown_device" },
  413: { description: "body_too_large_for_device (POST bodies over 1536 bytes are never sent)" },
  502: { description: "Device unreachable / timed out / redirected (transport:true)" },
};

export const proxyRoutes = [
  defineRoute({
    method: "GET",
    path: "/api/devices/:id/v1/*",
    summary: "Device API passthrough (GET)",
    description:
      "Forwards to `GET http://<device>/api/v1/<path>` (e.g. `status`, `pins`, `hardware`, `network/scan`, `logs`) through the device queue. Status code and body are passed through unchanged. `v1/ws` is refused (the device WebSocket is managed by the server). Query strings are forwarded.",
    tags: ["devices"],
    params: ProxyParams,
    response: Passthrough,
    responses: PROXY_RESPONSES,
    handler: async ({ params, app, url, res }) => {
      const dev = requireDevice(app, params.id);
      const path = checkedPath(params.wildcard);
      if (path === "/ws") throw new HttpError(400, "use_ws_link", "The device WebSocket is managed by the Manager; use the browser WebSocket /api/ws (live data arrives in a later version) or poll with GET v1/status.");
      try {
        const r = await callDevice(app, dev, "GET", path + url.search);
        sendDeviceResponse(res, r.status, r.contentType, r.body);
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
        const f = transportFailure(err);
        sendJson(res, f.status, f.body);
      }
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/v1/*",
    summary: "Device API passthrough (POST)",
    description:
      "Forwards a JSON body to `POST http://<device>/api/v1/<path>` (e.g. `command`, `pins`, `system/reboot`) through the device queue. Bodies over 1536 bytes are refused locally with 413 `body_too_large_for_device`. `v1/ota` is refused (400 `use_ota_endpoint`; firmware updates have their own endpoints). Reboot-type calls get the expected-restart mapping; successful `pin.configure` / `identity.set_name` update the registry. Prefer `POST /api/devices/:id/command` for commands. (The request body is JSON; it is read raw so the size limit can be enforced before forwarding.)",
    tags: ["devices"],
    params: ProxyParams,
    rawBody: true,
    response: Passthrough,
    responses: PROXY_RESPONSES,
    handler: async ({ params, app, req, res, url }) => {
      const dev = requireDevice(app, params.id);
      const path = checkedPath(params.wildcard);
      if (path === "/ota") throw new HttpError(400, "use_ota_endpoint", "OTA uploads are not proxied. Firmware updates will have their own endpoint (POST /api/devices/:id/ota).");
      const body = await readAll(req);
      if (body.length > MAX_DEVICE_BODY) {
        throw new HttpError(413, "body_too_large_for_device", `The request body is ${body.length} bytes; the device accepts at most ${MAX_DEVICE_BODY} bytes of JSON, so it was not sent.`, { limit: MAX_DEVICE_BODY });
      }
      try {
        const r = await callDevice(app, dev, "POST", path + url.search, { body });
        sendDeviceResponse(res, r.status, r.contentType, r.body);
      } catch (err) {
        if (!(err instanceof DeviceError)) throw err;
        const f = transportFailure(err);
        sendJson(res, f.status, f.body);
      }
    },
  }),
];

function sendDeviceResponse(res: import("node:http").ServerResponse, status: number, contentType: string, body: Buffer): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}
