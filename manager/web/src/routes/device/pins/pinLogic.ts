import type { PinConfigEntry } from "@shared/api";
import type { HardwareBus, HardwarePin, HeaderPad, IoState, PinConfig, Rule } from "@shared/device-api";

/** Pin modes as the sheet shows them (`disabled` is "Off"). */
export type FormMode = "disabled" | "out" | "in" | "pwm" | "servo" | "adc";
export type ActiveMode = Exclude<FormMode, "disabled">;

export const MODE_LABEL: Record<FormMode, string> = {
  disabled: "Off",
  out: "Output",
  in: "Input",
  pwm: "PWM",
  servo: "Servo",
  adc: "Analog",
};

/** Short text on the pad. */
export const MODE_SHORT: Record<ActiveMode, string> = { out: "OUT", in: "IN", pwm: "PWM", servo: "SRV", adc: "ADC" };

export const MODE_ORDER: FormMode[] = ["disabled", "out", "in", "pwm", "servo", "adc"];

// ---------------------------------------------------------------------------------------------------------------
// Firmware ranges and defaults (spec 2.5 pin.configure)
// ---------------------------------------------------------------------------------------------------------------

export const RANGES = {
  debounce_ms: { min: 0, max: 500, def: 50 },
  hz: { min: 50, max: 20000, def: 1000 },
  dutyPct: { min: 0, max: 100, def: 0 },
  angle: { min: 0, max: 180, def: 90 },
  min_us: { min: 500, max: 1500, def: 500 },
  max_us: { min: 1500, max: 2500, def: 2500 },
  sample_ms: { min: 20, max: 1000, def: 50 },
  hysteresis_mv: { min: 5, max: 500, def: 20 },
  smooth: { min: 0, max: 90, def: 70 },
} as const;

export const ADC2_HINT = "ADC2 cannot be used while Wi-Fi is on";

// ---------------------------------------------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------------------------------------------

export type OwnerInfo =
  | { kind: "none" }
  | { kind: "own"; mode: ActiveMode | null }
  | { kind: "addon"; id: string }
  | { kind: "bus"; id: string };

/** Classify a `hardware.pins[].owner` string. `gpio_N` leaves the mode to the caller (in or out). */
export function parseOwner(owner: string | undefined | null): OwnerInfo {
  const o = owner ?? "";
  if (o === "") return { kind: "none" };
  if (o.startsWith("mod_")) return { kind: "addon", id: o.slice(4) };
  if (o.startsWith("bus_")) return { kind: "bus", id: o.slice(4) };
  if (o.startsWith("adc_")) return { kind: "own", mode: "adc" };
  if (o.startsWith("pwm_")) return { kind: "own", mode: "pwm" };
  if (o.startsWith("servo_")) return { kind: "own", mode: "servo" };
  if (o.startsWith("gpio_")) return { kind: "own", mode: null };
  return { kind: "none" };
}

/** True when the pin is claimed by an add-on or a bus and cannot be reconfigured. */
export function isClaimed(owner: string | undefined | null): boolean {
  const k = parseOwner(owner).kind;
  return k === "addon" || k === "bus";
}

/** "SPI bus VSPI", "I2C 0 bus": the bus label with its kind. */
export function busTitle(id: string, buses: readonly HardwareBus[]): string {
  const bus = buses.find((b) => b.id.toLowerCase() === id.toLowerCase());
  if (!bus) return `${id.toUpperCase()} bus`;
  const kind = bus.kind === "spi" ? "SPI" : bus.kind === "i2c" ? "I2C" : "UART";
  return bus.label.toUpperCase().startsWith(kind) ? `${bus.label} bus` : `${kind} bus ${bus.label}`;
}

/** The role this GPIO plays on the bus (`sck`, `sda`...), or null. */
export function busRole(id: string, gpio: number, buses: readonly HardwareBus[]): string | null {
  const bus = buses.find((b) => b.id.toLowerCase() === id.toLowerCase());
  if (!bus) return null;
  const hit = Object.entries(bus.pins).find(([, g]) => g === gpio);
  return hit ? hit[0].toUpperCase() : null;
}

/** Plain-language explanation of who owns the pin ("" for a free or self-configured pin). */
export function ownerExplanation(pin: HardwarePin, buses: readonly HardwareBus[]): string {
  const info = parseOwner(pin.owner);
  if (info.kind === "addon") return `Used by add-on ${info.id}`;
  if (info.kind === "bus") return busTitle(info.id, buses);
  return "";
}

