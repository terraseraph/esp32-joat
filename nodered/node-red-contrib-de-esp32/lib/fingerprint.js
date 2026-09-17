"use strict";

function isOurs(status) {
  if (!status || typeof status !== "object") {
    return false;
  }
  const ota = status.ota || {};
  if (ota.project === "de_esp32_runtime") {
    return true;
  }
  const hn = String(status.hostname || "");
  if (hn.startsWith("esp32-")) {
    return true;
  }
  const chip = String(status.chip || "");
  const id = status.id;
  if (chip.startsWith("ESP32") && typeof id === "string" && id.length === 12) {
    return true;
  }
  return false;
}

function summarize(ip, status, via) {
  const mqtt = (status && status.mqtt) || {};
  const ota = (status && status.ota) || {};
  return {
    ip: ip || "",
    id: (status && status.id) || "",
    name: (status && status.name) || "",
    hostname: (status && status.hostname) || "",
    fw: (status && status.fw) || "",
    topic_id: (status && status.topic_id) || mqtt.topic_id || "",
    mqtt_prefix: mqtt.prefix || "",
    mqtt_root: mqtt.root || "devices",
    board: (status && status.board) || "",
    boot_state: (status && status.boot_state) || "",
    partition: ota.running_partition || "",
    via: via || "http",
  };
}

module.exports = { isOurs, summarize };
