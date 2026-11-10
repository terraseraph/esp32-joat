import type { LiveIoMap } from "@shared/api";
import type { Rule } from "@shared/device-api";
import { describe, expect, it } from "vitest";
import {
  buildRuleSet, buildRuleToggle, defaultRuleForm, describeRule, destinationPins, formFromRule, inertDestinations, ioFromPinConfig, pinModes, sourcePins, validateRule,
  type RuleForm,
} from "./ruleLogic";

const io = {
  gpio_4: { id: "gpio_4", mode: "out", gpio: 4, level: 0 },
  gpio_27: { id: "gpio_27", mode: "in", gpio: 27, level: 1 },
  adc_32: { id: "adc_32", mode: "adc", gpio: 32, mv: 1650, raw: 2000, sample_ms: 100, hysteresis_mv: 0, smooth: 0 },
  pwm_18: { id: "pwm_18", mode: "pwm", gpio: 18, hz: 1000, duty: 250 },
  servo_19: { id: "servo_19", mode: "servo", gpio: 19, angle: 90, pulse_us: 1500, min_us: 500, max_us: 2400, hz: 50 },
  mod_env0: { id: "env0", type: "bme280", ok: true, addr: 118 },
} as unknown as LiveIoMap;

const r32: Rule = { id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } };
const r27: Rule = { id: "r27", enabled: true, on: { gpio: 27, op: "eq", value: 1 }, then: { gpio: 18, value: 800 } };

describe("pin helpers", () => {
  it("maps gpio to mode and skips add-ons", () => {
    expect([...pinModes(io)].sort((a, b) => a[0] - b[0])).toEqual([[4, "out"], [18, "pwm"], [19, "servo"], [27, "in"], [32, "adc"]]);
    expect(sourcePins(io)).toEqual([4, 27, 32]);
    expect(destinationPins(io)).toEqual([4, 18, 19]);
  });
});

describe("describeRule", () => {
  it("writes ADC rules in millivolts with the otherwise branch", () => {
    expect(describeRule(r32, io)).toBe("When GPIO 32 (Analog) > 1000 mV then GPIO 4 = 1, otherwise GPIO 4 = 0");
  });
  it("writes digital levels and PWM duty", () => {
    expect(describeRule(r27, io)).toBe("When GPIO 27 (Input) = 1 then GPIO 18 (PWM) duty = 800");
  });
  it("maps operators and servo angles", () => {
    const r: Rule = { id: "r1", enabled: true, on: { gpio: 32, op: "le", value: 200 }, then: { gpio: 19, value: 45 } };
    expect(describeRule(r, io)).toBe("When GPIO 32 (Analog) ≤ 200 mV then GPIO 19 (Servo) angle = 45°");
    expect(describeRule({ ...r, on: { gpio: 27, op: "ne", value: 0 } }, io)).toContain("GPIO 27 (Input) ≠ 0");
  });
  it("reports destinations that are not outputs", () => {
    expect(inertDestinations(r32, io)).toEqual([]);
    expect(inertDestinations({ then: { gpio: 27, value: 1 }, else: { gpio: 5, value: 0 } }, io)).toEqual([27, 5]);
  });
});

