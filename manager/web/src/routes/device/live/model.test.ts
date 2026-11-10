import type { LiveIoMap } from "@shared/api";
import type { ModuleInstance, Rule } from "@shared/device-api";
import { describe, expect, it } from "vitest";
import { adoptedState, buildTiles, dutyToPercent, formatVolts, mvFraction, mvToVolts, percentToDuty, pinSetBody, ruleHints } from "./model";

const io: LiveIoMap = {
  gpio_4: { id: "gpio_4", mode: "out", gpio: 4, level: 0 },
  gpio_2: { id: "gpio_2", mode: "out", gpio: 2, level: 1 },
  gpio_13: { id: "gpio_13", mode: "in", gpio: 13, level: 1, debounce_ms: 50 },
  adc_34: { id: "adc_34", mode: "adc", gpio: 34, mv: 1650, raw: 2048, sample_ms: 50, hysteresis_mv: 20, smooth: 70 },
  pwm_25: { id: "pwm_25", mode: "pwm", gpio: 25, hz: 5000, duty: 350 },
  servo_26: { id: "servo_26", mode: "servo", gpio: 26, angle: 90, pulse_us: 1500, min_us: 500, max_us: 2500, hz: 50 },
  mod_env0: { id: "env0", type: "bme280", ok: true, addr: 0x76, t_c: 23.4, p_hpa: 1009.2, rh: 46.5 },
  mod_rfid0: { id: "rfid0", type: "mfrc522", present: false, uid: "", version: 0x92, tx: 3 },
};
const rules: Rule[] = [
  { id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } },
  { id: "r13", enabled: true, on: { gpio: 13, op: "eq", value: 1 }, then: { gpio: 25, value: 350 } },
  { id: "off", enabled: false, on: { gpio: 34, op: "gt", value: 1 }, then: { gpio: 2, value: 1 } },
];
const modules: ModuleInstance[] = [{ id: "env0", type: "bme280", bus: "i2c0", enabled: true, pins: { sda: 21, scl: 22 } }];

describe("conversions", () => {
  it("maps duty to percent and back", () => {
    expect(dutyToPercent(350)).toBe(35);
    expect(dutyToPercent(1000)).toBe(100);
    expect(dutyToPercent(-5)).toBe(0);
    expect(percentToDuty(35)).toBe(350);
    expect(percentToDuty(100)).toBe(1000);
    expect(percentToDuty(250)).toBe(1000);
  });
  it("maps millivolts to volts and a 0-3.3 V bar", () => {
    expect(mvToVolts(1650)).toBe(1.65);
    expect(formatVolts(0.98)).toBe("0.98");
    expect(mvFraction(1650)).toBeCloseTo(0.5);
    expect(mvFraction(5000)).toBe(1);
    expect(mvFraction(-3)).toBe(0);
  });
});

describe("ruleHints", () => {
  it("collects drivers and triggers of enabled rules only", () => {
    const h = ruleHints(rules);
    expect(h.get(4)?.drivenBy).toEqual([{ rule: "r32", source: 32 }]);
    expect(h.get(25)?.drivenBy).toEqual([{ rule: "r13", source: 13 }]);
    expect(h.get(13)?.triggers).toEqual(["r13"]);
    expect(h.has(2)).toBe(false);
    expect(h.has(34)).toBe(false);
  });
});

describe("buildTiles", () => {
  const groups = buildTiles(io, rules, modules);
  it("groups and orders channels", () => {
    expect(groups.map((g) => g.id)).toEqual(["out", "in", "adc", "pwm", "servo", "addon"]);
    expect(groups[0]?.tiles.map((t) => t.key)).toEqual(["gpio_2", "gpio_4"]);
    expect(groups[5]?.tiles.map((t) => t.key)).toEqual(["mod_env0", "mod_rfid0"]);
  });
  it("adds rule hints and converted values", () => {
    expect(groups[0]?.tiles[1]).toMatchObject({ kind: "out", level: 0, drivenBy: "Driven by rule r32 (GPIO 32)" });
    expect(groups[1]?.tiles[0]).toMatchObject({ kind: "in", level: 1, debounceMs: 50, triggers: "Triggers rule r13" });
    expect(groups[2]?.tiles[0]).toMatchObject({ kind: "adc", volts: 1.65, raw: 2048, fraction: 0.5 });
    expect(groups[3]?.tiles[0]).toMatchObject({ kind: "pwm", percent: 35, hz: 5000, drivenBy: "Driven by rule r13 (GPIO 13)" });
    expect(groups[4]?.tiles[0]).toMatchObject({ kind: "servo", angle: 90, pulseUs: 1500 });
  });
  it("labels add-ons and takes wiring from the add-on list", () => {
    expect(groups[5]?.tiles[0]).toMatchObject({ kind: "bme280", title: "env0 · BME280", ok: true, tempC: 23.4, humidity: 46.5, pressureHpa: 1009.2, wiring: "I²C 0 · SDA 21 · SCL 22" });
    expect(groups[5]?.tiles[1]).toMatchObject({ kind: "mfrc522", title: "rfid0 · RC522", present: false, uid: "" });
  });
  it("drops readings of a BME280 that is not ok and ignores unknown shapes", () => {
    const g = buildTiles({ mod_env0: { id: "env0", type: "bme280", ok: false, addr: 0x76, t_c: 1 }, junk: { id: "x" } as never });
    expect(g).toHaveLength(1);
    expect(g[0]?.tiles[0]).toMatchObject({ ok: false, tempC: null });
  });
  it("is empty for an empty map", () => {
    expect(buildTiles({})).toEqual([]);
  });
});

describe("pin.set", () => {
  it("builds minimal bodies", () => {
    expect(pinSetBody("out", 4, 1)).toEqual({ cmd: "pin.set", gpio: 4, value: 1 });
    expect(pinSetBody("pwm", 25, 500)).toEqual({ cmd: "pin.set", gpio: 25, mode: "pwm", value: 500 });
    expect(pinSetBody("servo", 26, 45)).toEqual({ cmd: "pin.set", gpio: 26, mode: "servo", value: 45 });
  });
  it("adopts the value the device accepted", () => {
    expect(adoptedState(io.gpio_4!, 1)).toMatchObject({ level: 1 });
    expect(adoptedState(io.pwm_25!, 800)).toMatchObject({ duty: 800 });
    expect(adoptedState(io.servo_26!, 180)).toMatchObject({ angle: 180, pulse_us: 2500 });
    expect(adoptedState(io.mod_env0!, 1)).toBe(io.mod_env0);
  });
});
