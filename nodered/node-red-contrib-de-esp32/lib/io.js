"use strict";

function parseJson(raw) {
  if (raw == null) {
    return null;
  }
  if (typeof raw === "object" && !Buffer.isBuffer(raw) && !ArrayBuffer.isView(raw)) {
    return raw;
  }
  const s = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (!s) {
    return null;
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** WS and MQTT io frames are {topic, data}. Ignore non-io bus topics. */
function parseIoMessage(raw) {
  const msg = parseJson(raw);
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const topic = String(msg.topic || "");
  if (topic && topic.indexOf("io/") !== 0) {
    return null;
  }
  const data = msg.data && typeof msg.data === "object" ? msg.data : msg;
  if (typeof data.gpio !== "number") {
    return null;
  }
  const mode = data.mode || "";
  let value = null;
  if (mode === "adc" && typeof data.mv === "number") {
    value = data.mv;
  } else if (mode === "pwm" && typeof data.duty === "number") {
    value = data.duty;
  } else if (mode === "servo" && typeof data.angle === "number") {
    value = data.angle;
  } else if (typeof data.level === "number") {
    value = data.level;
  } else if (typeof data.duty === "number") {
    value = data.duty;
  } else if (typeof data.value === "number") {
    value = data.value;
  } else if (typeof data.mv === "number") {
    value = data.mv;
  }
  return {
    gpio: data.gpio,
    value,
    mode,
    id: data.id || "",
    topic: topic || "io/gpio",
    data,
  };
}

/** RFID and other module frames have an id and no gpio. */
function parseModuleEvent(raw) {
  const msg = parseJson(raw);
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const topic = String(msg.topic || "");
  if (topic.indexOf("io/") !== 0) {
    return null;
  }
  const data = msg.data && typeof msg.data === "object" ? msg.data : msg;
  if (!data.id || typeof data.gpio === "number") {
    return null;
  }
  return {
    id: String(data.id),
    present: !!data.present,
    uid: data.uid ? String(data.uid) : "",
    topic,
    data,
  };
}

module.exports = { parseJson, parseIoMessage, parseModuleEvent };
