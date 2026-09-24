"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseIoMessage, parseModuleEvent } = require("../lib/io");
const { toLevel } = require("../lib/level");

describe("parseIoMessage", () => {
  it("reads WS wrap {topic,data}", () => {
    const ev = parseIoMessage({ topic: "io/gpio", data: { gpio: 4, level: 1, mode: "out", id: "gpio_4" } });
    assert.equal(ev.gpio, 4);
    assert.equal(ev.value, 1);
    assert.equal(ev.mode, "out");
  });
  it("reads ADC millivolts from mode=adc even if other numeric fields exist", () => {
    const ev = parseIoMessage({
      topic: "io/adc",
      data: { gpio: 32, mode: "adc", mv: 1774, raw: 2000, id: "adc_32" },
    });
    assert.equal(ev.value, 1774);
    assert.equal(ev.mode, "adc");
  });
  it("reads servo angle", () => {
    const ev = parseIoMessage({
      topic: "io/servo",
      data: { gpio: 4, mode: "servo", angle: 90, pulse_us: 1500, id: "servo_4" },
    });
    assert.equal(ev.value, 90);
    assert.equal(ev.mode, "servo");
  });
  it("ignores telemetry frames", () => {
    assert.equal(parseIoMessage({ topic: "telemetry", data: { heap_free: 1 } }), null);
  });
  it("reads RFID frames without a gpio", () => {
    const ev = parseModuleEvent({ topic: "io/rfid", data: { id: "rfid0", present: true, uid: "AB" } });
    assert.equal(ev.id, "rfid0");
    assert.equal(ev.present, true);
    assert.equal(ev.uid, "AB");
    assert.equal(parseModuleEvent({ topic: "io/gpio", data: { gpio: 4, level: 1, id: "gpio_4" } }), null);
    assert.equal(parseIoMessage({ topic: "io/rfid", data: { id: "rfid0", present: true, uid: "AB" } }), null);
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
