"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseTxt, looksLikeOursTxt, mergeDevice } = require("../lib/discover");

describe("mDNS TXT", () => {
  it("parses key=value buffers", () => {
    const txt = parseTxt([Buffer.from("id=aabbccddeeff"), Buffer.from("openapi=/api/v1/openapi.json")]);
    assert.equal(txt.id, "aabbccddeeff");
    assert.equal(looksLikeOursTxt(txt), true);
  });
  it("rejects empty txt", () => {
    assert.equal(looksLikeOursTxt(parseTxt([])), false);
  });
});

describe("mergeDevice", () => {
  it("absorbs topic-keyed MQTT rows into MAC id", () => {
    const map = new Map();
    mergeDevice(map, { topic_id: "kitchen", mqtt_prefix: "devices/kitchen", via: "mqtt" });
    mergeDevice(map, { id: "aabbccddeeff", topic_id: "kitchen", ip: "192.168.1.5", via: "http" });
    assert.equal(map.size, 1);
    const d = map.get("aabbccddeeff");
    assert.equal(d.ip, "192.168.1.5");
    assert.equal(d.via, "mqtt+http");
  });
  it("merges MQTT into an existing MAC row", () => {
    const map = new Map();
    mergeDevice(map, { id: "aabbccddeeff", topic_id: "kitchen", ip: "192.168.1.5", via: "http" });
    mergeDevice(map, { topic_id: "kitchen", availability: "online", via: "mqtt" });
    assert.equal(map.size, 1);
    assert.equal(map.get("aabbccddeeff").availability, "online");
  });
});
