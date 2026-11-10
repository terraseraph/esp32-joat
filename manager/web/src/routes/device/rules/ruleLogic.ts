import type { LiveIoMap, PinConfigResponse } from "@shared/api";
import type { Rule, RuleAction, RuleInput, RuleOp, RuleOpInput } from "@shared/device-api";

export const MAX_RULES = 8;
export const MAX_RULE_ID = 7;

export type RuleMode = "in" | "out" | "adc" | "pwm" | "servo";

export const MODE_LABEL: Record<RuleMode, string> = { in: "Input", out: "Output", adc: "Analog", pwm: "PWM", servo: "Servo" };

/** Operators in the order the form offers them (`label` is what people read). */
export const OPS: Array<{ value: RuleOp; label: string; word: string }> = [
  { value: "gt", label: ">", word: "is above" },
  { value: "ge", label: "≥", word: "is at least" },
  { value: "lt", label: "<", word: "is below" },
  { value: "le", label: "≤", word: "is at most" },
  { value: "eq", label: "=", word: "equals" },
  { value: "ne", label: "≠", word: "is not" },
];

const OP_ALIASES: Record<RuleOpInput, RuleOp> = { gt: "gt", ge: "ge", lt: "lt", le: "le", eq: "eq", ne: "ne", ">": "gt", ">=": "ge", "<": "lt", "<=": "le", "==": "eq", "!=": "ne" };

export function normalizeOp(op: string): RuleOp {
  return OP_ALIASES[op as RuleOpInput] ?? "eq";
}

export function opSymbol(op: string): string {
  const o = normalizeOp(op);
  return OPS.find((x) => x.value === o)?.label ?? op;
}

/** gpio -> mode of every configured pin in a live I/O map (add-on states have no `mode` and are skipped). */
export function pinModes(io: LiveIoMap): Map<number, RuleMode> {
  const out = new Map<number, RuleMode>();
  for (const v of Object.values(io)) {
    const s = v as { gpio?: unknown; mode?: unknown };
    if (typeof s.gpio === "number" && (s.mode === "in" || s.mode === "out" || s.mode === "adc" || s.mode === "pwm" || s.mode === "servo")) out.set(s.gpio, s.mode);
  }
  return out;
}

export const isSourceMode = (m: RuleMode | undefined): boolean => m === "in" || m === "adc" || m === "out";
export const isDestMode = (m: RuleMode | undefined): boolean => m === "out" || m === "pwm" || m === "servo";

/** Valid range of a destination value per mode (digital 0/1, duty 0-1000, angle 0-180). */
export function destRange(mode: RuleMode | undefined): { min: number; max: number } {
  if (mode === "pwm") return { min: 0, max: 1000 };
  if (mode === "servo") return { min: 0, max: 180 };
  return { min: 0, max: 1 };
}

export const ADC_MAX_MV = 3300;

const pinText = (gpio: number, modes: Map<number, RuleMode>): string => {
  const m = modes.get(gpio);
  return m ? `GPIO ${gpio} (${MODE_LABEL[m]})` : `GPIO ${gpio}`;
};

export interface RulePart {
  text: string;
  strong?: boolean;
}

function actionText(a: RuleAction, modes: Map<number, RuleMode>): string {
  const m = modes.get(a.gpio);
  if (m === "pwm") return `GPIO ${a.gpio} (PWM) duty = ${a.value}`;
  if (m === "servo") return `GPIO ${a.gpio} (Servo) angle = ${a.value}°`;
  return `GPIO ${a.gpio} = ${a.value}`;
}

/** The rule in plain words, as pieces so the UI can bold the pins and values. */
export function describeRuleParts(rule: Pick<Rule, "on" | "then" | "else">, io: LiveIoMap): RulePart[] {
  const modes = pinModes(io);
  const srcMode = modes.get(rule.on.gpio);
  const val = srcMode === "adc" ? `${rule.on.value} mV` : String(rule.on.value);
  const parts: RulePart[] = [
    { text: "When " },
    { text: pinText(rule.on.gpio, modes), strong: true },
    { text: " " },
    { text: `${opSymbol(rule.on.op)} ${val}`, strong: true },
    { text: " then " },
    { text: actionText(rule.then, modes), strong: true },
  ];
  if (rule.else) parts.push({ text: ", otherwise " }, { text: actionText(rule.else, modes), strong: true });
  return parts;
}

