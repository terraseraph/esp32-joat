import type { BackupFile, BackupInclude, BackupMeta, BackupModule, BackupPin, BackupRule, BackupStepOp, DeviceSummary } from "@shared/api";
import { ApiError } from "../../api/client";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "7 pins · 2 add-ons · 2 rules" */
export function countsText(c: BackupMeta["counts"]): string {
  return [plural(c.pins, "pin", "pins"), plural(c.modules, "add-on", "add-ons"), plural(c.rules, "rule", "rules")].join(" · ");
}

const FIXED_GAPS: Record<string, string> = {
  wifi: "Wi-Fi network and password are not included",
  ap_password: "Setup AP password is not included",
  mqtt_credentials: "MQTT username and password are not included",
  modules_unavailable: "Add-ons could not be read from the device",
  rules_unavailable: "Rules could not be read from the device",
  pins_unavailable: "Pins could not be read from the device",
  mqtt_unavailable: "MQTT settings could not be read from the device",
};

const PIN_WHAT: Record<string, string> = {
  "invert/pull": "invert, pull-up and start level unknown",
  "invert/pull/boot": "invert, pull-up and start level unknown",
  invert: "invert unknown",
  pull: "pull-up unknown",
  boot: "start level unknown",
};

/** A gap token in plain words ("pin:13:invert/pull" becomes "GPIO 13: invert, pull-up and start level unknown"). */
export function gapLabel(token: string): string {
  const fixed = FIXED_GAPS[token];
  if (fixed) return fixed;
  const m = /^pin:(\d+):(.+)$/.exec(token);
  if (m) {
    const what = m[2] ?? "";
    return `GPIO ${m[1]}: ${PIN_WHAT[what] ?? `${what.replace(/[/_]/g, " ")} unknown`}`;
  }
  const words = token.replace(/[:_/]/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : token;
}

export const gapCountLabel = (n: number): string => (n === 0 ? "No gaps" : n === 1 ? "1 gap" : `${n} gaps`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "Today 10:00", "Yesterday 18:22", "Nov 2" (with the year when it is not this year), in the browser's time zone. */
export function formatTaken(iso: string, now: number = Date.now()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "Unknown";
  const today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((day(today) - day(t)) / 86_400_000);
  const time = `${two(t.getHours())}:${two(t.getMinutes())}`;
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  const base = `${MONTHS[t.getMonth()]} ${t.getDate()}`;
  return t.getFullYear() === today.getFullYear() ? base : `${base}, ${t.getFullYear()}`;
}

/** Why a backup of this device failed, in plain words. */
export function backupErrorMessage(err: unknown, name: string): string {
  if (err instanceof ApiError && err.code === "device_offline") return `${name} is offline. A backup reads the live device, so it has to be online.`;
  if (err instanceof ApiError && err.status === 502) return `${name} did not answer. ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

/** Can a device be read or written right now? Only online devices; the reason is for a hint. */
export function deviceUsability(d: Pick<DeviceSummary, "health">): { ok: boolean; reason: string } {
  if (d.health === "online") return { ok: true, reason: "" };
  if (d.health === "unreachable") return { ok: false, reason: "Unreachable" };
  if (d.health === "rebooting") return { ok: false, reason: "Restarting" };
  if (d.health === "updating") return { ok: false, reason: "Updating" };
  if (d.health === "unknown") return { ok: false, reason: "Checking" };
  return { ok: false, reason: "Offline" };
}

// ---- backup contents in words -----------------------------------------------------------------------------------------

const MODE: Record<string, string> = { out: "Output", in: "Input", pwm: "PWM", servo: "Servo", adc: "Analog (ADC)", off: "Off", input: "Input", output: "Output", analog: "Analog (ADC)" };
export const pinModeLabel = (mode: string): string => MODE[mode] ?? mode;

/** "Debounce 50 ms · Invert on": the settings that are in the file, in plain words. */
export function pinSettings(file: BackupPin): string {
  const pin: Record<string, unknown> = { ...file }; // the file carries the device's own option names next to gpio and mode
  const parts: string[] = [];
  const num = (k: string) => (typeof pin[k] === "number" ? (pin[k] as number) : null);
  if (pin.invert !== undefined) parts.push(`Invert ${pin.invert ? "on" : "off"}`);
  if (pin.pull_up !== undefined) parts.push(pin.pull_up ? "Pull-up on" : "Pull-up off");
  if (pin.boot !== undefined) parts.push(`Start ${Number(pin.boot) ? "High" : "Low"}`);
  if (num("debounce_ms") !== null) parts.push(`Debounce ${num("debounce_ms")} ms`);
  if (num("hz") !== null) parts.push(`${num("hz")} Hz`);
  if (num("duty") !== null) parts.push(`Duty ${num("duty")}`);
  if (num("angle") !== null) parts.push(`${num("angle")}°`);
  if (num("min_us") !== null && num("max_us") !== null) parts.push(`${num("min_us")}–${num("max_us")} µs`);
  if (num("sample_ms") !== null) parts.push(`Sample ${num("sample_ms")} ms`);
  if (num("hysteresis_mv") !== null) parts.push(`Hysteresis ${num("hysteresis_mv")} mV`);
  if (num("smooth") !== null) parts.push(`Smoothing ${num("smooth")} %`);
  return parts.join(" · ");
}

export function moduleSettings(m: BackupModule): string {
  const s = m.settings ?? {};
  const parts = Object.entries(s).map(([k, v]) => `${k.replace(/_/g, " ")} ${String(v)}`);
  return parts.join(" · ");
}

export function modulePins(m: BackupModule): string {
  return Object.entries(m.pins ?? {})
    .map(([k, v]) => `${k.toUpperCase()} ${v}`)
    .join(" · ");
}

const OPS: Record<string, string> = { gt: ">", lt: "<", ge: "≥", le: "≤", eq: "=", ne: "≠" };
const onOff = (v: number | undefined) => (v === undefined ? "?" : v ? "On" : "Off");

/** One rule as a sentence: "When GPIO 32 > 1000 set GPIO 4 On, otherwise Off". */
export function ruleText(r: BackupRule): string {
  if (!r.on || r.on.gpio === undefined) return "Rule";
  const op = OPS[r.on.op ?? ""] ?? r.on.op ?? "?";
  const cond = `When GPIO ${r.on.gpio} ${op} ${r.on.value ?? ""}`.trim();
  const then = r.then?.gpio === undefined ? "" : ` set GPIO ${r.then.gpio} ${onOff(r.then.value)}`;
  const other = r.else?.value === undefined ? "" : `, otherwise ${onOff(r.else.value)}`;
  return `${cond}${then}${other}`;
}

/** MQTT line of a backup file, or "Not set". */
export const mqttText = (f: Pick<BackupFile, "mqtt">): string => (f.mqtt?.uri ? f.mqtt.uri : "Not set");

// ---- restore plan ---------------------------------------------------------------------------------------------------

export interface PlanGroupInfo {
  title: string;
  mark: "add" | "del" | "chg";
  ops: BackupStepOp[];
}

/** Spec 3.8 step 2, in apply order. */
export const PLAN_GROUPS: PlanGroupInfo[] = [
  { title: "Remove rules", mark: "del", ops: ["rule.remove"] },
  { title: "Remove add-ons", mark: "del", ops: ["module.remove"] },
  { title: "Turn off pins", mark: "del", ops: ["pin.disable"] },
  { title: "Set pins", mark: "add", ops: ["pin.configure"] },
  { title: "Add or reconfigure add-ons", mark: "add", ops: ["module.add", "module.configure"] },
  { title: "Add rules", mark: "add", ops: ["rule.set"] },
  { title: "MQTT broker", mark: "chg", ops: ["mqtt.configure"] },
  { title: "Device name", mark: "chg", ops: ["identity.set_name"] },
];

export const MARK_CHAR = { add: "+", del: "−", chg: "~" } as const;

/** Per step: add / remove / change marker ("module.configure" re-applies, so it is a change). */
export function stepMark(op: BackupStepOp): "add" | "del" | "chg" {
  if (op === "module.configure" || op === "mqtt.configure" || op === "identity.set_name") return "chg";
  if (op === "rule.remove" || op === "module.remove" || op === "pin.disable") return "del";
  return "add";
}

export const INCLUDE_LABELS: Record<keyof BackupInclude, string> = { pins: "Pins", modules: "Add-ons", rules: "Rules", mqtt: "MQTT broker", name: "Device name" };

/** Names of the unticked categories: "MQTT broker, device name". */
export function notIncluded(include: BackupInclude): string {
  const names = (Object.keys(INCLUDE_LABELS) as (keyof BackupInclude)[]).filter((k) => include[k] === false).map((k) => INCLUDE_LABELS[k]);
  const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  return names.map((n, i) => (i === 0 ? n : lower(n))).join(", ");
}

/** Defaults of "What to copy": everything except the device name, which is opt-in for both restore and clone. */
export const defaultInclude = (_forClone: boolean): Required<BackupInclude> => ({ pins: true, modules: true, rules: true, mqtt: true, name: false });

/** The plan view's name line: "Name: kept as 'X'" or "Name: 'X' -> 'Y'". */
export function nameLine(targetName: string, newName: string | null): string {
  return newName === null ? `Name: kept as '${targetName}'` : `Name: '${targetName}' → '${newName}'`;
}

/**
 * A plan step's text from the server. Rule steps say "set GPIO 4 to 1, otherwise 0"; the details view says On/Off,
 * so outputs are worded the same here ("set GPIO 4 On, otherwise Off").
 */
export function stepSummaryText(summary: string): string {
  if (!summary.startsWith("Set rule ")) return summary;
  return summary.replace(/(set GPIO \d+) to ([01])\b/, (_m, a: string, v: string) => `${a} ${onOff(Number(v))}`).replace(/otherwise ([01])\b/, (_m, v: string) => `otherwise ${onOff(Number(v))}`);
}
