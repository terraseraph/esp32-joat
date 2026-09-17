"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { pinByGpio, padAllowed, capBadges, allowedModes } = require("../lib/pins");

const hardware = {
  header: {
    left: [{ silk: "3V3", gpio: null, kind: "power" }, { silk: "32", gpio: 32, kind: "gpio" }],
    right: [{ silk: "4", gpio: 4, kind: "gpio" }, { silk: "CLK", gpio: 6, kind: "gpio" }],
  },
  pins: [
    { gpio: 4, output: true, input: true, pwm: true, flash: false, input_only: false, pull: true },
    { gpio: 6, output: true, input: true, pwm: false, flash: true, input_only: false },
    { gpio: 32, output: false, input: true, pwm: false, adc1: true, flash: false, input_only: true },
    { gpio: 34, output: false, input: true, pwm: false, adc1: true, flash: false, input_only: true },
  ],
};

describe("pins from hardware flags", () => {
  it("finds by gpio including 0-equivalent lookups", () => {
    assert.equal(pinByGpio(hardware, 4).pwm, true);
    assert.equal(pinByGpio(hardware, 99), null);
  });
  it("blocks flash for out and in", () => {
    const p = pinByGpio(hardware, 6);
    assert.equal(padAllowed(p, "out"), false);
    assert.equal(padAllowed(p, "in"), false);
  });
  it("blocks input-only for out, allows in", () => {
    const p = pinByGpio(hardware, 34);
    assert.equal(padAllowed(p, "out"), false);
    assert.equal(padAllowed(p, "in"), true);
  });
  it("allows GPIO4 out", () => {
    assert.equal(padAllowed(pinByGpio(hardware, 4), "out"), true);
  });
  it("does not invent a hardcoded flash set — missing pin is denied", () => {
    assert.equal(padAllowed(null, "out"), false);
  });
});

describe("capBadges", () => {
  it("labels io, PWM, and ADC from flags", () => {
    const texts = capBadges(pinByGpio(hardware, 4)).map((b) => b.text);
    assert.deepEqual(texts.includes("io"), true);
    assert.deepEqual(texts.includes("PWM"), true);
    const a1 = capBadges(pinByGpio(hardware, 32)).map((b) => b.text);
    assert.equal(a1.includes("A1"), true);
    assert.equal(a1.includes("in-only"), true);
  });
});

describe("allowedModes", () => {
  it("limits gpio-in to in/adc and gpio-out to out/pwm", () => {
    assert.deepEqual(allowedModes(pinByGpio(hardware, 4), "out"), ["out", "pwm"]);
    assert.deepEqual(allowedModes(pinByGpio(hardware, 4), "in"), ["in"]);
    assert.deepEqual(allowedModes(pinByGpio(hardware, 32), "in"), ["in", "adc"]);
    assert.deepEqual(allowedModes(pinByGpio(hardware, 32), "out"), []);
  });
});
