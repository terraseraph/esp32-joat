import { Type } from "@sinclair/typebox";
import { isOurs } from "node-red-contrib-de-esp32/lib/fingerprint";
import type { AppContext } from "../appContext";
import { DeviceError, createDeviceClient } from "../device/client";
import { formatHostAddr, HostAddrError, parseHostInput, resolveHostAddr } from "../device/hostAddr";
import { HttpError } from "../http/errors";
import { defineRoute } from "../http/router";
import {
  AddDeviceBodySchema,
  DeviceCommandBodySchema,
  DeviceEnvelopeSchema,
  DeviceSummarySchema,
  DeviceTransportErrorSchema,
  PatchDeviceBodySchema,
  PinConfigResponseSchema,
  type DeviceEnvelopeBody,
  type PinConfigEntry,
  type DeviceSummary,
} from "../types/api";
import type { DeviceStatus } from "../types/device-api";
import { callDevice, requireDevice, transportFailure } from "./deviceCall";

const IdParams = Type.Object({ id: Type.String() });

function summaryOrThrow(app: AppContext, id: string): DeviceSummary {
  const s = app.summaries.get(id);
  if (!s) throw new HttpError(404, "unknown_device", `No device with id "${id}" is registered. List them with GET /api/devices.`);
  return s;
}

/** Validate user input and turn it into the stored `ip[:port]` form (names are resolved to IPv4). */
async function normalizeHost(input: string): Promise<string> {
  let addr;
  try {
    addr = parseHostInput(input);
  } catch (err) {
    if (err instanceof HostAddrError) throw new HttpError(400, "invalid_host", err.message);
    throw err;
  }
  try {
    addr = await resolveHostAddr(addr);
  } catch {
    throw new HttpError(
      422,
      "device_unreachable",
      `Could not resolve "${addr.host}" to an IP address. Check the name, or use the device's IP address instead.`,
    );
  }
  return formatHostAddr(addr);
}

function secondsText(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return `${s} second${s === 1 ? "" : "s"}`;
}

