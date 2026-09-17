"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { snapshot, withFallbackMeta } = require("../lib/devkitc-hardware");
const { pinByGpio, padAllowed } = require("../lib/pins");

describe("devkitc hardware snapshot", () => {
  it("matches DevKitC header and capability flags", () => {
    const hw = snapshot();
    assert.equal(hw.board_id, "esp32-devkitc");
    assert.equal(hw.header.left.length, 19);
    assert.equal(hw.header.right.length, 19);
    assert.equal(padAllowed(pinByGpio(hw, 32), "in"), true);
    assert.equal(padAllowed(pinByGpio(hw, 32), "adc"), true);
    assert.equal(padAllowed(pinByGpio(hw, 6), "in"), false);
    assert.equal(padAllowed(pinByGpio(hw, 4), "out"), true);
    assert.equal(padAllowed(pinByGpio(hw, 34), "out"), false);
  });
  it("annotates HTTP failure without dropping the map", () => {
    const hw = withFallbackMeta(new Error("device HTTP timed out"));
    assert.equal(hw.via, "devkitc-fallback");
    assert.match(hw.warning, /timed out/);
    assert.ok(pinByGpio(hw, 32));
  });
});
