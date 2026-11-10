import type { AppContext } from "../appContext";
import { DeviceError, commandFor, type CallOptions, type DeviceResponse } from "../device/client";
import { HttpError } from "../http/errors";
import type { RegistryDevice } from "../store/registry";
import type { DeviceTransportError } from "../types/api";

/** Shared plumbing of the device-facing routes: lookup, sending through the queue, post-call bookkeeping. */

export function requireDevice(app: AppContext, id: string): RegistryDevice {
  const d = app.registry.get(id);
  if (!d) throw new HttpError(404, "unknown_device", `No device with id "${id}" is registered. List them with GET /api/devices.`);
  return d;
}

const CODE_BY_KIND: Record<DeviceError["kind"], string> = {
  timeout: "device_timeout",
  refused: "device_unreachable",
  unreachable: "device_unreachable",
  reset: "device_reset",
  captive_redirect: "device_captive_redirect",
  bad_response: "device_bad_response",
  http_status: "device_http_status",
  body_too_large: "body_too_large_for_device",
};

/** HTTP 502 result for a transport failure (spec 3.5: `{ok:false, error, transport:true}` plus a machine `code`). */
export function transportFailure(err: DeviceError): { status: 502; body: DeviceTransportError } {
  return {
    status: 502,
    body: {
      ok: false,
      error: err.message,
      code: CODE_BY_KIND[err.kind],
      transport: true,
      ...(err.location ? { details: { location: err.location } } : {}),
    },
  };
}

/**
 * Send one request to a registered device through its queue. Throws `HttpError` 413 for an oversize body and
 * `DeviceError` for transport problems (callers turn those into `transportFailure`). Applies the post-call rules
 * of spec 3.5: expected restarts, `pinShadow`, rename.
 */
export async function callDevice(
  app: AppContext,
  dev: RegistryDevice,
  method: "GET" | "POST",
  rel: string,
  opts: CallOptions = {},
): Promise<DeviceResponse> {
  const client = app.pool.forDevice(dev.id, dev.host);
  let res: DeviceResponse;
  try {
    res = await client.request(method, rel, opts);
  } catch (err) {
    if (err instanceof DeviceError && err.kind === "body_too_large") {
      throw new HttpError(413, "body_too_large_for_device", err.message, { limit: 1536 });
    }
    throw err;
  }
  afterCall(app, dev.id, method, rel, opts, res);
  return res;
}

function parsedBodyOf(opts: CallOptions): Record<string, unknown> | undefined {
  let v: unknown = opts.json;
  if (v === undefined && opts.body !== undefined) {
    try {
      v = JSON.parse(typeof opts.body === "string" ? opts.body : opts.body.toString("utf8"));
    } catch {
      return undefined;
    }
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const RESTART_COMMANDS = new Set(["system.reboot", "system.factory_reset", "ota.rollback"]);

function afterCall(app: AppContext, id: string, method: string, rel: string, opts: CallOptions, res: DeviceResponse): void {
  if (method !== "POST") return;
  const body = parsedBodyOf(opts);
  const cmd = commandFor(method, rel, body);
  if (!cmd) return;
  const env = typeof res.json === "object" && res.json !== null ? (res.json as { ok?: unknown; result?: unknown }) : undefined;
  const ok = res.status >= 200 && res.status < 300 && env?.ok === true;
  applyCommandEffects(app, id, cmd, body, env, ok, res.expectedRestart);
}

/** Commands after which the device's I/O map may have gained or lost keys (the live link pushes a fresh snapshot). */
const CONFIG_COMMANDS = new Set(["pin.configure", "module.add", "module.configure", "module.remove"]);

/**
 * Post-command bookkeeping shared by every path a command can take (REST `/command`, `v1/*` passthrough, browser WS `cmd`):
 * expected restarts, pin shadow, rename, and the live snapshot refresh for config changes.
 */
export function applyCommandEffects(
  app: AppContext,
  id: string,
  cmd: string,
  body: Record<string, unknown> | undefined,
  env: { ok?: unknown; result?: unknown } | undefined,
  ok: boolean,
  expectedRestart: boolean,
): void {
  if (RESTART_COMMANDS.has(cmd) && (expectedRestart || ok)) {
    app.health.markRebooting(id);
    return;
  }
  if (!ok || !body) return;

  if (cmd === "pin.configure") {
    const nested = body.pin;
    let pin: Record<string, unknown>;
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) pin = { ...(nested as Record<string, unknown>) };
    else {
      pin = { ...body };
      delete pin.cmd;
      delete pin.v;
      delete pin.corr;
      delete pin.pin;
    }
    const gpio = Number(pin.gpio);
    if (Number.isInteger(gpio)) app.registry.setPinShadow(id, gpio, pin);
  } else if (cmd === "identity.set_name") {
    const result = env?.result as { name?: unknown } | undefined;
    const name = typeof result?.name === "string" ? result.name : typeof body.name === "string" ? body.name : undefined;
    if (name) app.registry.update(id, { name });
  }
  if (CONFIG_COMMANDS.has(cmd)) app.links.configChanged(id);
}
