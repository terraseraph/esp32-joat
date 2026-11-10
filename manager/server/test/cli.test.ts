import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP, parseCli } from "../src/cli";
import { devServerArgs } from "../../scripts/devArgs.mjs";

test("parseCli: --no-network-scan and --wifi-adapter", () => {
  const d = parseCli(["--data-dir", "x"]);
  assert.equal(d.networkScan, true, "scanning is on by default");
  assert.equal(d.wifiAdapter, "system");
  const off = parseCli(["--no-network-scan", "--wifi-adapter", "fake"]);
  assert.equal(off.networkScan, false);
  assert.equal(off.wifiAdapter, "fake");
  assert.equal(parseCli(["--wifi-adapter=none"]).wifiAdapter, "none");
  assert.equal(parseCli(["--wifi-adapter", "system"]).wifiAdapter, "system");
  assert.throws(() => parseCli(["--wifi-adapter", "bluetooth"]), /Invalid --wifi-adapter: bluetooth \(use fake, system or none\)/);
  assert.throws(() => parseCli(["--wifi-adapter"]));
  assert.match(HELP, /--no-network-scan/);
  assert.match(HELP, /--wifi-adapter/);
});

test("npm run dev: extra args pass through; the dev server defaults to no scanning and the fake Wi-Fi adapter", () => {
  const base = ["--no-open", "--data-dir", ".data/dev", "--allow-origin", "http://localhost:5173"];
  assert.deepEqual(devServerArgs([]), [...base, "--no-network-scan", "--wifi-adapter", "fake"]);
  assert.deepEqual(devServerArgs(["--port", "5290"]), [...base, "--no-network-scan", "--wifi-adapter", "fake", "--port", "5290"]);
  assert.deepEqual(devServerArgs(["--network-scan"]), [...base, "--wifi-adapter", "fake"], "--network-scan opts back in (and is not passed on)");
  assert.deepEqual(devServerArgs(["--wifi-adapter", "system"]), [...base, "--no-network-scan", "--wifi-adapter", "system"]);
  assert.deepEqual(devServerArgs(["--wifi-adapter=none"]), [...base, "--no-network-scan", "--wifi-adapter=none"]);
  assert.deepEqual(devServerArgs(["--no-network-scan"]), [...base, "--wifi-adapter", "fake", "--no-network-scan"], "no duplicate flag");
});

test("parseCli: --lan and --host decide the initial LAN mode; the help says what they do", () => {
  assert.equal(parseCli(["--data-dir", "x"]).lan, false);
  assert.equal(parseCli(["--lan", "--data-dir", "x"]).host, "0.0.0.0");
  assert.equal(parseCli(["--host", "192.168.1.20", "--data-dir", "x"]).lan, true, "a fixed non-loopback --host implies LAN mode");
  assert.equal(parseCli(["--host", "127.0.0.1", "--data-dir", "x"]).lan, false);
  assert.match(HELP, /cannot be switched from Settings/);
});
