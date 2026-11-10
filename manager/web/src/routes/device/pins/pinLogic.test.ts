import type { PinConfigEntry } from "@shared/api";
import type { HardwareBus, HardwarePin, Rule } from "@shared/device-api";
import { describe, expect, it } from "vitest";
import {
  ADC2_HINT,
  allowedModes,
  buildPinConfig,
  busRole,
  busTitle,
  defaultForm,
  formFromConfig,
  matchesFilter,
  otherPwmPins,
  ownerExplanation,
  pinUse,
  rulesUsing,
  selectableModes,
  validateForm,
  type PinForm,
} from "./pinLogic";

function pin(gpio: number, over: Partial<HardwarePin> = {}): HardwarePin {
  return {
    gpio,
    input: true,
    output: true,
    pull: true,
    pwm: true,
    adc1: false,
    adc2: false,
    touch: false,
    dac: false,
    strap: false,
    flash: false,
    input_only: false,
    status_led: false,
    boot_btn: false,
    adc_channel: 0,
    touch_channel: 0,
    role: "",
    notes: "",
    owner: "",
    ...over,
  };
}

const P4 = pin(4, { adc2: true, touch: true });
const P2 = pin(2, { adc2: true, strap: true, status_led: true });
const P0 = pin(0, { adc2: true, strap: true, boot_btn: true });
const P12 = pin(12, { adc2: true, strap: true });
const P34 = pin(34, { output: false, pull: false, pwm: false, input_only: true, adc1: true });
const P36 = pin(36, { output: false, pull: false, pwm: false, input_only: true, adc1: true });
const P25 = pin(25, { adc2: true, dac: true });
const P32 = pin(32, { adc1: true });
const P6 = pin(6, { flash: true, input: false, output: false, pwm: false, pull: false });

const modes = (p: HardwarePin, owner?: string) => selectableModes(p, owner);

describe("allowedModes", () => {
  it("offers everything but Analog on an ADC2 GPIO, with Analog shown disabled and a hint", () => {
    expect(modes(P4)).toEqual(["disabled", "out", "in", "pwm", "servo"]);
    const adc = allowedModes(P4).find((o) => o.mode === "adc");
    expect(adc).toEqual({ mode: "adc", disabled: true, hint: ADC2_HINT });
    expect(allowedModes(P25).find((o) => o.mode === "adc")?.disabled).toBe(true);
  });

  it("treats strapping pins like normal pins (the sheet only adds a note)", () => {
    for (const p of [P2, P0, P12]) expect(modes(p)).toEqual(["disabled", "out", "in", "pwm", "servo"]);
  });

  it("limits input-only pins to Off, Input and Analog", () => {
    expect(modes(P34)).toEqual(["disabled", "in", "adc"]);
    expect(modes(P36)).toEqual(["disabled", "in", "adc"]);
    expect(allowedModes(P36).every((o) => !o.disabled)).toBe(true);
  });

  it("offers Analog on an ADC1 pin that can also drive outputs", () => {
    expect(modes(P32)).toEqual(["disabled", "out", "in", "pwm", "servo", "adc"]);
  });

  it("offers nothing on flash pins", () => {
    expect(allowedModes(P6)).toEqual([]);
  });

  it("offers nothing on pins owned by an add-on or a bus", () => {
    expect(allowedModes({ ...P4, owner: "mod_env0" })).toEqual([]);
    expect(allowedModes(pin(21, { owner: "bus_i2c0" }))).toEqual([]);
    expect(allowedModes(P4, "mod_rfid0")).toEqual([]);
  });

  it("lets a servo-owned pin only be retargeted as servo (others disabled with a hint) or turned Off", () => {
    const owned = { ...P4, owner: "servo_4" };
    expect(modes(owned)).toEqual(["disabled", "servo"]);
    const all = allowedModes(owned);
    expect(all.map((o) => o.mode)).toEqual(["disabled", "out", "in", "pwm", "servo", "adc"]);
    expect(all.find((o) => o.mode === "adc")?.hint).toBe(ADC2_HINT);
    expect(all.find((o) => o.mode === "out")).toMatchObject({ disabled: true });
    expect(all.find((o) => o.mode === "out")?.hint).toMatch(/Turn it Off first/);
  });

  it("keeps pwm and servo off pins without PWM capability", () => {
    expect(modes(pin(5, { pwm: false }))).toEqual(["disabled", "out", "in"]);
  });
});

