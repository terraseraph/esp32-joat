/**
 * Fake device: the command catalog of spec §2.5 (dispatch, validation, error strings).
 * Error strings that the spec quotes are exact; the others are plausible inventions and marked "(invented)".
 */
import { createHash } from "node:crypto";
import type {
  AccessPoint,
  AdcState,
  Bme280State,
  CommandResultMap,
  DeviceCommand,
  DeviceCommandName,
  DeviceEnvelope,
  DeviceWsTopic,
  GpioState,
  Mfrc522State,
  ModuleCatalog,
  ModuleCatalogType,
  ModuleInstance,
  PinConfig,
  PwmState,
  Rule,
  RuleAction,
  RuleOp,
  ServoState,
} from "../src/types/device-api";
import { ipConfirm, ipSet, resetToDhcp, wifiFailReason, wifiFailed, wifiStart, wifiSucceeded, type WifiSnapshot } from "./pending";
import {
  DEFAULT_COMPILE_DATE,
  DEFAULT_COMPILE_TIME,
  FAKE_IDF,
  FAKE_PROJECT,
  moduleInstances,
  networkStatus,
  otaStatus,
  ownerOf,
  pinCaps,
  pushLog,
  rollbackPossible,
  ruleList,
  ioTopic,
  topicIdFor,
  type BootAction,
  type FakeModule,
  type FakeSlot,
  type FakeState,
  type ResolvedOptions,
} from "./state";

// ---------------------------------------------------------------------------------------------------------------
// Context and plumbing
// ---------------------------------------------------------------------------------------------------------------

/** What the command layer may ask of the device shell. */
export interface DeviceControl {
  beginReboot(action: BootAction): Promise<void>;
  /** Go offline (connection refused) without rebooting, e.g. after `network.wifi.clear`. */
  leaveLan(): void;
  /** Start the simulated background fetch of `ota.apply`. */
  otaApply(slot: FakeSlot): void;
  /** Re-listen at another address (`host:port` or a port): a device that joined a network on another subnet. */
  moveTo(addr: string): void;
}

export interface CommandCtx {
  state: FakeState;
  opts: ResolvedOptions;
  emit(topic: DeviceWsTopic, data: unknown): void;
  sleep(ms: number): Promise<void>;
  control: DeviceControl;
}

/** A command failure; the message becomes the envelope's `error` (truncated to 95 chars). */
export class CmdError extends Error {}

/** Reply first, then run `after` (e.g. go offline once the response is on the wire). */
class Deferred {
  constructor(
    readonly result: unknown,
    readonly after: () => void,
  ) {}
}
/** No reply at all: the transport destroys the socket, then `after` runs (reboot paths). */
class Silent {
  constructor(readonly after: () => void) {}
}

export interface CommandOutcome {
  /** `null` = write nothing and drop the connection. */
  reply: DeviceEnvelope<unknown> | null;
  after?: () => void;
}

type Req<K extends DeviceCommandName> = Extract<DeviceCommand, { cmd: K }>;
type Handler<K extends DeviceCommandName> = (ctx: CommandCtx, req: Req<K>) => CommandResultMap[K] | Promise<CommandResultMap[K]> | Deferred | Silent;

export const COMMAND_NAMES: DeviceCommandName[] = [
  "pin.configure",
  "pin.set",
  "io.hydrate",
  "module.catalog",
  "module.list",
  "module.add",
  "module.configure",
  "module.remove",
  "module.cmd",
  "rule.set",
  "rule.remove",
  "rule.list",
  "network.wifi.set",
  "network.wifi.scan",
  "network.wifi.clear",
  "network.recovery_ap",
  "network.ap.set_password",
  "mqtt.configure",
  "identity.set_name",
  "system.reboot",
  "system.factory_reset",
  "ota.apply",
  "ota.rollback",
  "serial.hello",
  "serial.bye",
];

/** Commands that exist only on the PENDING firmware (branch claude/wifi-change-fallback-ab5ac7); "unknown cmd" unless `pendingFirmware`. */
export const PENDING_COMMAND_NAMES: DeviceCommandName[] = ["network.ip.set", "network.ip.confirm"];