/** Probe `/status` at an address and make sure it is a de-esp32 device. Throws `HttpError` 422 with the specific reason. */
async function probeDevice(app: AppContext, host: string): Promise<DeviceStatus> {
  const client = createDeviceClient({ host });
  try {
    const res = await client.request("GET", "/status", { timeoutMs: app.probeTimeoutMs });
    const status = res.json as DeviceStatus | undefined;
    const looksRight =
      res.status >= 200 &&
      res.status < 300 &&
      typeof status === "object" &&
      status !== null &&
      !Array.isArray(status) &&
      typeof status.id === "string" &&
      /^[0-9a-f]{12}$/i.test(status.id) &&
      isOurs(status);
    if (!looksRight) {
      throw new HttpError(422, "not_de_esp32", `${host} answered, but it does not look like a de-esp32 device (no matching /api/v1/status).`);
    }
    return status;
  } catch (err) {
    if (!(err instanceof DeviceError)) throw err;
    switch (err.kind) {
      case "timeout":
        throw new HttpError(422, "probe_timeout", `Nothing answered at ${host} within ${secondsText(app.probeTimeoutMs)}. Check the address, and that the device is powered and on this network.`);
      case "captive_redirect":
        throw new HttpError(
          422,
          "captive_redirect",
          `${host} redirects to ${err.location || "another address"} — this looks like a device in setup mode or another captive portal.`,
          { location: err.location ?? null },
        );
      case "refused":
        throw new HttpError(422, "device_unreachable", `${host} refused the connection. Check the address and the port.`);
      case "bad_response":
        throw new HttpError(422, "not_de_esp32", `${host} answered, but it does not look like a de-esp32 device.`);
      default:
        throw new HttpError(422, "device_unreachable", `Could not reach ${host}: ${err.message}`);
    }
  } finally {
    client.destroy();
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Minimal `pin.configure` object derived from a live state value: `{gpio, mode}` plus only non-default options. */
export function configFromLive(st: Record<string, unknown>): Record<string, unknown> {
  const gpio = st.gpio;
  const mode = st.mode;
  const cfg: Record<string, unknown> = { gpio, mode };
  const opt = (key: string, def: number): void => {
    if (typeof st[key] === "number" && st[key] !== def) cfg[key] = st[key];
  };
  switch (mode) {
    case "in":
      opt("debounce_ms", 50);
      break;
    case "pwm":
      opt("hz", 1000);
      opt("duty", 0);
      break;
    case "servo":
      opt("angle", 90);
      opt("min_us", 500);
      opt("max_us", 2500);
      break;
    case "adc":
      opt("sample_ms", 50);
      opt("hysteresis_mv", 20);
      opt("smooth", 70);
      break;
  }
  return cfg;
}

export const deviceRoutes = [
  defineRoute({
    method: "GET",
    path: "/api/devices",
    summary: "List devices",
    description: "Every registered device with live health, sorted by title (label, else name). Built from the registry plus the health poller.",
    tags: ["devices"],
    response: Type.Array(DeviceSummarySchema),
    handler: ({ app }) => ({ body: app.summaries.list() }),
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices",
    summary: "Add a device by address",
    description:
      "Probes `/api/v1/status` (2 s), checks it is a de-esp32 device and registers it (`addedVia: manual`). 201 when new; 200 when the id was already registered (its address is updated). `host` may be an IPv4, `host:port`, `name.local` or a hostname (names are resolved to an IP). Failures are 422 with a specific code: probe_timeout, device_unreachable, captive_redirect, not_de_esp32; 400 invalid_host.",
    tags: ["devices"],
    body: AddDeviceBodySchema,
    response: DeviceSummarySchema,
    responses: {
      201: { description: "Added", schema: DeviceSummarySchema },
      400: { description: "invalid_host" },
      422: { description: "probe_timeout | device_unreachable | captive_redirect | not_de_esp32" },
    },
    handler: async ({ body, app }) => {
      const host = await normalizeHost(body.host);
      const status = await probeDevice(app, host);
      const id = status.id.toLowerCase();
      const { created } = app.registry.upsert({ id, host, hostname: status.hostname, name: status.name || status.hostname, addedVia: "manual" });
      app.registry.unignore(id);
      app.health.ingest(id, status);
      return { status: created ? 201 : 200, body: summaryOrThrow(app, id) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/api/devices/:id",
    summary: "Get one device",
    tags: ["devices"],
    params: IdParams,
    response: DeviceSummarySchema,
    responses: { 404: { description: "unknown_device" } },
    handler: ({ params, app }) => ({ body: summaryOrThrow(app, params.id) }),
  }),

  defineRoute({
    method: "PATCH",
    path: "/api/devices/:id",
    summary: "Edit label, notes or address",
    description:
      "Manager-only metadata (`label` up to 64 chars, `notes` up to 2000) and `host` (re-validated like the add form; the device is polled afterwards, so a wrong address shows up as unreachable or host_mismatch). Never touches the device.",
    tags: ["devices"],
    params: IdParams,
    body: PatchDeviceBodySchema,
    response: DeviceSummarySchema,
    responses: { 400: { description: "invalid_host / invalid_body" }, 404: { description: "unknown_device" }, 422: { description: "device_unreachable (name did not resolve)" } },
    handler: async ({ params, body, app }) => {
      const dev = requireDevice(app, params.id);
      const host = body.host === undefined ? undefined : await normalizeHost(body.host);
      app.registry.update(dev.id, {
        ...(body.label !== undefined ? { label: body.label.trim() } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(host !== undefined ? { host } : {}),
      });
      if (host !== undefined && host !== dev.host) await app.health.pollNow(dev.id);
      return { body: summaryOrThrow(app, dev.id) };
    },
  }),

  defineRoute({
    method: "DELETE",
    path: "/api/devices/:id",
    summary: "Forget a device",
    description: "Removes it from the registry (and stops polling). Never touches the device. Returns 204.",
    tags: ["devices"],
    params: IdParams,
    response: Type.Null(),
    responses: { 204: { description: "Forgotten" }, 404: { description: "unknown_device" } },
    handler: ({ params, app }) => {
      requireDevice(app, params.id);
      app.registry.remove(params.id);
      return { status: 204 };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/refresh",
    summary: "Poll a device now",
    description: "Polls `/status` through the device queue and returns the fresh summary (also when the device is unreachable; the summary says so).",
    tags: ["devices"],
    params: IdParams,
    response: DeviceSummarySchema,
    responses: { 404: { description: "unknown_device" } },
    handler: async ({ params, app }) => {
      requireDevice(app, params.id);
      await app.health.pollNow(params.id);
      return { body: summaryOrThrow(app, params.id) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/api/devices/:id/pin-config",
    summary: "Configured pins with a re-sendable pin.configure object",
    description:
      "Reads the device's `GET /pins` and lists every configured pin (add-on `mod_*` entries are not pins). `config` is the minimal `pin.configure` object for the pin: the Manager's pin shadow (what it last sent for that GPIO) when its `mode` equals the live mode (`source: shadow`), else derived from the live state (`source: live`; it lacks invert/pull/boot/irq and lists only non-default options). `live` is the device's state value. Sorted by gpio.",
    tags: ["devices"],
    params: IdParams,
    response: Type.Union([PinConfigResponseSchema, DeviceTransportErrorSchema]),
    responses: { 404: { description: "unknown_device" }, 502: { description: "Device unreachable / timed out / answered nonsense (transport:true)" } },
    handler: async ({ params, app }) => {
      const dev = requireDevice(app, params.id);
      let io: unknown;
      try {
        const res = await callDevice(app, dev, "GET", "/pins");
        if (res.status < 200 || res.status >= 300 || !isRecord(res.json)) {
          return transportFailure(
            new DeviceError(res.status >= 200 && res.status < 300 ? "bad_response" : "http_status", `The device answered HTTP ${res.status} to GET /pins without a pin map`, { status: res.status }),
          );
        }
        io = res.json;
      } catch (err) {
        if (err instanceof DeviceError) return transportFailure(err);
        throw err;
      }
      const pins: PinConfigEntry[] = [];
      for (const [key, st] of Object.entries(io as Record<string, unknown>)) {
        if (key.startsWith("mod_") || !isRecord(st) || typeof st.gpio !== "number" || !Number.isInteger(st.gpio) || typeof st.mode !== "string") continue;
        const shadow = dev.pinShadow[String(st.gpio)];
        const useShadow = isRecord(shadow) && shadow.mode === st.mode;
        pins.push({
          gpio: st.gpio,
          mode: st.mode,
          config: useShadow ? { ...shadow } : configFromLive(st),
          source: useShadow ? "shadow" : "live",
          live: st,
        });
      }
      pins.sort((a, b) => a.gpio - b.gpio || a.mode.localeCompare(b.mode));
      return { body: { pins } };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/api/devices/:id/command",
    summary: "Send a device command",
    description:
      "Sends `{cmd, ...args}` to the device's `POST /api/v1/command` through its queue and returns the device's envelope unchanged (`{v, ok, result|error, corr?}`) with HTTP 200, whether `ok` is true or false. See the command catalog in docs/manager-app.md 2.5. Timeouts: 5 s (25 s for `network.wifi.set`, 12 s for `network.wifi.scan`). `system.reboot`, `system.factory_reset` and `ota.rollback` answer `{ok:true,result:{expectedRestart:true}}` when the device restarts instead of replying, and the device's health becomes `rebooting`. Bodies over 1536 bytes are refused (413 `body_too_large_for_device`). A successful `pin.configure` updates the stored pin shadow; `identity.set_name` updates the stored name. Transport failures are HTTP 502 `{ok:false, error, code, transport:true}` (codes: device_unreachable, device_timeout, device_reset, device_captive_redirect, device_bad_response, device_http_status).",
    tags: ["devices"],
    params: IdParams,
    body: DeviceCommandBodySchema,
    response: Type.Union([DeviceEnvelopeSchema, DeviceTransportErrorSchema]),
    responses: {
      400: { description: "invalid_body (no string `cmd`) or device_rejected_body" },
      404: { description: "unknown_device" },
      413: { description: "body_too_large_for_device" },
      502: { description: "Device unreachable / timed out / answered nonsense (transport:true)" },
    },
    handler: async ({ params, body, app }) => {
      const dev = requireDevice(app, params.id);
      try {
        const res = await callDevice(app, dev, "POST", "/command", { json: body });
        const env = res.json;
        if (typeof env === "object" && env !== null && typeof (env as { ok?: unknown }).ok === "boolean") return { status: 200, body: env as DeviceEnvelopeBody };
        if (res.status === 400 && res.text.trim() === "json") {
          throw new HttpError(400, "device_rejected_body", "The device rejected the command body as invalid JSON (HTTP 400 \"json\"). It must be a non-empty JSON object of at most 1536 bytes.");
        }
        return transportFailure(
          new DeviceError(res.status >= 200 && res.status < 300 ? "bad_response" : "http_status", `The device answered HTTP ${res.status} without a command envelope`, { status: res.status }),
        );
      } catch (err) {
        if (err instanceof DeviceError) return transportFailure(err);
        throw err;
      }
    },
  }),
];
