import { callDevice } from "../api/deviceCall";
import { configFromLive } from "../api/devices";
import type { AppContext } from "../appContext";
import { DeviceError } from "../device/client";
import { HttpError } from "../http/errors";
import type { RegistryDevice } from "../store/registry";
import type { DeviceStatus, ModuleInstance, Rule } from "../types/device-api";

/** Reading a device's configuration and sending it commands, for backups (all through the normal command path). */

export interface LivePin {
  gpio: number;
  mode: "out" | "in" | "pwm" | "servo" | "adc";
  /** The minimal `pin.configure` object: the pin shadow when its mode matches, else derived from the live state. */
  config: Record<string, unknown>;
  from: "shadow" | "live";
}

export interface DeviceConfigState {
  name: string;
  appVersion: string;
  boardId?: string;
  pins: LivePin[];
  /** null = the device did not report them (older firmware). */
  modules: ModuleInstance[] | null;
  rules: Rule[] | null;
  /** null = no broker configured. */
  mqtt: { uri: string; root: string } | null;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const PIN_MODES = new Set(["out", "in", "pwm", "servo", "adc"]);

export type CommandOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Send one command. Device refusals come back as `{ok:false, error}`; transport problems throw `DeviceError`. */
export async function runCommand(app: AppContext, dev: RegistryDevice, body: Record<string, unknown>): Promise<CommandOutcome> {
  let res;
  try {
    res = await callDevice(app, dev, "POST", "/command", { json: body });
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, error: err.message };
    throw err;
  }
  const env = res.json;
  if (isRecord(env) && typeof env.ok === "boolean") {
    if (env.ok) return { ok: true, result: env.result };
    return { ok: false, error: typeof env.error === "string" && env.error ? env.error : "The device refused the command." };
  }
  throw new DeviceError(res.status >= 200 && res.status < 300 ? "bad_response" : "http_status", `The device answered HTTP ${res.status} without a command envelope`, { status: res.status });
}

async function getJson(app: AppContext, dev: RegistryDevice, rel: string): Promise<Record<string, unknown>> {
  const res = await callDevice(app, dev, "GET", rel);
  if (res.status < 200 || res.status >= 300 || !isRecord(res.json)) {
    throw new DeviceError(res.status >= 200 && res.status < 300 ? "bad_response" : "http_status", `The device answered HTTP ${res.status} to GET ${rel} without usable data`, { status: res.status });
  }
  return res.json;
}

function listOf<T>(outcome: CommandOutcome, key: string): T[] | null {
  if (!outcome.ok || !isRecord(outcome.result) || !Array.isArray(outcome.result[key])) return null;
  return outcome.result[key] as T[];
}

/** Read everything a backup or a plan needs. Throws `DeviceError` when the device cannot be reached. */
export async function readDeviceState(app: AppContext, dev: RegistryDevice, opts: { board?: boolean } = {}): Promise<DeviceConfigState> {
  const status = (await getJson(app, dev, "/status")) as unknown as DeviceStatus;
  const io = await getJson(app, dev, "/pins");
  const pins: LivePin[] = [];
  for (const [key, st] of Object.entries(io)) {
    if (key.startsWith("mod_") || !isRecord(st) || typeof st.gpio !== "number" || !Number.isInteger(st.gpio) || typeof st.mode !== "string" || !PIN_MODES.has(st.mode)) continue;
    const shadow = dev.pinShadow[String(st.gpio)];
    const useShadow = isRecord(shadow) && shadow.mode === st.mode;
    pins.push({ gpio: st.gpio, mode: st.mode as LivePin["mode"], config: useShadow ? { ...shadow } : configFromLive(st), from: useShadow ? "shadow" : "live" });
  }
  pins.sort((a, b) => a.gpio - b.gpio);

  const modules = listOf<ModuleInstance>(await runCommand(app, dev, { cmd: "module.list" }), "modules");
  const rules = listOf<Rule>(await runCommand(app, dev, { cmd: "rule.list" }), "rules");

  let boardId: string | undefined;
  if (opts.board) {
    try {
      const hw = await getJson(app, dev, "/hardware");
      if (typeof hw.board_id === "string" && hw.board_id) boardId = hw.board_id;
    } catch {
      /* the board id is a nicety */
    }
  }

  const mq = status.mqtt;
  return {
    name: typeof status.name === "string" ? status.name : dev.name,
    appVersion: typeof status.ota?.app_version === "string" ? status.ota.app_version : "",
    ...(boardId ? { boardId } : {}),
    pins,
    modules,
    rules,
    mqtt: mq && typeof mq.uri === "string" && mq.uri !== "" ? { uri: mq.uri, root: typeof mq.root === "string" ? mq.root : "" } : null,
  };
}