// ---------------------------------------------------------------------------------------------------------------
// Which modes a pin offers
// ---------------------------------------------------------------------------------------------------------------

export interface ModeOption {
  mode: FormMode;
  disabled?: boolean;
  /** Why the option is disabled. */
  hint?: string;
}

/**
 * Modes the sheet offers for a pin, mirroring the firmware's legality rules (spec 2.3):
 * flash pins and pins owned by an add-on or bus offer nothing; `out|pwm|servo` need `output` and not `input_only`
 * (pwm/servo also `pwm`); `in` needs `input`; `adc` needs `adc1` (ADC2 pins show it disabled with a hint);
 * a `servo_*` owner can only be retargeted as servo (other modes are disabled with a hint). Off is always there.
 * Modes the hardware cannot do are left out entirely.
 */
export function allowedModes(pin: HardwarePin, owner: string = pin.owner): ModeOption[] {
  if (pin.flash || isClaimed(owner)) return [];
  const servoOwned = owner.startsWith("servo_");
  const offerOut = pin.output && !pin.input_only;
  const out: ModeOption[] = [{ mode: "disabled" }];
  const add = (mode: ActiveMode, supported: boolean, hardHint?: string) => {
    if (!supported && !hardHint) return;
    if (!supported) {
      out.push({ mode, disabled: true, hint: hardHint });
      return;
    }
    if (servoOwned && mode !== "servo") out.push({ mode, disabled: true, hint: "This pin is a servo. Turn it Off first to use another mode." });
    else out.push({ mode });
  };
  add("out", offerOut);
  add("in", pin.input);
  add("pwm", offerOut && pin.pwm);
  add("servo", offerOut && pin.pwm);
  if (pin.adc1) add("adc", true);
  else if (pin.adc2) add("adc", false, ADC2_HINT);
  return out;
}

/** The modes of `allowedModes` that can actually be chosen. */
export function selectableModes(pin: HardwarePin, owner: string = pin.owner): FormMode[] {
  return allowedModes(pin, owner)
    .filter((o) => !o.disabled)
    .map((o) => o.mode);
}

// ---------------------------------------------------------------------------------------------------------------
// Form <-> pin.configure
// ---------------------------------------------------------------------------------------------------------------

export interface PinForm {
  invert: boolean;
  pullUp: boolean;
  pullDown: boolean;
  /** Level at boot (out). */
  boot: 0 | 1;
  debounce: number | undefined;
  hz: number | undefined;
  /** PWM duty in percent (0-100); the device takes 0-1000. */
  dutyPct: number | undefined;
  angle: number | undefined;
  minUs: number | undefined;
  maxUs: number | undefined;
  sampleMs: number | undefined;
  hysteresis: number | undefined;
  smooth: number | undefined;
  /** Options this form does not edit but must not drop on re-save. */
  keep: { irq?: boolean; delivery?: "reliable" | "latest" };
}