/** "When GPIO 32 (Analog) > 1000 mV then GPIO 4 = 1, otherwise GPIO 4 = 0" */
export function describeRule(rule: Pick<Rule, "on" | "then" | "else">, io: LiveIoMap): string {
  return describeRuleParts(rule, io)
    .map((p) => p.text)
    .join("");
}

/** Destinations of a rule that are not output pins right now (the device accepts such a rule but it does nothing). */
export function inertDestinations(rule: Pick<Rule, "then" | "else">, io: LiveIoMap): number[] {
  const modes = pinModes(io);
  return [rule.then, rule.else].filter((a): a is RuleAction => Boolean(a)).filter((a) => !isDestMode(modes.get(a.gpio))).map((a) => a.gpio);
}

// ---- Form ----------------------------------------------------------------------------------------------------------

export interface RuleForm {
  /** Empty = default `r<source>`. Fixed when editing. */
  id: string;
  enabled: boolean;
  src: number | undefined;
  op: RuleOp;
  value: number | undefined;
  dst: number | undefined;
  thenValue: number | undefined;
  elseOn: boolean;
  elseDst: number | undefined;
  elseValue: number | undefined;
}

export const defaultRuleId = (src: number | undefined): string => (src === undefined ? "" : `r${src}`);

export function sourcePins(io: LiveIoMap): number[] {
  return [...pinModes(io)].filter(([, m]) => isSourceMode(m)).map(([g]) => g).sort((a, b) => a - b);
}

export function destinationPins(io: LiveIoMap): number[] {
  return [...pinModes(io)].filter(([, m]) => isDestMode(m)).map(([g]) => g).sort((a, b) => a - b);
}

/** Sensible starting value for a destination of `mode`. */
export const defaultThenValue = (mode: RuleMode | undefined): number => (mode === "pwm" ? 500 : mode === "servo" ? 90 : 1);
export const defaultElseValue = (): number => 0;

export function defaultSourceValue(mode: RuleMode | undefined): number {
  return mode === "adc" ? 1000 : 1;
}

/** New-rule form: the first source pin that has no rule yet, and the first output that is not that pin. */
export function defaultRuleForm(rules: readonly Rule[], io: LiveIoMap): RuleForm {
  const modes = pinModes(io);
  const sources = sourcePins(io);
  const src = sources.find((g) => !rules.some((r) => r.on.gpio === g)) ?? sources[0];
  const dst = destinationPins(io).find((g) => g !== src);
  return {
    id: "",
    enabled: true,
    src,
    op: "gt",
    value: src === undefined ? undefined : defaultSourceValue(modes.get(src)),
    dst,
    thenValue: defaultThenValue(dst === undefined ? undefined : modes.get(dst)),
    elseOn: false,
    elseDst: dst,
    elseValue: defaultElseValue(),
  };
}

export function formFromRule(rule: Rule): RuleForm {
  return {
    id: rule.id,
    enabled: rule.enabled,
    src: rule.on.gpio,
    op: normalizeOp(rule.on.op),
    value: rule.on.value,
    dst: rule.then.gpio,
    thenValue: rule.then.value,
    elseOn: rule.else !== undefined,
    elseDst: rule.else?.gpio ?? rule.then.gpio,
    elseValue: rule.else?.value ?? defaultElseValue(),
  };
}

export interface RuleErrors {
  general?: string;
  id?: string;
  src?: string;
  value?: string;
  dst?: string;
  thenValue?: string;
  elseDst?: string;
  elseValue?: string;
}

export interface RuleValidation {
  errors: RuleErrors;
  /** Does not block saving. */
  warnings: string[];
  valid: boolean;
  /** The existing rule this save would overwrite on the device (upsert by id, then by source). */
  replaces: Rule | null;
  /** All 8 slots are used and this save would add a ninth. */
  full: boolean;
  /** Id that will be sent. */
  id: string;
}

const intIn = (v: number | undefined, min: number, max: number): boolean => v !== undefined && Number.isInteger(v) && v >= min && v <= max;

/**
 * Mirrors `rule.set` on the device (spec 2.5): at most 8 rules, id up to 7 characters, one rule per source pin
 * (upsert by id, then by source), destination different from the source. A destination that is not an output
 * is only a warning (the device accepts an inert rule). `originalId` is set when editing (the id is fixed).
 */
