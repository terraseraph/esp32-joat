import assert from "node:assert/strict";
import { test } from "node:test";
import * as devkitc from "node-red-contrib-de-esp32/lib/devkitc-hardware";
import * as discover from "node-red-contrib-de-esp32/lib/discover";
import { isOurs, summarize } from "node-red-contrib-de-esp32/lib/fingerprint";
import * as pins from "node-red-contrib-de-esp32/lib/pins";

// Proves the shared Node-RED lib resolves (extensionless subpaths) under tsx. scripts/bundle.mjs
// does the same through esbuild; `npm run build` would fail if that stopped working.

test("fingerprint.isOurs / summarize", () => {
  const status = { id: "a4cf12b3c4d5", hostname: "esp32-b3c4d5", chip: "ESP32-D0WDQ6", name: "Workshop node", ota: { project: "de_esp32_runtime", running_partition: "ota_0" } };
  assert.equal(isOurs(status), true);
  assert.equal(isOurs({ hostname: "printer" }), false);
  assert.equal(isOurs(null), false);
  const s = summarize("192.168.1.42", status, "http");
  assert.equal(s.id, "a4cf12b3c4d5");
  assert.equal(s.partition, "ota_0");
  assert.equal(s.ip, "192.168.1.42");
});

test("discover.parseTxt / looksLikeOursTxt", () => {
  const txt = discover.parseTxt([Buffer.from("id=a4cf12b3c4d5"), "board=esp32-devkitc"]);
  assert.deepEqual(txt, { id: "a4cf12b3c4d5", board: "esp32-devkitc" });
  assert.equal(discover.looksLikeOursTxt(txt), true);
  assert.equal(discover.looksLikeOursTxt({ id: "x" }), false);
});

test("pins and devkitc-hardware", () => {
  const hw = devkitc.snapshot();
  assert.equal(hw.board_id, "esp32-devkitc");
  const p21 = pins.pinByGpio(hw, 21);
  assert.equal(p21?.role, "I2C SDA");
  assert.equal(pins.padAllowed(pins.pinByGpio(hw, 6), "out"), false); // flash pin
  assert.equal(pins.ownerLabel("mod_rfid0"), "RFID rfid0");
  assert.ok(pins.allowedModes(p21).includes("pwm"));
});

test("the bundler can resolve multicast-dns (used lazily by the shared lib)", async () => {
  const mod = await import("multicast-dns");
  assert.equal(typeof (mod.default ?? mod), "function");
});
