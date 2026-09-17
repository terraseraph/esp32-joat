"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseIoMessage } = require("../lib/io");
const { toLevel } = require("../lib/level");

describe("parseIoMessage", () => {
  it("reads WS wrap {topic,data}", () => {
    const ev = parseIoMessage({ topic: "io/gpio", data: { gpio: 4, level: 1, mode: "out", id: "gpio_4" } });
    assert.equal(ev.gpio, 4);
    assert.equal(ev.value, 1);
    assert.equal(ev.mode, "out");
  });
  it("ignores telemetry frames", () => {
    assert.equal(parseIoMessage({ topic: "telemetry", data: { heap_free: 1 } }), null);
  });
  it("accepts Buffer JSON", () => {
    const ev = parseIoMessage(Buffer.from('{"topic":"io/gpio","data":{"gpio":0,"level":0}}'));
    assert.equal(ev.gpio, 0);
    assert.equal(ev.value, 0);
  });
});

describe("toLevel", () => {
  it("maps common payloads", () => {
    assert.equal(toLevel(true), 1);
    assert.equal(toLevel("off"), 0);
    assert.equal(toLevel(0), 0);
    assert.equal(toLevel({ value: 1 }), 1);
  });
  it("rejects junk", () => {
    assert.equal(toLevel("maybe"), null);
    assert.equal(toLevel(null), null);
  });
});