describe("validateRule", () => {
  const base = (over: Partial<RuleForm> = {}): RuleForm => ({ ...defaultRuleForm([], io), ...over });

  it("accepts the default form and derives the id from the source", () => {
    const form = base();
    expect(form.src).toBe(4);
    const v = validateRule(base({ src: 32, value: 1000, dst: 4, thenValue: 1 }), [], io);
    expect(v.valid).toBe(true);
    expect(v.id).toBe("r32");
    expect(v.warnings).toEqual([]);
  });
  it("requires destination different from the source (also for otherwise)", () => {
    const v = validateRule(base({ src: 4, dst: 4, thenValue: 1, value: 1, elseOn: true, elseDst: 4, elseValue: 0 }), [], io);
    expect(v.errors.dst).toBe("Destination must be different from the source pin");
    expect(v.errors.elseDst).toBe("Destination must be different from the source pin");
    expect(v.valid).toBe(false);
  });
  it("limits the id to 7 characters", () => {
    expect(validateRule(base({ src: 32, value: 1, id: "toolongid" }), [], io).errors.id).toBe("max 7 characters");
    expect(validateRule(base({ src: 32, value: 1, id: "ok" }), [], io).errors.id).toBeUndefined();
  });
  it("checks value ranges per mode", () => {
    expect(validateRule(base({ src: 32, value: 5000 }), [], io).errors.value).toMatch(/0 to 3300/);
    expect(validateRule(base({ src: 27, value: 2 }), [], io).errors.value).toBeDefined();
    expect(validateRule(base({ src: 27, value: 1, dst: 18, thenValue: 1001 }), [], io).errors.thenValue).toMatch(/0 to 1000/);
    expect(validateRule(base({ src: 27, value: 1, dst: 19, thenValue: 181 }), [], io).errors.thenValue).toMatch(/0 to 180/);
    expect(validateRule(base({ src: 27, value: 1, dst: 4, thenValue: 2 }), [], io).errors.thenValue).toBeDefined();
  });
  it("warns, but does not block, when the destination is not an output", () => {
    const v = validateRule(base({ src: 32, value: 1000, dst: 27, thenValue: 1 }), [], io);
    expect(v.valid).toBe(true);
    expect(v.warnings).toEqual(["GPIO 27 is not an output, so the rule would be inert."]);
  });
  it("blocks a ninth rule but allows replacing or editing when full", () => {
    const eight: Rule[] = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, enabled: true, on: { gpio: 100 + i, op: "gt", value: 1 }, then: { gpio: 4, value: 1 } }) as Rule);
    const full = validateRule(base({ src: 32, value: 1 }), eight, io);
    expect(full.full).toBe(true);
    expect(full.errors.general).toBe("All 8 rule slots are used");
    expect(full.valid).toBe(false);
    const edit = validateRule(formFromRule(eight[0]!), eight, io, "r0");
    expect(edit.full).toBe(false);
    expect(edit.errors.general).toBeUndefined();
  });
  it("warns when a new rule replaces the rule on the same source", () => {
    const v = validateRule(base({ src: 32, value: 500, dst: 4, thenValue: 1 }), [r32], io);
    expect(v.replaces?.id).toBe("r32");
    expect(v.warnings).toContain("This replaces rule r32 for GPIO 32.");
    expect(v.valid).toBe(true);
  });
  it("does not warn when editing a rule's own slot, and blocks a source another rule uses", () => {
    expect(validateRule(formFromRule(r32), [r32, r27], io, "r32").warnings).toEqual([]);
    const clash = validateRule({ ...formFromRule(r32), src: 27 }, [r32, r27], io, "r32");
    expect(clash.errors.src).toMatch(/Rule r27 already uses GPIO 27/);
  });
  it("rejects a source that is no longer a configured pin", () => {
    expect(validateRule(base({ src: 99, value: 1 }), [], io).errors.src).toMatch(/GPIO 99/);
  });
});

describe("command bodies", () => {
  it("buildRuleSet sends words for ops and only adds else when enabled", () => {
    const form: RuleForm = { ...defaultRuleForm([], io), src: 32, op: "gt", value: 1000, dst: 18, thenValue: 500, id: "", elseOn: false };
    expect(buildRuleSet(form)).toEqual({ cmd: "rule.set", rule: { id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 18, value: 500 } } });
    expect(buildRuleSet({ ...form, elseOn: true, elseDst: 18, elseValue: 0, id: "mine" }).rule).toMatchObject({ id: "mine", else: { gpio: 18, value: 0 } });
  });
  it("round-trips a rule through the form", () => {
    expect(buildRuleSet(formFromRule(r32)).rule).toEqual(r32);
  });
  it("buildRuleToggle flips enabled and keeps the rest", () => {
    expect(buildRuleToggle(r32, false).rule).toEqual({ ...r32, enabled: false });
    expect(buildRuleToggle(r27, false).rule).not.toHaveProperty("else");
  });
});

describe("ioFromPinConfig", () => {
  it("keeps gpio and mode so modes can be derived before the live snapshot", () => {
    const m = pinModes(ioFromPinConfig({ pins: [{ gpio: 32, mode: "adc", config: {}, source: "live", live: null }, { gpio: 4, mode: "out", config: {}, source: "shadow", live: null }] }));
    expect(m.get(32)).toBe("adc");
    expect(m.get(4)).toBe("out");
  });
});