export function defaultForm(): PinForm {
  return {
    invert: false,
    pullUp: false,
    pullDown: false,
    boot: 0,
    debounce: RANGES.debounce_ms.def,
    hz: RANGES.hz.def,
    dutyPct: RANGES.dutyPct.def,
    angle: RANGES.angle.def,
    minUs: RANGES.min_us.def,
    maxUs: RANGES.max_us.def,
    sampleMs: RANGES.sample_ms.def,
    hysteresis: RANGES.hysteresis_mv.def,
    smooth: RANGES.smooth.def,
    keep: {},
  };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Pre-fill the form from a `pin-config` entry's `config` (missing options fall back to the firmware defaults). */
export function formFromConfig(config: Record<string, unknown> | null | undefined): PinForm {
  const f = defaultForm();
  if (!config) return f;
  f.invert = config.invert === true;
  f.pullUp = config.pull_up === true;
  f.pullDown = config.pull_down === true;
  f.boot = config.boot === 1 || config.boot === true ? 1 : 0;
  f.debounce = num(config.debounce_ms) ?? f.debounce;
  f.hz = num(config.hz) ?? f.hz;
  const duty = num(config.duty);
  if (duty !== undefined) f.dutyPct = Math.round(duty) / 10;
  f.angle = num(config.angle) ?? f.angle;
  f.minUs = num(config.min_us) ?? f.minUs;
  f.maxUs = num(config.max_us) ?? f.maxUs;
  f.sampleMs = num(config.sample_ms) ?? f.sampleMs;
  f.hysteresis = num(config.hysteresis_mv) ?? f.hysteresis;
  f.smooth = num(config.smooth) ?? f.smooth;
  if (config.irq === false) f.keep.irq = false;
  if (config.delivery === "reliable" || config.delivery === "latest") f.keep.delivery = config.delivery;
  return f;
}

export function toFormMode(mode: string | undefined | null): FormMode {
  return mode === "out" || mode === "in" || mode === "pwm" || mode === "servo" || mode === "adc" ? mode : "disabled";
}

export type FormErrors = Partial<Record<"debounce" | "hz" | "dutyPct" | "angle" | "minUs" | "maxUs" | "sampleMs" | "hysteresis" | "smooth", string>>;

function checkRange(value: number | undefined, min: number, max: number, unit: string, integer = true): string | undefined {
  if (value === undefined) return "Enter a number";
  if (integer && !Number.isInteger(value)) return "Enter a whole number";
  if (value < min || value > max) return `Enter ${min}-${max}${unit}`;
  return undefined;
}

/** Client-side validation mirroring the firmware ranges. Empty object = valid. */
export function validateForm(mode: FormMode, form: PinForm): FormErrors {
  const e: FormErrors = {};
  const put = (k: keyof FormErrors, msg: string | undefined) => {
    if (msg) e[k] = msg;
  };
  switch (mode) {
    case "in":
      put("debounce", checkRange(form.debounce, RANGES.debounce_ms.min, RANGES.debounce_ms.max, " ms"));
      break;
    case "pwm":
      put("hz", checkRange(form.hz, RANGES.hz.min, RANGES.hz.max, " Hz"));
      put("dutyPct", checkRange(form.dutyPct, RANGES.dutyPct.min, RANGES.dutyPct.max, " %", false));
      if (!e.dutyPct && form.dutyPct !== undefined && Math.abs(form.dutyPct * 10 - Math.round(form.dutyPct * 10)) > 1e-6) e.dutyPct = "Use at most one decimal";
      break;
    case "servo":
      put("angle", checkRange(form.angle, RANGES.angle.min, RANGES.angle.max, "°"));
      put("minUs", checkRange(form.minUs, RANGES.min_us.min, RANGES.min_us.max, " µs"));
      put("maxUs", checkRange(form.maxUs, RANGES.max_us.min, RANGES.max_us.max, " µs"));
      break;
    case "adc":
      put("sampleMs", checkRange(form.sampleMs, RANGES.sample_ms.min, RANGES.sample_ms.max, " ms"));
      put("hysteresis", checkRange(form.hysteresis, RANGES.hysteresis_mv.min, RANGES.hysteresis_mv.max, " mV"));
      put("smooth", checkRange(form.smooth, RANGES.smooth.min, RANGES.smooth.max, " %"));
      break;
    default:
      break;
  }
  return e;
}

const clamp = (v: number | undefined, min: number, max: number, def: number): number => {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
};

export interface BuildOptions {
  /** False for pins without an internal pull (input-only 34-39): pull options are never sent. Default true. */
  pull?: boolean;
}

/**
 * The minimal `pin.configure` pin object: `{gpio, mode}` plus only options that differ from the firmware defaults.
 * Values are clamped to the firmware ranges (validate first to tell the user). `disabled` sends just `{gpio, mode}`.
 */
export function buildPinConfig(gpio: number, mode: FormMode, form: PinForm, opts: BuildOptions = {}): PinConfig {
  const pin: PinConfig = { gpio, mode };
  const pull = opts.pull !== false;
  switch (mode) {
    case "out":
    case "in": {
      if (form.invert) pin.invert = true;
      if (pull && form.pullUp) pin.pull_up = true;
      if (pull && form.pullDown) pin.pull_down = true;
      if (mode === "out") {
        if (form.boot === 1) pin.boot = 1;
      } else {
        const deb = clamp(form.debounce, RANGES.debounce_ms.min, RANGES.debounce_ms.max, RANGES.debounce_ms.def);
        if (deb !== RANGES.debounce_ms.def) pin.debounce_ms = deb;
        if (form.keep.irq === false) pin.irq = false;
      }
      break;
    }
    case "pwm": {
      const hz = clamp(form.hz, RANGES.hz.min, RANGES.hz.max, RANGES.hz.def);
      if (hz !== RANGES.hz.def) pin.hz = hz;
      const duty = clamp((form.dutyPct ?? 0) * 10, 0, 1000, 0);
      if (duty !== 0) pin.duty = duty;
      break;
    }
    case "servo": {
      const angle = clamp(form.angle, RANGES.angle.min, RANGES.angle.max, RANGES.angle.def);
      if (angle !== RANGES.angle.def) pin.angle = angle;
      const min = clamp(form.minUs, RANGES.min_us.min, RANGES.min_us.max, RANGES.min_us.def);
      if (min !== RANGES.min_us.def) pin.min_us = min;
      const max = clamp(form.maxUs, RANGES.max_us.min, RANGES.max_us.max, RANGES.max_us.def);
      if (max !== RANGES.max_us.def) pin.max_us = max;
      break;
    }
    case "adc": {
      const s = clamp(form.sampleMs, RANGES.sample_ms.min, RANGES.sample_ms.max, RANGES.sample_ms.def);
      if (s !== RANGES.sample_ms.def) pin.sample_ms = s;
      const h = clamp(form.hysteresis, RANGES.hysteresis_mv.min, RANGES.hysteresis_mv.max, RANGES.hysteresis_mv.def);
      if (h !== RANGES.hysteresis_mv.def) pin.hysteresis_mv = h;
      const m = clamp(form.smooth, RANGES.smooth.min, RANGES.smooth.max, RANGES.smooth.def);
      if (m !== RANGES.smooth.def) pin.smooth = m;
      break;
    }
    default:
      return { gpio, mode: "disabled" };
  }
  if (form.keep.delivery) pin.delivery = form.keep.delivery;
  return pin;
}

// ---------------------------------------------------------------------------------------------------------------
// What a pin currently does (pinout colours, list rows)
// ---------------------------------------------------------------------------------------------------------------

export type PinUse =
  | { kind: "flash" }
  | { kind: "free" }
  | { kind: "mode"; mode: ActiveMode }
  | { kind: "addon"; id: string }
  | { kind: "bus"; id: string };

export type LiveIo = Readonly<Record<string, IoState>>;

/** Current use of a pin from the hardware owner, the live I/O map and pin-config. */
export function pinUse(pin: HardwarePin, cfg: PinConfigEntry | undefined, io: LiveIo | undefined): PinUse {
  if (pin.flash) return { kind: "flash" };
  const info = parseOwner(pin.owner);
  if (info.kind === "addon") return { kind: "addon", id: info.id };
  if (info.kind === "bus") return { kind: "bus", id: info.id };
  if (info.kind === "own") {
    if (info.mode) return { kind: "mode", mode: info.mode };
    const live = io?.[pin.owner];
    const m = live && "mode" in live ? live.mode : cfg?.mode;
    return { kind: "mode", mode: m === "in" ? "in" : "out" };
  }
  return { kind: "free" };
}

export type PinFilter = "all" | "used" | "free";

export function matchesFilter(use: PinUse, filter: PinFilter): boolean {
  if (filter === "all") return true;
  if (use.kind === "flash") return false;
  return filter === "used" ? use.kind !== "free" : use.kind === "free";
}

/** Live value text for a pin owned by itself ("High", "1 240 mV", "1000 Hz · 35 %", "90°"), or "". */
export function liveValueText(use: PinUse, pin: HardwarePin, io: LiveIo | undefined): string {
  if (use.kind !== "mode" || !io) return "";
  const s = io[pin.owner];
  if (!s) return "";
  switch ("mode" in s ? s.mode : "") {
    case "in":
    case "out":
      return "level" in s ? (s.level ? "High" : "Low") : "";
    case "adc":
      return "mv" in s ? `${s.mv} mV` : "";
    case "pwm":
      return "duty" in s ? `${Math.round(s.duty / 10)} % · ${s.hz} Hz` : "";
    case "servo":
      return "angle" in s ? `${s.angle}°` : "";
    default:
      return "";
  }
}

/** Label shown next to the GPIO number: the header silk when it differs from the number, else the role. */
export function pinLabel(pin: HardwarePin, pad: HeaderPad | undefined): string {
  const silk = pad?.silk ?? "";
  if (silk && silk !== String(pin.gpio)) return silk;
  return pin.role;
}

/** GPIOs of other pins currently in PWM mode (they share the frequency). */
export function otherPwmPins(pins: readonly HardwarePin[], gpio: number): number[] {
  return pins.filter((p) => p.gpio !== gpio && p.owner.startsWith("pwm_")).map((p) => p.gpio);
}

/** Rules that read from or write to a GPIO. */
export function rulesUsing(rules: readonly Rule[] | null | undefined, gpio: number): Rule[] {
  return (rules ?? []).filter((r) => r.on.gpio === gpio || r.then.gpio === gpio || r.else?.gpio === gpio);
}