describe("buildPinConfig", () => {
  const f = (over: Partial<PinForm> = {}): PinForm => ({ ...defaultForm(), ...over });

  it("sends only gpio and mode when everything is at the defaults", () => {
    expect(buildPinConfig(4, "out", f())).toEqual({ gpio: 4, mode: "out" });
    expect(buildPinConfig(13, "in", f())).toEqual({ gpio: 13, mode: "in" });
    expect(buildPinConfig(25, "pwm", f())).toEqual({ gpio: 25, mode: "pwm" });
    expect(buildPinConfig(26, "servo", f())).toEqual({ gpio: 26, mode: "servo" });
    expect(buildPinConfig(32, "adc", f())).toEqual({ gpio: 32, mode: "adc" });
  });

  it("sends mode Off as disabled with nothing else", () => {
    expect(buildPinConfig(4, "disabled", f({ invert: true, hz: 5000 }))).toEqual({ gpio: 4, mode: "disabled" });
  });

  it("includes only options that differ from the defaults", () => {
    expect(buildPinConfig(4, "out", f({ invert: true, pullUp: true, boot: 1 }))).toEqual({ gpio: 4, mode: "out", invert: true, pull_up: true, boot: 1 });
    expect(buildPinConfig(13, "in", f({ pullDown: true, debounce: 50 }))).toEqual({ gpio: 13, mode: "in", pull_down: true });
    expect(buildPinConfig(13, "in", f({ debounce: 120 }))).toEqual({ gpio: 13, mode: "in", debounce_ms: 120 });
    expect(buildPinConfig(25, "pwm", f({ hz: 5000, dutyPct: 35 }))).toEqual({ gpio: 25, mode: "pwm", hz: 5000, duty: 350 });
    expect(buildPinConfig(26, "servo", f({ angle: 45, minUs: 600, maxUs: 2400 }))).toEqual({ gpio: 26, mode: "servo", angle: 45, min_us: 600, max_us: 2400 });
    expect(buildPinConfig(32, "adc", f({ sampleMs: 100, hysteresis: 10, smooth: 0 }))).toEqual({ gpio: 32, mode: "adc", sample_ms: 100, hysteresis_mv: 10, smooth: 0 });
  });

  it("does not leak options of other modes and never sends name", () => {
    const p = buildPinConfig(25, "pwm", f({ invert: true, pullUp: true, angle: 10, sampleMs: 500, hz: 2000 }));
    expect(p).toEqual({ gpio: 25, mode: "pwm", hz: 2000 });
    expect(p).not.toHaveProperty("name");
  });

  it("drops pull options on pins without an internal pull", () => {
    expect(buildPinConfig(34, "in", f({ pullUp: true, invert: true }), { pull: false })).toEqual({ gpio: 34, mode: "in", invert: true });
  });

  it("clamps out-of-range values to the firmware ranges", () => {
    expect(buildPinConfig(25, "pwm", f({ hz: 10, dutyPct: 250 }))).toEqual({ gpio: 25, mode: "pwm", hz: 50, duty: 1000 });
    expect(buildPinConfig(25, "pwm", f({ hz: 99999 }))).toMatchObject({ hz: 20000 });
    expect(buildPinConfig(13, "in", f({ debounce: 900 }))).toMatchObject({ debounce_ms: 500 });
    expect(buildPinConfig(26, "servo", f({ angle: 400, minUs: 100, maxUs: 9000 }))).toEqual({ gpio: 26, mode: "servo", angle: 180 });
    expect(buildPinConfig(32, "adc", f({ sampleMs: 1, hysteresis: 9999, smooth: 99 }))).toEqual({ gpio: 32, mode: "adc", sample_ms: 20, hysteresis_mv: 500, smooth: 90 });
  });

  it("treats empty numbers as the default", () => {
    expect(buildPinConfig(25, "pwm", f({ hz: undefined, dutyPct: undefined }))).toEqual({ gpio: 25, mode: "pwm" });
  });

  it("keeps irq:false and delivery that were set outside the form", () => {
    const form = formFromConfig({ gpio: 13, mode: "in", irq: false, delivery: "latest" });
    expect(buildPinConfig(13, "in", form)).toEqual({ gpio: 13, mode: "in", irq: false, delivery: "latest" });
  });
});

describe("validateForm", () => {
  const f = (over: Partial<PinForm> = {}): PinForm => ({ ...defaultForm(), ...over });

  it("accepts defaults and boundaries", () => {
    for (const m of ["disabled", "out", "in", "pwm", "servo", "adc"] as const) expect(validateForm(m, f())).toEqual({});
    expect(validateForm("pwm", f({ hz: 50, dutyPct: 100 }))).toEqual({});
    expect(validateForm("pwm", f({ hz: 20000, dutyPct: 0.1 }))).toEqual({});
    expect(validateForm("servo", f({ angle: 0, minUs: 1500, maxUs: 1500 }))).toEqual({});
  });

  it("reports out-of-range, empty and fractional values per field", () => {
    expect(validateForm("in", f({ debounce: 501 }))).toHaveProperty("debounce");
    expect(validateForm("in", f({ debounce: -1 }))).toHaveProperty("debounce");
    expect(validateForm("in", f({ debounce: undefined }))).toHaveProperty("debounce");
    expect(validateForm("pwm", f({ hz: 49 }))).toHaveProperty("hz");
    expect(validateForm("pwm", f({ dutyPct: 100.5 }))).toHaveProperty("dutyPct");
    expect(validateForm("pwm", f({ dutyPct: 12.34 }))).toHaveProperty("dutyPct");
    expect(Object.keys(validateForm("servo", f({ angle: 181, minUs: 499, maxUs: 2501 }))).sort()).toEqual(["angle", "maxUs", "minUs"]);
    expect(Object.keys(validateForm("adc", f({ sampleMs: 19, hysteresis: 4, smooth: 91 }))).sort()).toEqual(["hysteresis", "sampleMs", "smooth"]);
    expect(validateForm("adc", f({ sampleMs: 20.5 }))).toHaveProperty("sampleMs");
  });

  it("only validates the fields of the chosen mode", () => {
    expect(validateForm("out", f({ hz: 1, angle: 999 }))).toEqual({});
  });
});

