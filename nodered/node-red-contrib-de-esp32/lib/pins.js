"use strict";

function pinByGpio(hardware, gpio) {
  const pins = (hardware && hardware.pins) || [];
  const g = Number(gpio);
  for (let i = 0; i < pins.length; i++) {
    if (Number(pins[i].gpio) === g) {
      return pins[i];
    }
  }
  return null;
}

/** Use capability flags from GET /api/v1/hardware. Do not hardcode flash/input-only sets. */
function padAllowed(pin, mode) {
  if (!pin || pin.flash) {
    return false;
  }
  if (mode === "out") {
    return !!pin.output && !pin.input_only;
  }
  if (mode === "in") {
    return !!pin.input;
  }
  if (mode === "pwm") {
    return !!pin.pwm && !pin.input_only;
  }
  if (mode === "adc") {
    return !!pin.adc1;
  }
  return false;
}

function headerPads(hardware) {
  const header = (hardware && hardware.header) || {};
  return { left: header.left || [], right: header.right || [] };
}

/** Labels for the pinout badges. Same rules as the Hardware tab, from capability flags. */
function capBadges(p) {
  if (!p) {
    return [];
  }
  const a = [];
  if (p.flash) {
    a.push({ cls: "mute", text: "flash" });
  } else if (p.input_only) {
    a.push({ cls: "in", text: "in-only" });
  } else if (p.output) {
    a.push({ cls: "io", text: "io" });
  }
  if (p.adc1) {
    a.push({ cls: "adc", text: "A1" });
  } else if (p.adc2) {
    a.push({ cls: "warn", text: "A2" });
  }
  if (p.pwm && !p.flash) {
    a.push({ cls: "pwm", text: "PWM" });
  }
  if (p.touch) {
    a.push({ cls: "touch", text: "T" + (p.touch_channel >= 0 ? p.touch_channel : "") });
  }
  if (p.dac) {
    a.push({ cls: "dac", text: "DAC" });
  }
  if (p.strap) {
    a.push({ cls: "warn", text: "strap" });
  }
  if (p.role) {
    a.push({ cls: "role", text: p.role });
  }
  return a;
}

function allowedModes(p, family) {
  if (!p || p.flash) {
    return [];
  }
  const m = [];
  if (p.input) {
    m.push("in");
  }
  if (p.output && !p.input_only) {
    m.push("out");
    if (p.pwm) {
      m.push("pwm");
    }
  }
  if (p.adc1) {
    m.push("adc");
  }
  if (family === "in") {
    return m.filter((x) => x === "in" || x === "adc");
  }
  if (family === "out") {
    return m.filter((x) => x === "out" || x === "pwm");
  }
  return m;
}

module.exports = { pinByGpio, padAllowed, headerPads, capBadges, allowedModes };
