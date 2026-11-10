import { describe, expect, it } from "vitest";
import { countsText, defaultInclude, formatTaken, gapCountLabel, gapLabel, notIncluded, ruleText, stepSummaryText } from "./labels";

describe("gapLabel", () => {
  it("turns the fixed tokens into plain sentences", () => {
    expect(gapLabel("wifi")).toBe("Wi-Fi network and password are not included");
    expect(gapLabel("ap_password")).toBe("Setup AP password is not included");
    expect(gapLabel("mqtt_credentials")).toBe("MQTT username and password are not included");
    expect(gapLabel("modules_unavailable")).toBe("Add-ons could not be read from the device");
  });

  it("explains pin gaps with the GPIO number", () => {
    expect(gapLabel("pin:13:invert/pull")).toBe("GPIO 13: invert, pull-up and start level unknown");
    expect(gapLabel("pin:2:irq")).toBe("GPIO 2: irq unknown");
  });

  it("never shows a raw token for an unknown gap", () => {
    expect(gapLabel("something_new")).toBe("Something new");
  });

  it("counts gaps", () => {
    expect([0, 1, 3].map(gapCountLabel)).toEqual(["No gaps", "1 gap", "3 gaps"]);
  });
});

describe("countsText and formatTaken", () => {
  it("uses singular and plural", () => {
    expect(countsText({ pins: 7, modules: 2, rules: 2 })).toBe("7 pins · 2 add-ons · 2 rules");
    expect(countsText({ pins: 1, modules: 1, rules: 0 })).toBe("1 pin · 1 add-on · 0 rules");
  });

  it("writes today, yesterday and older dates", () => {
    const now = new Date(2026, 10, 10, 12, 0).getTime();
    expect(formatTaken(new Date(2026, 10, 10, 10, 5).toISOString(), now)).toBe("Today 10:05");
    expect(formatTaken(new Date(2026, 10, 9, 18, 22).toISOString(), now)).toBe("Yesterday 18:22");
    expect(formatTaken(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe("Nov 2");
    expect(formatTaken(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe("Dec 31, 2025");
    expect(formatTaken("nope", now)).toBe("Unknown");
  });
});

describe("include and rules", () => {
  it("copies the device name by default only when restoring", () => {
    expect(defaultInclude(false)).toEqual({ pins: true, modules: true, rules: true, mqtt: true, name: false });
    expect(defaultInclude(true)).toEqual({ pins: true, modules: true, rules: true, mqtt: true, name: false });
  });

  it("lists what is not copied", () => {
    expect(notIncluded({ pins: true, mqtt: false, name: false })).toBe("MQTT broker, device name");
    expect(notIncluded({ pins: false })).toBe("Pins");
    expect(notIncluded({})).toBe("");
  });

  it("describes a rule as a sentence", () => {
    expect(ruleText({ id: "r32", enabled: true, on: { gpio: 32, op: "gt", value: 1000 }, then: { gpio: 4, value: 1 }, else: { gpio: 4, value: 0 } })).toBe("When GPIO 32 > 1000 set GPIO 4 On, otherwise Off");
  });
});

describe("stepSummaryText", () => {
  it("words rule outputs as On/Off like the details view", () => {
    expect(stepSummaryText("Set rule r1: when GPIO 32 > 1000, set GPIO 4 to 1, otherwise 0")).toBe("Set rule r1: when GPIO 32 > 1000, set GPIO 4 On, otherwise Off");
    expect(stepSummaryText("Set rule r1: when GPIO 32 > 1000, set GPIO 4 to 1")).toBe("Set rule r1: when GPIO 32 > 1000, set GPIO 4 On");
    expect(stepSummaryText("Set GPIO 5 to output")).toBe("Set GPIO 5 to output");
  });
});
