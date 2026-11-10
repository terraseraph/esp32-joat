import type { LiveIoMap } from "@shared/api";
import type {
  AdcState,
  Bme280State,
  GpioState,
  IoState,
  Mfrc522State,
  ModuleInstance,
  PwmState,
  Rule,
  ServoState,
} from "@shared/device-api";

/** Pure mapping from the live I/O map (+ rules, add-on list) to the tile models the Live tab renders. */

export const MAX_MV = 3300;
export const MAX_DUTY = 1000;

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export const dutyToPercent = (duty: number): number => clamp(Math.round(duty / 10), 0, 100);
export const percentToDuty = (percent: number): number => clamp(Math.round(percent * 10), 0, MAX_DUTY);
export const mvToVolts = (mv: number): number => mv / 1000;
export const formatVolts = (volts: number): string => volts.toFixed(2);
/** Bar fill for the 0 to 3.3 V scale, 0..1. */
export const mvFraction = (mv: number): number => clamp(mv / MAX_MV, 0, 1);

export type GroupId = "out" | "in" | "adc" | "pwm" | "servo" | "addon";

export const GROUP_LABEL: Record<GroupId, string> = {
  out: "Outputs",
  in: "Inputs",
  adc: "Analog",
  pwm: "PWM",
  servo: "Servos",
  addon: "Add-ons",
};
const GROUP_ORDER: GroupId[] = ["out", "in", "adc", "pwm", "servo", "addon"];

export interface RuleHints {
  /** Rules that write this pin (`then.gpio` / `else.gpio`), with the source pin that triggers them. */
  drivenBy: Array<{ rule: string; source: number }>;
  /** Rules that read this pin (`on.gpio`). */
  triggers: string[];
}

export function ruleHints(rules: readonly Rule[]): Map<number, RuleHints> {
  const map = new Map<number, RuleHints>();
  const get = (gpio: number): RuleHints => {
    let h = map.get(gpio);
    if (!h) map.set(gpio, (h = { drivenBy: [], triggers: [] }));
    return h;
  };
  for (const r of rules) {
    if (!r.enabled) continue;
    get(r.on.gpio).triggers.push(r.id);
    for (const dest of [r.then, r.else]) {
      if (!dest) continue;
      const h = get(dest.gpio);
      if (!h.drivenBy.some((d) => d.rule === r.id)) h.drivenBy.push({ rule: r.id, source: r.on.gpio });
    }
  }
  return map;
}

/** "Driven by rule r32 (GPIO 32)" or null. */
export function drivenByText(h: RuleHints | undefined): string | null {
  if (!h || h.drivenBy.length === 0) return null;
  const parts = h.drivenBy.map((d) => `${d.rule} (GPIO ${d.source})`);
  return `Driven by rule${parts.length > 1 ? "s" : ""} ${parts.join(", ")}`;
}

/** "Triggers rule r13" or null. */
export function triggersText(h: RuleHints | undefined): string | null {
  if (!h || h.triggers.length === 0) return null;
  return `Triggers rule${h.triggers.length > 1 ? "s" : ""} ${h.triggers.join(", ")}`;
}

interface Base {
  /** State key: `gpio_4`, `mod_env0`. */
  key: string;
  title: string;
  drivenBy: string | null;
  triggers: string | null;
}

export type TileModel =
  | (Base & { kind: "out"; gpio: number; level: 0 | 1 })
  | (Base & { kind: "in"; gpio: number; level: 0 | 1; debounceMs: number | null })
  | (Base & { kind: "adc"; gpio: number; mv: number; volts: number; raw: number; fraction: number })
  | (Base & { kind: "pwm"; gpio: number; duty: number; percent: number; hz: number })
  | (Base & { kind: "servo"; gpio: number; angle: number; pulseUs: number })
  | (Base & {
      kind: "bme280";
      id: string;
      ok: boolean;
      tempC: number | null;
      humidity: number | null;
      pressureHpa: number | null;
      addr: number;
      wiring: string | null;
    })
  | (Base & { kind: "mfrc522"; id: string; present: boolean; uid: string; version: number; wiring: string | null });

export interface TileGroup {
  id: GroupId;
  label: string;
  tiles: TileModel[];
}

const ADDON_NAME: Record<string, string> = { bme280: "BME280", mfrc522: "RC522" };
export const addonName = (type: string): string => ADDON_NAME[type] ?? type;

