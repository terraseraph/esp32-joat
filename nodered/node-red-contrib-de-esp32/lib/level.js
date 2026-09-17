"use strict";

function toLevel(payload) {
  if (payload === true || payload === "on" || payload === "ON" || payload === "true") {
    return 1;
  }
  if (payload === false || payload === "off" || payload === "OFF" || payload === "false") {
    return 0;
  }
  if (typeof payload === "number") {
    return payload ? 1 : 0;
  }
  if (typeof payload === "string" && payload.trim() !== "" && Number.isFinite(Number(payload))) {
    return Number(payload) ? 1 : 0;
  }
  if (payload && typeof payload === "object") {
    if (Object.prototype.hasOwnProperty.call(payload, "payload")) {
      return toLevel(payload.payload);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "value")) {
      return toLevel(payload.value);
    }
  }
  return null;
}

module.exports = { toLevel };
