"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isOurs, summarize } = require("../lib/fingerprint");

describe("fingerprint", () => {
  it("accepts ota.project", () => {
    assert.equal(isOurs({ ota: { project: "de_esp32_runtime" }, id: "aabbccddeeff" }), true);
  });
  it("accepts esp32- hostname", () => {
    assert.equal(isOurs({ hostname: "esp32-aabbcc" }), true);
  });
  it("accepts ESP32 chip + 12-char id", () => {
    assert.equal(isOurs({ chip: "ESP32 rev3", id: "aabbccddeeff" }), true);
  });
  it("rejects printers", () => {
    assert.equal(isOurs({ hostname: "office-printer" }), false);
    assert.equal(isOurs(null), false);
  });
  it("summarizes mqtt prefix", () => {
    const s = summarize("192.168.1.5", {
      id: "aabbccddeeff",
      name: "kitchen",
      hostname: "esp32-aabbcc",
      topic_id: "kitchen",
      mqtt: { prefix: "devices/kitchen", root: "devices" },
    });
    assert.equal(s.ip, "192.168.1.5");
    assert.equal(s.mqtt_prefix, "devices/kitchen");
    assert.equal(s.topic_id, "kitchen");
  });
});