/** Commands that bump `generation` and write a log line. */
const CONFIG_CMDS = new Set<string>([
  "pin.configure",
  "module.add",
  "module.configure",
  "module.remove",
  "rule.set",
  "rule.remove",
  "network.wifi.set",
  "network.wifi.clear",
  "network.ap.set_password",
  "mqtt.configure",
  "identity.set_name",
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const clampInt = (v: unknown, lo: number, hi: number, def: number): number => (isNum(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def);
const truthy = (v: unknown, def = false): boolean => (v === undefined || v === null ? def : v === true || v === 1);

function fail(msg: string): never {
  throw new CmdError(msg);
}

// ---------------------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------------------

export async function executeCommand(ctx: CommandCtx, raw: unknown): Promise<CommandOutcome> {
  const req = isObj(raw) ? raw : null;
  const corr = req && typeof req.corr === "string" ? req.corr : undefined;
  const err = (error: string): CommandOutcome => ({
    reply: { v: 1, ok: false, ...(corr !== undefined ? { corr } : {}), error: error.slice(0, 95) },
  });
  if (!req) return err("bad request");
  const cmd = req.cmd;
  if (typeof cmd !== "string" || !Object.prototype.hasOwnProperty.call(HANDLERS, cmd)) return err("unknown cmd");
  if (!ctx.opts.pendingFirmware && (PENDING_COMMAND_NAMES as string[]).includes(cmd)) return err("unknown cmd");
  const handler = (HANDLERS as unknown as Record<string, (c: CommandCtx, r: unknown) => unknown>)[cmd]!;
  let out: unknown;
  try {
    out = await handler(ctx, req);
  } catch (e) {
    if (e instanceof CmdError) return err(e.message);
    throw e;
  }
  if (out instanceof Silent) return { reply: null, after: out.after };
  let after: (() => void) | undefined;
  if (out instanceof Deferred) {
    after = out.after;
    out = out.result;
  }
  if (CONFIG_CMDS.has(cmd)) {
    ctx.state.generation++;
    pushLog(ctx.state, `I (${Math.floor((Date.now() - ctx.state.bootAt) / 10)}) command: ${cmd}`);
  }
  return {
    reply: { v: 1, ok: true, ...(corr !== undefined ? { corr } : {}), ...(out !== undefined ? { result: out } : {}) },
    after,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// pin.configure / pin.set / io
// ---------------------------------------------------------------------------------------------------------------

const IO_KEY_PREFIXES = ["gpio", "adc", "pwm", "servo"];
const MAX_IO_KEYS = 48;
const ENVELOPE_KEYS = new Set(["cmd", "v", "corr"]);

function dropIoKeys(state: FakeState, gpio: number): void {
  for (const p of IO_KEY_PREFIXES) delete state.io[`${p}_${gpio}`];
}

function setIo(ctx: CommandCtx, key: string, value: GpioState | AdcState | PwmState | ServoState | Bme280State | Mfrc522State, emit = true): void {
  if (!(key in ctx.state.io) && Object.keys(ctx.state.io).length >= MAX_IO_KEYS) fail("state registry full (48 keys)");
  ctx.state.io[key] = value;
  if (emit) ctx.emit(ioTopic(value), value);
}

function servoPulse(angle: number, minUs: number, maxUs: number): number {
  return Math.round(minUs + ((maxUs - minUs) * angle) / 180);
}

/** Capability checks from the hardware pin flags (§2.3 "Mode legality"). Messages other than ADC2 are invented. */
function checkCapability(gpio: number, mode: string): void {
  const caps = pinCaps(gpio);
  if (!caps) fail(`GPIO ${gpio} does not exist`);
  if (caps.flash) fail(`GPIO ${gpio} is reserved for SPI flash`);
  if (mode === "out" || mode === "pwm" || mode === "servo") {
    if (!caps.output || caps.input_only) fail(`GPIO ${gpio} cannot be used as output (input-only)`);
    if ((mode === "pwm" || mode === "servo") && !caps.pwm) fail(`GPIO ${gpio} does not support PWM`);
  } else if (mode === "in") {
    if (!caps.input) fail(`GPIO ${gpio} cannot be used as input`);
  } else if (mode === "adc") {
    if (caps.adc2) fail("ADC2 cannot be used while Wi-Fi is on");
    if (!caps.adc1) fail(`GPIO ${gpio} has no ADC1 channel`);
  }
}

/** Build the applied pin (defaults and clamping), the I/O state value, and install it. Returns the applied pin. */
function applyPin(ctx: CommandCtx, raw: Record<string, unknown>, emit: boolean): PinConfig {
  const gpio = raw.gpio;
  if (!isInt(gpio)) fail("gpio required");
  const mode = raw.mode;
  const modes = ["disabled", "out", "in", "pwm", "servo", "adc"];
  if (typeof mode !== "string" || !modes.includes(mode)) fail("unknown mode");
  const state = ctx.state;
  const owner = ownerOf(state, gpio);
  if (owner.startsWith("mod_") || owner.startsWith("bus_")) fail(`GPIO ${gpio} is owned by ${owner}`);
  if (mode === "disabled") {
    dropIoKeys(state, gpio);
    return { gpio, mode: "disabled" };
  }
  if (owner.startsWith("servo_") && mode !== "servo") fail(`GPIO ${gpio} is a servo; only servo mode can retarget it`);
  checkCapability(gpio, mode);

  const applied: PinConfig = { ...raw, gpio, mode: mode as PinConfig["mode"] };
  const ext = state.inputs[gpio];
  dropIoKeys(state, gpio);
  switch (mode) {
    case "out": {
      applied.pull_up = truthy(raw.pull_up);
      applied.pull_down = truthy(raw.pull_down);
      applied.invert = truthy(raw.invert);
      applied.boot = raw.boot === 1 || raw.boot === true ? 1 : 0;
      const level: 0 | 1 = applied.boot === 1 ? 1 : 0;
      setIo(ctx, `gpio_${gpio}`, { id: `gpio_${gpio}`, mode: "out", gpio, level }, emit);
      break;
    }
    case "in": {
      applied.pull_up = truthy(raw.pull_up);
      applied.pull_down = truthy(raw.pull_down);
      applied.invert = truthy(raw.invert);
      applied.irq = truthy(raw.irq, true);
      applied.debounce_ms = clampInt(raw.debounce_ms, 0, 500, 50);
      const level: 0 | 1 = ext !== undefined ? (ext ? 1 : 0) : applied.pull_up ? 1 : 0;
      setIo(ctx, `gpio_${gpio}`, { id: `gpio_${gpio}`, mode: "in", gpio, level, debounce_ms: applied.debounce_ms }, emit);
      break;
    }
    case "pwm": {
      applied.hz = clampInt(raw.hz, 50, 20000, 1000);
      applied.duty = clampInt(raw.duty, 0, 1000, 0);
      setIo(ctx, `pwm_${gpio}`, { id: `pwm_${gpio}`, mode: "pwm", gpio, hz: applied.hz, duty: applied.duty }, emit);
      break;
    }
    case "servo": {
      applied.angle = clampInt(raw.angle, 0, 180, 90);
      applied.min_us = clampInt(raw.min_us, 500, 1500, 500);
      applied.max_us = clampInt(raw.max_us, 1500, 2500, 2500);
      setIo(
        ctx,
        `servo_${gpio}`,
        { id: `servo_${gpio}`, mode: "servo", gpio, angle: applied.angle, pulse_us: servoPulse(applied.angle, applied.min_us, applied.max_us), min_us: applied.min_us, max_us: applied.max_us, hz: 50 },
        emit,
      );
      break;
    }
    case "adc": {
      applied.sample_ms = clampInt(raw.sample_ms, 20, 1000, 50);
      applied.hysteresis_mv = clampInt(raw.hysteresis_mv, 5, 500, 20);
      applied.smooth = clampInt(raw.smooth, 0, 90, 70);
      const mv = ext ?? 0;
      setIo(
        ctx,
        `adc_${gpio}`,
        { id: `adc_${gpio}`, mode: "adc", gpio, mv, raw: Math.round((mv / 3300) * 4095), sample_ms: applied.sample_ms, hysteresis_mv: applied.hysteresis_mv, smooth: applied.smooth },
        emit,
      );
      break;
    }
  }
  return applied;
}

function pinFromRequest(req: Record<string, unknown>): Record<string, unknown> {
  const delivery = req.delivery;
  if (delivery !== undefined && delivery !== "reliable" && delivery !== "latest") fail("delivery must be reliable or latest");
  if (isObj(req.pin)) {
    const pin = { ...req.pin };
    if (pin.delivery !== undefined && pin.delivery !== "reliable" && pin.delivery !== "latest") fail("delivery must be reliable or latest");
    if (delivery !== undefined && pin.delivery === undefined) pin.delivery = delivery;
    return pin;
  }
  const pin: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req)) if (!ENVELOPE_KEYS.has(k)) pin[k] = v;
  return pin;
}

/** Re-apply every persisted pin and module (boot). No events, errors ignored like the firmware's best effort. */
export function rebuildIo(ctx: CommandCtx): void {
  const s = ctx.state;
  s.io = {};
  for (const pin of s.pins) {
    try {
      applyPin(ctx, pin, false);
    } catch {
      /* ignored */
    }
  }
  for (const m of s.modules) {
    if (m.enabled) installModuleState(ctx, m, false);
  }
}

const handlePinConfigure: Handler<"pin.configure"> = (ctx, req) => {
  const raw = pinFromRequest(req as unknown as Record<string, unknown>);
  const applied = applyPin(ctx, raw, true);
  const gpio = applied.gpio;
  const s = ctx.state;
  const idx = s.pins.findIndex((p) => p.gpio === gpio);
  if (applied.mode === "disabled") {
    if (idx >= 0) s.pins.splice(idx, 1);
  } else if (idx >= 0) {
    s.pins[idx] = raw as PinConfig;
  } else {
    s.pins.push(raw as PinConfig);
  }
  return applied;
};

/** Set an output (`out` level / `pwm` duty / `servo` angle). Throws the raw esp_err string on a mode mismatch. */
export function setPinValue(ctx: CommandCtx, gpio: number, value: number, mode: "out" | "pwm" | "servo"): number {
  const s = ctx.state;
  if (mode === "out") {
    const st = s.io[`gpio_${gpio}`];
    if (!st || !("mode" in st) || st.mode !== "out") fail("ESP_ERR_INVALID_STATE");
    const level: 0 | 1 = value ? 1 : 0;
    const changed = st.level !== level;
    st.level = level;
    ctx.emit("io/gpio", st);
    if (changed) fireRules(ctx, gpio, 0);
    return level;
  }
  if (mode === "pwm") {
    const st = s.io[`pwm_${gpio}`];
    if (!st || !("mode" in st) || st.mode !== "pwm") fail("ESP_ERR_INVALID_STATE");
    st.duty = clampInt(value, 0, 1000, 0);
    ctx.emit("io/pwm", st);
    return st.duty;
  }
  const st = s.io[`servo_${gpio}`];
  if (!st || !("mode" in st) || st.mode !== "servo") fail("ESP_ERR_INVALID_STATE");
  st.angle = clampInt(value, 0, 180, 90);
  st.pulse_us = servoPulse(st.angle, st.min_us, st.max_us);
  ctx.emit("io/servo", st);
  return st.angle;
}

const handlePinSet: Handler<"pin.set"> = (ctx, req) => {
  if (!isInt(req.gpio)) fail("gpio required");
  if (!isNum(req.value)) fail("value required");
  const mode = req.mode ?? "out";
  if (mode !== "out" && mode !== "pwm" && mode !== "servo") fail("unknown mode");
  const value = setPinValue(ctx, req.gpio, req.value, mode);
  return { gpio: req.gpio, value };
};

/** Test hook: change the outside world (digital level or ADC millivolts) and run the usual consequences. */
export function setInput(ctx: CommandCtx, gpio: number, value: number): void {
  const s = ctx.state;
  s.inputs[gpio] = value;
  const d = s.io[`gpio_${gpio}`];
  if (d && "mode" in d && d.mode === "in") {
    const level: 0 | 1 = value ? 1 : 0;
    if (d.level !== level) {
      d.level = level;
      ctx.emit("io/gpio", d);
      fireRules(ctx, gpio, 0);
    }
    return;
  }
  const a = s.io[`adc_${gpio}`];
  if (a && "mode" in a && a.mode === "adc") {
    const moved = Math.abs(value - a.mv) >= a.hysteresis_mv;
    a.mv = value;
    a.raw = Math.round((value / 3300) * 4095);
    if (moved) {
      ctx.emit("io/adc", a);
      fireRules(ctx, gpio, 0);
    }
  }
}

const handleIoHydrate: Handler<"io.hydrate"> = (ctx) => {
  const entries = Object.values(ctx.state.io);
  for (const st of entries) ctx.emit(ioTopic(st), st);
  return { pins: entries.length };
};

// ---------------------------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------------------------

const OP_ALIASES: Record<string, RuleOp> = {
  gt: "gt", ">": "gt", ge: "ge", ">=": "ge", lt: "lt", "<": "lt", le: "le", "<=": "le", eq: "eq", "==": "eq", ne: "ne", "!=": "ne",
};

function compare(op: RuleOp, a: number, b: number): boolean {
  switch (op) {
    case "gt": return a > b;
    case "ge": return a >= b;
    case "lt": return a < b;
    case "le": return a <= b;
    case "eq": return a === b;
    case "ne": return a !== b;
  }
}

function fireRules(ctx: CommandCtx, gpio: number, depth: number): void {
  if (depth > 4) return;
  const s = ctx.state;
  for (const rule of s.rules) {
    if (!rule.enabled || rule.on.gpio !== gpio) continue;
    const a = s.io[`adc_${gpio}`];
    const d = s.io[`gpio_${gpio}`];
    let v: number | undefined;
    if (a && "mode" in a && a.mode === "adc") v = a.mv;
    else if (d && "mode" in d && (d.mode === "in" || d.mode === "out")) v = d.level;
    if (v === undefined) continue;
    const target: RuleAction | undefined = compare(rule.on.op, v, rule.on.value) ? rule.then : rule.else;
    if (!target) continue;
    // Destination mode is whatever the pin currently is; a destination that is not an output is inert.
    for (const m of ["out", "pwm", "servo"] as const) {
      const key = m === "out" ? `gpio_${target.gpio}` : `${m}_${target.gpio}`;
      const st = s.io[key];
      if (st && "mode" in st && st.mode === m) {
        const before = m === "out" && "level" in st ? st.level : undefined;
        setPinValue(ctx, target.gpio, target.value, m);
        if (m === "out" && before !== undefined && depth < 4) {
          const now = (s.io[key] as GpioState).level;
          if (now !== before) fireRules(ctx, target.gpio, depth + 1);
        }
        break;
      }
    }
  }
}

function parseAction(v: unknown, label: string, srcGpio: number): RuleAction {
  if (!isObj(v) || !isInt(v.gpio) || !isNum(v.value)) fail(`rule.${label} needs gpio and value`);
  if (v.gpio === srcGpio) fail(`rule.${label}.gpio must differ from on.gpio`);
  return { gpio: v.gpio, value: v.value };
}

const handleRuleSet: Handler<"rule.set"> = (ctx, req) => {
  const r = isObj(req.rule) ? req.rule : null;
  if (!r) fail("rule required");
  const on = r.on;
  if (!isObj(on) || !isInt(on.gpio) || !isNum(on.value)) fail("rule.on needs gpio, op and value");
  const op = typeof on.op === "string" ? OP_ALIASES[on.op] : undefined;
  if (!op) fail("unknown op");
  const then = parseAction(r.then, "then", on.gpio);
  const rule: Rule = {
    id: typeof r.id === "string" && r.id.length > 0 ? r.id.slice(0, 7) : `r${on.gpio}`,
    enabled: truthy(r.enabled, true),
    on: { gpio: on.gpio, op, value: on.value },
    then,
  };
  if (r.else !== undefined && r.else !== null) rule.else = parseAction(r.else, "else", on.gpio);
  const s = ctx.state;
  let idx = s.rules.findIndex((x) => x.id === rule.id);
  if (idx < 0) idx = s.rules.findIndex((x) => x.on.gpio === on.gpio);
  if (idx >= 0) s.rules[idx] = rule;
  else {
    if (s.rules.length >= 8) fail("too many rules (max 8)");
    s.rules.push(rule);
  }
  const dest = [rule.then, rule.else].filter((a): a is RuleAction => !!a);
  for (const a of dest) {
    const st = s.io[`gpio_${a.gpio}`] ?? s.io[`pwm_${a.gpio}`] ?? s.io[`servo_${a.gpio}`];
    if (!st || ("mode" in st && st.mode === "in")) pushLog(s, `W (0) rules: rule ${rule.id} destination gpio ${a.gpio} is not an output (inert)`);
  }
  return ruleList(s);
};

const handleRuleRemove: Handler<"rule.remove"> = (ctx, req) => {
  const s = ctx.state;
  let idx = -1;
  if (typeof req.id === "string") idx = s.rules.findIndex((x) => x.id === req.id);
  else if (isInt(req.gpio)) idx = s.rules.findIndex((x) => x.on.gpio === req.gpio);
  if (idx < 0) fail("rule not found");
  s.rules.splice(idx, 1);
  return ruleList(s);
};

// ---------------------------------------------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------------------------------------------

const ENUM_STEPS = (labels: string[]) => labels.map((label, value) => ({ value, label }));

const CATALOG: ModuleCatalogType[] = [
  {
    type: "bme280",
    label: "BME280",
    summary: "Temperature, pressure and humidity sensor (I2C)",
    bus: "i2c",
    default_bus: "i2c0",
    id_prefix: "env",
    max_instances: 2,
    pins: [
      { role: "sda", required: true, share: "bus", cap: "out" },
      { role: "scl", required: true, share: "bus", cap: "out" },
    ],
    settings: [
      { key: "addr", label: "I2C address", kind: "enum", def: 118, choices: [{ value: 118, label: "0x76" }, { value: 119, label: "0x77" }] },
      { key: "sample_ms", label: "Sample interval (ms)", kind: "int", def: 1000, min: 100, max: 60000 },
      { key: "osrs_t", label: "Temperature oversampling", kind: "enum", def: 1, choices: ENUM_STEPS(["off", "x1", "x2", "x4", "x8", "x16"]) },
      { key: "osrs_p", label: "Pressure oversampling", kind: "enum", def: 1, choices: ENUM_STEPS(["off", "x1", "x2", "x4", "x8", "x16"]) },
      { key: "osrs_h", label: "Humidity oversampling", kind: "enum", def: 1, choices: ENUM_STEPS(["off", "x1", "x2", "x4", "x8", "x16"]) },
      { key: "filter", label: "IIR filter", kind: "enum", def: 0, choices: ENUM_STEPS(["off", "2", "4", "8", "16"]) },
      { key: "mode", label: "Mode", kind: "enum", def: "normal", choices: [{ value: "normal", label: "Normal" }, { value: "forced", label: "Forced" }] },
    ],
  },
  {
    type: "mfrc522",
    label: "MFRC522 RFID reader",
    summary: "13.56 MHz RFID reader (SPI)",
    bus: "spi",
    default_bus: "vspi",
    id_prefix: "rfid",
    max_instances: 4,
    pins: [
      { role: "sck", required: true, share: "bus", cap: "out" },
      { role: "miso", required: true, share: "bus", cap: "in" },
      { role: "mosi", required: true, share: "bus", cap: "out" },
      { role: "ss", required: true, share: "instance", cap: "out" },
      { role: "rst", required: false, share: "instance", cap: "out" },
    ],
    settings: [
      { key: "poll_ms", label: "Poll interval (ms)", kind: "int", def: 100, min: 20, max: 2000 },
      { key: "rx_gain", label: "Receiver gain", kind: "int", def: 4, min: 0, max: 7 },
    ],
  },
];

/** Heap a module needs to be admitted (invented numbers, so tests can trigger the "need N bytes" error). */
const MODULE_MEMORY: Record<string, number> = { bme280: 6144, mfrc522: 12288 };

const BUS_CHOICES: Record<string, string[]> = { spi: ["vspi", "hspi"], i2c: ["i2c0", "i2c1"] };

function catalogType(type: unknown): ModuleCatalogType {
  const t = CATALOG.find((c) => c.type === type);
  if (!t) fail("unknown module type");
  return t;
}

function normalizeSettings(def: ModuleCatalogType, input: unknown, base: FakeModule["settings"]): FakeModule["settings"] {
  const out: FakeModule["settings"] = { ...base };
  const src = isObj(input) ? input : {};
  for (const sdef of def.settings) {
    const v = src[sdef.key];
    if (v === undefined) {
      if (out[sdef.key] === undefined) out[sdef.key] = sdef.def;
      continue;
    }
    if (sdef.kind === "int") {
      if (!isNum(v)) fail(`setting ${sdef.key} must be a number`);
      out[sdef.key] = Math.min(sdef.max ?? v, Math.max(sdef.min ?? v, Math.round(v)));
    } else {
      if (!(sdef.choices ?? []).some((c) => c.value === v)) fail(`setting ${sdef.key} has an invalid value`);
      out[sdef.key] = v as number | string;
    }
  }
  return out;
}

function validateModule(ctx: CommandCtx, m: FakeModule, existing: FakeModule | undefined): void {
  const s = ctx.state;
  const def = catalogType(m.type);
  if (!(BUS_CHOICES[def.bus] ?? []).includes(m.bus)) fail(`bus must be ${(BUS_CHOICES[def.bus] ?? []).join("|")}`);
  const seen = new Set<number>();
  for (const p of def.pins) {
    const g = m.pins[p.role];
    if (g === undefined) {
      if (p.required) fail(`pin ${p.role} required`);
      continue;
    }
    if (!isInt(g)) fail(`pin ${p.role} invalid`);
    const caps = pinCaps(g);
    if (!caps || caps.flash || (p.cap === "out" && (!caps.output || caps.input_only)) || (p.cap === "in" && !caps.input)) fail(`GPIO ${g} cannot be used as ${p.role}`);
    if (seen.has(g)) fail("module pins must be unique");
    seen.add(g);
  }
  if (!m.enabled) return;
  const others = s.modules.filter((o) => o.id !== m.id && o.enabled);
  for (const p of def.pins) {
    const g = m.pins[p.role];
    if (g === undefined) continue;
    for (const o of others) {
      const role = Object.entries(o.pins).find(([, og]) => og === g)?.[0];
      if (role === undefined) continue;
      const sharedBus = p.share === "bus" && o.bus === m.bus && role === p.role;
      if (!sharedBus) fail(`GPIO ${g} is in use (mod_${o.id})`);
    }
    if (p.share === "bus") {
      const mate = others.find((o) => o.bus === m.bus);
      if (mate && mate.pins[p.role] !== g) fail("shared bus pins must match");
    }
    const owner = ownerOf(s, g);
    if (owner && !owner.startsWith("mod_")) fail(`GPIO ${g} is in use (${owner})`);
  }
  if (def.bus === "i2c") {
    const clash = others.find((o) => o.bus === m.bus && o.type === m.type && o.settings.addr === m.settings.addr);
    if (clash) fail(`I2C address ${String(m.settings.addr)} already used on ${m.bus}`);
  }
  const need = MODULE_MEMORY[m.type] ?? 0;
  if (!existing?.enabled) {
    const { largest, free } = s.memory.internal;
    if (largest < need) fail(`need ${need} bytes, largest ${largest}, free ${free}`);
  }
}

function installModuleState(ctx: CommandCtx, m: FakeModule, emit: boolean): void {
  const key = `mod_${m.id}`;
  if (m.type === "bme280") {
    const st: Bme280State = { id: m.id, type: "bme280", ok: true, addr: Number(m.settings.addr ?? 118), t_c: 22.5, p_hpa: 1013.2, rh: 45.1 };
    setIo(ctx, key, st, emit);
  } else {
    const st: Mfrc522State = { id: m.id, type: "mfrc522", present: false, uid: "", version: 146, tx: 3 };
    setIo(ctx, key, st, emit);
  }
}

function moduleFields(req: Record<string, unknown>): Record<string, unknown> {
  return isObj(req.module) ? { ...req, ...req.module } : req;
}

function moduleResult(ctx: CommandCtx): { v: 1; modules: ModuleInstance[] } {
  return { v: 1, modules: moduleInstances(ctx.state) };
}

const handleModuleCatalog: Handler<"module.catalog"> = (): ModuleCatalog => JSON.parse(JSON.stringify({ types: CATALOG })) as ModuleCatalog;

const handleModuleList: Handler<"module.list"> = (ctx) => moduleResult(ctx);

const handleModuleAdd: Handler<"module.add"> = (ctx, req) => {
  const f = moduleFields(req as unknown as Record<string, unknown>);
  if (f.delivery !== undefined && f.delivery !== "reliable" && f.delivery !== "latest") fail("delivery must be reliable or latest");
  const def = catalogType(f.type);
  const s = ctx.state;
  let id = f.id;
  if (id === undefined || id === null || id === "") {
    let n = 0;
    while (s.modules.some((m) => m.id === `${def.id_prefix}${n}`)) n++;
    id = `${def.id_prefix}${n}`;
  }
  if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,15}$/.test(id)) fail("invalid module id (a-z, 0-9, _, max 16 chars)");
  if (s.modules.some((m) => m.id === id)) fail("id already in use");
  if (s.modules.filter((m) => m.type === def.type).length >= def.max_instances) fail(`${def.type} limited to ${def.max_instances} instances`);
  const m: FakeModule = {
    id,
    type: def.type,
    bus: typeof f.bus === "string" ? f.bus : def.default_bus,
    enabled: truthy(f.enabled, true),
    pins: {},
    settings: {},
  };
  const pins = isObj(f.pins) ? f.pins : {};
  for (const p of def.pins) if (pins[p.role] !== undefined) m.pins[p.role] = pins[p.role] as number;
  m.settings = normalizeSettings(def, f.settings, {});
  validateModule(ctx, m, undefined);
  s.modules.push(m);
  if (m.enabled) installModuleState(ctx, m, true);
  return moduleResult(ctx);
};

const handleModuleConfigure: Handler<"module.configure"> = (ctx, req) => {
  const f = moduleFields(req as unknown as Record<string, unknown>);
  const s = ctx.state;
  const idx = s.modules.findIndex((m) => m.id === f.id);
  const old = s.modules[idx];
  if (!old) fail("unknown module id");
  const def = catalogType(old.type);
  const next: FakeModule = {
    ...old,
    bus: typeof f.bus === "string" ? f.bus : old.bus,
    enabled: f.enabled === undefined ? old.enabled : truthy(f.enabled),
    pins: { ...old.pins },
    settings: normalizeSettings(def, f.settings, old.settings),
  };
  if (isObj(f.pins)) for (const p of def.pins) if (f.pins[p.role] !== undefined) next.pins[p.role] = f.pins[p.role] as number;
  validateModule(ctx, next, old); // validate before touching anything: "rolls back" trivially
  s.modules[idx] = next;
  delete s.io[`mod_${next.id}`];
  if (next.enabled) installModuleState(ctx, next, true);
  return moduleResult(ctx);
};

const handleModuleRemove: Handler<"module.remove"> = (ctx, req) => {
  const idx = ctx.state.modules.findIndex((m) => m.id === req.id);
  if (idx < 0) fail("unknown module id");
  const [m] = ctx.state.modules.splice(idx, 1);
  delete ctx.state.io[`mod_${m!.id}`];
  return moduleResult(ctx);
};

const handleModuleCmd: Handler<"module.cmd"> = (ctx, req) => {
  if (!ctx.state.modules.some((m) => m.id === req.id)) fail("unknown module id");
  return fail("module has no commands");
};

// ---------------------------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------------------------

function emitNet(ctx: CommandCtx): void {
  ctx.emit("net", { state: ctx.state.network.state, sta_ip: ctx.state.network.sta_ip });
}

const handleWifiSet: Handler<"network.wifi.set"> = async (ctx, req) => {
  if (typeof req.ssid !== "string" || req.ssid === "") fail("ssid required");
  const net = ctx.state.network;
  let snap: WifiSnapshot | undefined;
  if (ctx.state.pending) {
    if (ctx.state.pending.wifiTesting) fail("wifi test failed; credentials not saved"); // only one test at a time
    snap = wifiStart(ctx.state, req.ssid, () => emitNet(ctx));
  }
  net.state = "sta_connecting";
  net.sta_connected = false;
  emitNet(ctx);
  await ctx.sleep(ctx.opts.wifiSetDelayMs);
  // Pending firmware: the password "wrong-password" is refused (`auth`), like a router that does not accept it.
  const failed =
    ctx.opts.wifiSetFails ||
    req.ssid === "fail" ||
    (ctx.state.pending !== undefined && ((req.ssid !== "" && wifiFailReason(req.ssid) !== "auth") || req.password === "wrong-password"));
  if (snap && failed) {
    // Pending firmware: the saved network is restored (old IP mode included); no apsta_recovery.
    wifiFailed(ctx.state, req.ssid, wifiFailReason(req.ssid), snap);
    emitNet(ctx);
    if (ctx.opts.wifiSetDropsResponse) return new Silent(() => {}) as never;
    fail("wifi test failed; credentials not saved");
  }
  net.state = "apsta_recovery"; // SoftAP stays up until a reboot either way (§2.7 #1)
  if (failed) {
    net.sta_ip = "";
    net.sta_connected = false;
    emitNet(ctx);
    if (ctx.opts.wifiSetDropsResponse) return new Silent(() => {}) as never;
    fail("wifi test failed; credentials not saved");
  }
  if (ctx.opts.apMode) net.state = "sta_connected"; // a board that was in setup mode: joined, same port
  net.sta_connected = true;
  net.provisioned = true;
  net.rssi = -55;
  net.sta_ip = net.sta_ip || "192.168.1.42";
  if (ctx.state.pending) wifiSucceeded(ctx.state, req.ssid);
  emitNet(ctx);
  const result = { ...networkStatus(ctx.state), mdns: true };
  const moveTo = ctx.state.pending ? ctx.opts.wifiMoves[req.ssid] : undefined;
  const after = (): void => (moveTo === undefined ? undefined : ctx.control.moveTo(moveTo));
  if (ctx.opts.wifiSetDropsResponse) return new Silent(after) as never;
  return new Deferred(result, after) as never;
};

const handleWifiScan: Handler<"network.wifi.scan"> = async (ctx): Promise<AccessPoint[]> => {
  await ctx.sleep(ctx.opts.scanDelayMs);
  return ctx.state.scan.map((a) => ({ ...a }));
};

const handleWifiClear: Handler<"network.wifi.clear"> = (ctx) => {
  const net = ctx.state.network;
  net.state = "ap_only";
  net.sta_ip = "";
  net.sta_connected = false;
  net.provisioned = false;
  resetToDhcp(ctx.state);
  emitNet(ctx);
  return new Deferred(networkStatus(ctx.state), () => ctx.control.leaveLan()) as never;
};

const handleRecoveryAp: Handler<"network.recovery_ap"> = (ctx) => {
  ctx.state.network.state = "apsta_recovery";
  emitNet(ctx);
  return networkStatus(ctx.state);
};

const handleApPassword: Handler<"network.ap.set_password"> = (ctx, req) => {
  const pw = req.password;
  if (typeof pw !== "string" || (pw !== "" && (pw.length < 8 || pw.length > 63))) fail("AP password must be empty (open) or 8-63 characters");
  ctx.state.apPassword = pw;
  ctx.state.network.ap_open = pw === "";
  return networkStatus(ctx.state);
};

const handleIpSet: Handler<"network.ip.set"> = (ctx, req) => {
  const error = ipSet(ctx.state, req as unknown as Record<string, unknown>, () => emitNet(ctx));
  if (error) fail(error);
  return networkStatus(ctx.state);
};

const handleIpConfirm: Handler<"network.ip.confirm"> = (ctx, req) => {
  const error = ipConfirm(ctx.state, req as unknown as Record<string, unknown>, () => emitNet(ctx));
  if (error) fail(error);
  return networkStatus(ctx.state);
};

// ---------------------------------------------------------------------------------------------------------------
// MQTT, identity, system, OTA, serial
// ---------------------------------------------------------------------------------------------------------------

const handleMqttConfigure: Handler<"mqtt.configure"> = (ctx, req) => {
  const m = ctx.state.mqtt;
  const uri = typeof req.uri === "string" && req.uri !== "" ? req.uri : m.uri;
  if (!uri) fail("uri required (mqtt://host:1883)");
  const oldRoot = m.root;
  if (typeof req.root === "string") m.root = req.root.replace(/[^A-Za-z0-9_\-/]/g, "") || "devices";
  if (typeof req.user === "string") {
    m.user = req.user;
    m.password = typeof req.password === "string" ? req.password : "";
  }
  m.uri = uri;
  m.enabled = true; // there is no way to disable MQTT once configured (§12)
  m.connected = true;
  m.reconnects++;
  m.last_error = "";
  // Firmware leak (§12 #1): the raw request, password included, plus old_root, goes to every WS client.
  ctx.emit("mqtt/reconfigure", { ...(req as unknown as Record<string, unknown>), old_root: oldRoot });
  return { uri: m.uri, root: m.root };
};

const handleSetName: Handler<"identity.set_name"> = (ctx, req) => {
  const s = ctx.state;
  let name = s.hostname;
  if (typeof req.name === "string" && req.name !== "") {
    if (req.name.length > 31) fail("name too long (max 31 chars)");
    name = req.name;
  }
  const old = s.topic_id;
  s.name = name;
  s.topic_id = topicIdFor(name, s.hostname);
  ctx.emit("identity/rename", { old_topic_id: old, topic_id: s.topic_id, name });
  return { name, topic_id: s.topic_id, id: s.id };
};

const handleReboot: Handler<"system.reboot"> = (ctx) => new Silent(() => void ctx.control.beginReboot({}));
const handleFactoryReset: Handler<"system.factory_reset"> = (ctx) => new Silent(() => void ctx.control.beginReboot({ factory: true }));

const handleOtaApply: Handler<"ota.apply"> = (ctx, req) => {
  const o = ctx.state.ota;
  if (o.session === "writing" || o.session === "fetching") fail("ota busy");
  if (typeof req.url !== "string" || !/^https?:\/\/./.test(req.url) || req.url.length >= 384) fail("url must be http:// or https://");
  if (o.image_state === "pending_verify") fail("running image still pending verify");
  const version = createHash("sha1").update(req.url).digest("hex").slice(0, 7);
  const slot: FakeSlot = { app_version: version, compile_date: DEFAULT_COMPILE_DATE, compile_time: DEFAULT_COMPILE_TIME, idf: FAKE_IDF, project: FAKE_PROJECT };
  o.session = "fetching";
  o.bytes = 0;
  o.total = 1048576;
  o.percent = 0;
  o.incoming_version = version;
  o.incoming_project = FAKE_PROJECT;
  delete o.last_error;
  const result = { ...otaStatus(ctx.state), note: "fetching in background; the device reboots when the image is written" };
  return new Deferred(result, () => ctx.control.otaApply(slot)) as never;
};

const handleOtaRollback: Handler<"ota.rollback"> = (ctx) => {
  const o = ctx.state.ota;
  if (o.session === "writing" || o.session === "fetching") fail("ota busy");
  if (!rollbackPossible(ctx.state)) fail("no valid previous slot");
  return new Silent(() => void ctx.control.beginReboot({ rollback: true }));
};

const handleSerialHello: Handler<"serial.hello"> = (ctx) => {
  const s = ctx.state;
  s.serialSession = true;
  return { id: s.id, name: s.name, topic_id: s.topic_id, hostname: s.hostname, fw: s.fw };
};

const handleSerialBye: Handler<"serial.bye"> = (ctx) => {
  ctx.state.serialSession = false;
  return { session: false };
};

const HANDLERS: { [K in DeviceCommandName]: Handler<K> } = {
  "pin.configure": handlePinConfigure,
  "pin.set": handlePinSet,
  "io.hydrate": handleIoHydrate,
  "module.catalog": handleModuleCatalog,
  "module.list": handleModuleList,
  "module.add": handleModuleAdd,
  "module.configure": handleModuleConfigure,
  "module.remove": handleModuleRemove,
  "module.cmd": handleModuleCmd,
  "rule.set": handleRuleSet,
  "rule.remove": handleRuleRemove,
  "rule.list": (ctx) => ruleList(ctx.state),
  "network.wifi.set": handleWifiSet,
  "network.wifi.scan": handleWifiScan,
  "network.wifi.clear": handleWifiClear,
  "network.recovery_ap": handleRecoveryAp,
  "network.ap.set_password": handleApPassword,
  "network.ip.set": handleIpSet,
  "network.ip.confirm": handleIpConfirm,
  "mqtt.configure": handleMqttConfigure,
  "identity.set_name": handleSetName,
  "system.reboot": handleReboot,
  "system.factory_reset": handleFactoryReset,
  "ota.apply": handleOtaApply,
  "ota.rollback": handleOtaRollback,
  "serial.hello": handleSerialHello,
  "serial.bye": handleSerialBye,
};