const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, "0")}`;
export const formatAddr = hex;

function wiringOf(m: ModuleInstance | undefined): string | null {
  if (!m) return null;
  const bus = m.bus.startsWith("i2c") ? `I²C ${m.bus.slice(3)}` : m.bus ? `SPI (${m.bus.toUpperCase()})` : "";
  const pins = Object.entries(m.pins).map(([role, gpio]) => `${role.toUpperCase()} ${gpio}`);
  return [bus, ...pins].filter(Boolean).join(" · ") || null;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const lvl = (v: unknown): 0 | 1 => (v === 1 || v === true ? 1 : 0);

function gpioOf(key: string, s: { gpio?: unknown }): number | null {
  if (typeof s.gpio === "number") return s.gpio;
  const m = /_(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Tile for one state; null for shapes we do not know. */
export function tileFor(key: string, state: IoState, hints: Map<number, RuleHints>, modules: ReadonlyMap<string, ModuleInstance>): TileModel | null {
  if ("type" in state) {
    const id = key.startsWith("mod_") ? key.slice(4) : state.id;
    const mod = modules.get(id);
    const base = { key, title: `${id} · ${addonName(state.type)}`, drivenBy: null, triggers: null };
    if (state.type === "bme280") {
      const s = state as Bme280State;
      const ok = s.ok === true;
      return {
        ...base,
        kind: "bme280",
        id,
        ok,
        tempC: ok && typeof s.t_c === "number" ? s.t_c : null,
        humidity: ok && typeof s.rh === "number" ? s.rh : null,
        pressureHpa: ok && typeof s.p_hpa === "number" ? s.p_hpa : null,
        addr: num(s.addr),
        wiring: wiringOf(mod),
      };
    }
    if (state.type === "mfrc522") {
      const s = state as Mfrc522State;
      return { ...base, kind: "mfrc522", id, present: s.present === true, uid: typeof s.uid === "string" ? s.uid : "", version: num(s.version), wiring: wiringOf(mod) };
    }
    return null;
  }
  const gpio = gpioOf(key, state);
  if (gpio === null) return null;
  const h = hints.get(gpio);
  const base = { key, title: `GPIO ${gpio}`, drivenBy: drivenByText(h), triggers: triggersText(h) };
  switch (state.mode) {
    case "out":
      return { ...base, kind: "out", gpio, level: lvl((state as GpioState).level) };
    case "in":
      return { ...base, kind: "in", gpio, level: lvl((state as GpioState).level), debounceMs: typeof (state as GpioState).debounce_ms === "number" ? (state as GpioState).debounce_ms! : null };
    case "adc": {
      const s = state as AdcState;
      const mv = num(s.mv);
      return { ...base, kind: "adc", gpio, mv, volts: mvToVolts(mv), raw: num(s.raw), fraction: mvFraction(mv) };
    }
    case "pwm": {
      const s = state as PwmState;
      const duty = clamp(num(s.duty), 0, MAX_DUTY);
      return { ...base, kind: "pwm", gpio, duty, percent: dutyToPercent(duty), hz: num(s.hz) };
    }
    case "servo": {
      const s = state as ServoState;
      return { ...base, kind: "servo", gpio, angle: clamp(num(s.angle), 0, 180), pulseUs: num(s.pulse_us) };
    }
    default:
      return null;
  }
}

const GROUP_OF: Record<TileModel["kind"], GroupId> = { out: "out", in: "in", adc: "adc", pwm: "pwm", servo: "servo", bme280: "addon", mfrc522: "addon" };

/** Group, order (by GPIO / add-on id) and label every known state. Empty groups are omitted. */
export function buildTiles(io: LiveIoMap, rules: readonly Rule[] = [], modules: readonly ModuleInstance[] = []): TileGroup[] {
  const hints = ruleHints(rules);
  const mods = new Map(modules.map((m) => [m.id, m] as const));
  const groups = new Map<GroupId, TileModel[]>();
  for (const [key, state] of Object.entries(io)) {
    if (!state || typeof state !== "object") continue;
    const tile = tileFor(key, state, hints, mods);
    if (!tile) continue;
    const g = GROUP_OF[tile.kind];
    const list = groups.get(g) ?? [];
    list.push(tile);
    groups.set(g, list);
  }
  const sortKey = (t: TileModel): number => ("gpio" in t ? t.gpio : 0);
  return GROUP_ORDER.flatMap((id) => {
    const tiles = groups.get(id);
    if (!tiles) return [];
    tiles.sort((a, b) => sortKey(a) - sortKey(b) || a.key.localeCompare(b.key));
    return [{ id, label: GROUP_LABEL[id], tiles }];
  });
}

/** Body of the `pin.set` command (minimal; `mode` only for pwm/servo, `out` is the device default). */
export function pinSetBody(kind: "out" | "pwm" | "servo", gpio: number, value: number): { cmd: "pin.set"; gpio: number; value: number; mode?: "pwm" | "servo" } {
  return kind === "out" ? { cmd: "pin.set", gpio, value } : { cmd: "pin.set", gpio, mode: kind, value };
}

/** Patch of a state after the device accepted `pin.set` (adopts the device's value before its own `io` frame). */
export function adoptedState(state: IoState, value: number): IoState {
  if ("type" in state) return state;
  if (state.mode === "out") return { ...state, level: lvl(value) };
  if (state.mode === "pwm") return { ...state, duty: clamp(Math.round(value), 0, MAX_DUTY) };
  if (state.mode === "servo") {
    const angle = clamp(Math.round(value), 0, 180);
    const pulse_us = Math.round(state.min_us + (angle / 180) * (state.max_us - state.min_us));
    return { ...state, angle, pulse_us };
  }
  return state;
}
