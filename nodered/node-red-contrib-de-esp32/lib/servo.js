"use strict";

function clampInt(n, lo, hi, fallback) {
  if (n == null || n === "") {
    return fallback;
  }
  const v = Number(n);
  if (!Number.isFinite(v)) {
    return fallback;
  }
  return Math.round(Math.min(hi, Math.max(lo, v)));
}

/** Angle 0–180 from a payload, or from {value} / {angle}. */
function toAngle(payload) {
  let raw = payload;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !Buffer.isBuffer(raw)) {
    if (Object.prototype.hasOwnProperty.call(raw, "value")) {
      raw = raw.value;
    } else if (Object.prototype.hasOwnProperty.call(raw, "angle")) {
      raw = raw.angle;
    }
  }
  if (raw == null || raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(Math.min(180, Math.max(0, value)));
}

/** pin.configure body. Pulse window matches firmware clamps. */
function servoPin(n, gpio) {
  let minUs = clampInt(n.minUs, 500, 1500, 500);
  let maxUs = clampInt(n.maxUs, 1500, 2500, 2500);
  if (maxUs <= minUs) {
    minUs = 500;
    maxUs = 2500;
  }
  return {
    gpio,
    mode: "servo",
    name: n.pinName || `servo_${gpio}`,
    angle: clampInt(n.angle, 0, 180, 90),
    min_us: minUs,
    max_us: maxUs,
  };
}

module.exports = { toAngle, servoPin };