describe("formFromConfig", () => {
  it("falls back to the defaults for missing options and shows duty as percent", () => {
    expect(formFromConfig({ gpio: 25, mode: "pwm", duty: 350, hz: 5000 })).toMatchObject({ dutyPct: 35, hz: 5000, angle: 90 });
    expect(formFromConfig(undefined)).toEqual(defaultForm());
    const out = formFromConfig({ gpio: 4, mode: "out", invert: true, boot: 1 });
    expect(out).toMatchObject({ invert: true, boot: 1, pullUp: false });
  });

  it("round-trips through buildPinConfig", () => {
    const cfg = { gpio: 26, mode: "servo" as const, angle: 30, min_us: 600 };
    expect(buildPinConfig(26, "servo", formFromConfig(cfg))).toEqual(cfg);
  });
});

describe("owners, use and filters", () => {
  const buses: HardwareBus[] = [
    { id: "vspi", kind: "spi", label: "VSPI", pins: { sck: 18, miso: 19, mosi: 23, ss: 5 } },
    { id: "i2c0", kind: "i2c", label: "I2C 0", pins: { sda: 21, scl: 22 } },
  ];

  it("explains add-on and bus owners", () => {
    expect(ownerExplanation({ ...P4, owner: "mod_env0" }, buses)).toBe("Used by add-on env0");
    expect(ownerExplanation({ ...P4, gpio: 18, owner: "bus_vspi" }, buses)).toBe("SPI bus VSPI");
    expect(ownerExplanation(P4, buses)).toBe("");
    expect(busTitle("i2c0", buses)).toBe("I2C 0 bus");
    expect(busRole("i2c0", 21, buses)).toBe("SDA");
  });

  it("derives the use of a pin", () => {
    const cfg = (gpio: number, mode: string): PinConfigEntry => ({ gpio, mode, config: { gpio, mode }, source: "shadow", live: null });
    expect(pinUse(P6, undefined, {})).toEqual({ kind: "flash" });
    expect(pinUse(P4, undefined, {})).toEqual({ kind: "free" });
    expect(pinUse({ ...P4, owner: "gpio_4" }, cfg(4, "in"), {})).toEqual({ kind: "mode", mode: "in" });
    expect(pinUse({ ...P4, owner: "gpio_4" }, undefined, { gpio_4: { id: "gpio_4", mode: "in", gpio: 4, level: 1 } })).toEqual({ kind: "mode", mode: "in" });
    expect(pinUse({ ...P25, owner: "pwm_25" }, undefined, {})).toEqual({ kind: "mode", mode: "pwm" });
    expect(pinUse({ ...P4, owner: "mod_env0" }, undefined, {})).toEqual({ kind: "addon", id: "env0" });
    expect(pinUse({ ...P4, owner: "bus_vspi" }, undefined, {})).toEqual({ kind: "bus", id: "vspi" });
  });

  it("filters Used / Free and keeps flash pins in All only", () => {
    expect(matchesFilter({ kind: "flash" }, "all")).toBe(true);
    expect(matchesFilter({ kind: "flash" }, "used")).toBe(false);
    expect(matchesFilter({ kind: "flash" }, "free")).toBe(false);
    expect(matchesFilter({ kind: "addon", id: "x" }, "used")).toBe(true);
    expect(matchesFilter({ kind: "free" }, "used")).toBe(false);
    expect(matchesFilter({ kind: "free" }, "free")).toBe(true);
  });

  it("finds other PWM pins and rules that use a pin", () => {
    expect(otherPwmPins([P4, { ...P25, owner: "pwm_25" }, { ...P32, owner: "pwm_32" }], 32)).toEqual([25]);
    const rules: Rule[] = [
      { id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 2, value: 0 } },
      { id: "r5", enabled: true, on: { gpio: 5, op: "eq", value: 1 }, then: { gpio: 13, value: 1 } },
    ];
    expect(rulesUsing(rules, 4).map((r) => r.id)).toEqual(["r32"]);
    expect(rulesUsing(rules, 2).map((r) => r.id)).toEqual(["r32"]);
    expect(rulesUsing(rules, 13).map((r) => r.id)).toEqual(["r5"]);
    expect(rulesUsing(null, 4)).toEqual([]);
  });
});
