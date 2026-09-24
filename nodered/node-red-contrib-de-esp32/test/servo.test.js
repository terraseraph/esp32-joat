"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { toAngle, servoPin } = require("../lib/servo");

describe("toAngle", () => {
  it("clamps numbers and object payloads", () => {
    assert.equal(toAngle(45), 45);
    assert.equal(toAngle(200), 180);
    assert.equal(toAngle(-3), 0);
    assert.equal(toAngle({ angle: 10 }), 10);
    assert.equal(toAngle({ value: 20 }), 20);
  });
  it("rejects junk", () => {
    assert.equal(toAngle("left"), null);
    assert.equal(toAngle(null), null);
  });
});

describe("servoPin", () => {
  it("builds a configure body with firmware pulse limits", () => {
    assert.deepEqual(servoPin({ angle: 30, minUs: 800, maxUs: 2200, pinName: "door" }, 4), {
      gpio: 4,
      mode: "servo",
      name: "door",
      angle: 30,
      min_us: 800,
      max_us: 2200,
    });
  });
  it("uses 500–2500 when the window is left blank", () => {
    const pin = servoPin({}, 4);
    assert.equal(pin.min_us, 500);
    assert.equal(pin.max_us, 2500);
    assert.equal(pin.angle, 90);
  });
  it("resets an inverted pulse window", () => {
    const pin = servoPin({ minUs: 1500, maxUs: 1500 }, 18);
    assert.equal(pin.min_us, 500);
    assert.equal(pin.max_us, 2500);
    assert.equal(pin.angle, 90);
    assert.equal(pin.name, "servo_18");
  });
});
