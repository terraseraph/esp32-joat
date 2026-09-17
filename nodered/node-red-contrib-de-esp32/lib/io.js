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
  let value = null;
  if (typeof data.level === "number") {
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
    mode: data.mode || "",
    id: data.id || "",
    topic: topic || "io/gpio",
    data,
  };
}

module.exports = { parseJson, parseIoMessage };