export function validateRule(form: RuleForm, rules: readonly Rule[], io: LiveIoMap, originalId?: string): RuleValidation {
  const modes = pinModes(io);
  const errors: RuleErrors = {};
  const warnings: string[] = [];
  const id = (originalId ?? (form.id.trim() || defaultRuleId(form.src))).trim();

  if (id === "") errors.id = "Pick a source pin or type an id";
  else if (id.length > MAX_RULE_ID) errors.id = `max ${MAX_RULE_ID} characters`;
  else if (/\s/.test(id)) errors.id = "No spaces";

  const srcMode = form.src === undefined ? undefined : modes.get(form.src);
  if (form.src === undefined) errors.src = "Choose the pin to watch";
  else if (!isSourceMode(srcMode)) errors.src = `GPIO ${form.src} is not an input, analog or output pin right now`;

  if (srcMode === "adc") {
    if (!intIn(form.value, 0, ADC_MAX_MV)) errors.value = `Enter millivolts from 0 to ${ADC_MAX_MV}`;
  } else if (!intIn(form.value, 0, 1)) errors.value = "Choose Low (0) or High (1)";

  const checkDest = (gpio: number | undefined, value: number | undefined, key: "dst" | "elseDst", valueKey: "thenValue" | "elseValue") => {
    if (gpio === undefined) {
      errors[key] = "Choose the pin to drive";
      return;
    }
    if (gpio === form.src) errors[key] = "Destination must be different from the source pin";
    const m = modes.get(gpio);
    if (!isDestMode(m)) warnings.push(`GPIO ${gpio} is not an output, so the rule would be inert.`);
    const { min, max } = destRange(m);
    const okValue = isDestMode(m) ? intIn(value, min, max) : value !== undefined && Number.isInteger(value);
    if (!okValue) errors[valueKey] = m === "pwm" ? "Duty must be 0 to 1000" : m === "servo" ? "Angle must be 0 to 180" : isDestMode(m) ? "Choose Off (0) or On (1)" : "Enter a whole number";
  };
  checkDest(form.dst, form.thenValue, "dst", "thenValue");
  if (form.elseOn) checkDest(form.elseDst, form.elseValue, "elseDst", "elseValue");

  const byId = rules.find((r) => r.id === id);
  const bySrc = form.src === undefined ? undefined : rules.find((r) => r.on.gpio === form.src);
  if (byId && bySrc && byId.id !== bySrc.id) errors.src = `Rule ${bySrc.id} already uses GPIO ${form.src} as its source. Delete it or choose another pin.`;
  const replaces = byId ?? bySrc ?? null;
  const editingSelf = originalId !== undefined && replaces?.id === originalId;
  if (replaces && !editingSelf) warnings.push(`This replaces rule ${replaces.id} for GPIO ${replaces.on.gpio}.`);

  const full = rules.length >= MAX_RULES && !replaces;
  if (full) errors.general = `All ${MAX_RULES} rule slots are used`;

  const unique = [...new Set(warnings)];
  return { errors, warnings: unique, valid: Object.keys(errors).length === 0, replaces, full, id };
}

export type RuleSetBody = { cmd: "rule.set"; rule: RuleInput };

/** `rule.set` for a validated form (op as the device's word, `else` only when "Otherwise" is on). */
export function buildRuleSet(form: RuleForm): RuleSetBody {
  const src = form.src as number;
  const rule: RuleInput = {
    id: form.id.trim() || defaultRuleId(src),
    enabled: form.enabled,
    on: { gpio: src, op: form.op, value: form.value as number },
    then: { gpio: form.dst as number, value: form.thenValue as number },
  };
  if (form.elseOn && form.elseDst !== undefined) rule.else = { gpio: form.elseDst, value: form.elseValue as number };
  return { cmd: "rule.set", rule };
}

/** `rule.set` that only flips `enabled` of an existing rule. */
export function buildRuleToggle(rule: Rule, enabled: boolean): RuleSetBody {
  const input: RuleInput = { id: rule.id, enabled, on: { ...rule.on }, then: { ...rule.then } };
  if (rule.else) input.else = { ...rule.else };
  return { cmd: "rule.set", rule: input };
}

/** Minimal I/O map (gpio + mode only) from the Manager's pin-config view, for before the live snapshot arrives. */
export function ioFromPinConfig(resp: PinConfigResponse): LiveIoMap {
  const out: Record<string, unknown> = {};
  for (const p of resp.pins) out[`${p.mode}_${p.gpio}`] = { id: `${p.mode}_${p.gpio}`, mode: p.mode, gpio: p.gpio };
  return out as LiveIoMap;
}
