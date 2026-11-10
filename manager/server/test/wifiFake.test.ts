import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeWifiAdapter, createNoneAdapter, parseFakeAp, WifiError } from "../src/wifi";

const kind = (k: string) => (e: unknown): boolean => e instanceof WifiError && e.kind === k;

describe("fake Wi-Fi adapter", () => {
  const open = { ssid: "esp32-a1b2c3", host: "127.0.0.1:8211", lanHost: "127.0.0.1:8212" };
  const locked = { ssid: "esp32-d4e5f6", host: "127.0.0.1:8213", password: "ap-password-1" };

  test("starts on the home network; scan lists the access points (secured follows the password) and the home network", async () => {
    const a = createFakeWifiAdapter({ aps: [open, locked] });
    assert.deepEqual(await a.current(), { ssid: "HomeNet", profile: "HomeNet" });
    assert.deepEqual(await a.scan(), [
      { ssid: "esp32-a1b2c3", secured: false, signal: 70 },
      { ssid: "esp32-d4e5f6", secured: true, signal: 70 },
      { ssid: "HomeNet", secured: true, signal: 80 },
    ]);
    assert.deepEqual(await a.info(), { supported: true, reason: null, interfaceName: "Simulated Wi-Fi" });
  });

  test("joining an access point moves endpoint() there and back; deleting the profile drops the connection", async () => {
    const a = createFakeWifiAdapter({ aps: [open] });
    assert.deepEqual(await a.endpoint("192.168.4.1"), { host: "127.0.0.1:1" }, "off an AP nothing real is contacted");
    await a.addTempProfile(open.ssid, undefined, "de-esp32-setup-1");
    await a.connect("de-esp32-setup-1", open.ssid);
    assert.deepEqual(await a.endpoint("192.168.4.1"), { host: open.host });
    assert.deepEqual(a.lanTargets(open.ssid), [open.lanHost]);
    assert.deepEqual(a.lanTargets("esp32-ffffff"), []);
    await a.connect("HomeNet", "HomeNet");
    assert.equal(a.connection.ssid, "HomeNet");
    await a.deleteProfile("de-esp32-setup-1");
    assert.deepEqual(a.profileNames(), ["HomeNet"]);
    await a.deleteProfile("does-not-exist");
  });

  test("wrong or missing AP password: auth error; the right one joins; calls never record the password", async () => {
    const a = createFakeWifiAdapter({ aps: [locked] });
    await a.addTempProfile(locked.ssid, undefined, "p-open");
    await assert.rejects(a.connect("p-open", locked.ssid), kind("auth"));
    await a.addTempProfile(locked.ssid, "wrong-password", "p-wrong");
    await assert.rejects(a.connect("p-wrong", locked.ssid), kind("auth"));
    await a.addTempProfile(locked.ssid, "ap-password-1", "p-good");
    await a.connect("p-good", locked.ssid);
    assert.equal(a.connection.ssid, locked.ssid);
    assert.ok(!JSON.stringify(a.calls).includes("ap-password-1"));
    assert.ok(!JSON.stringify(a.calls).includes("wrong-password"));
  });

  test("connecting to a missing profile fails", async () => {
    await assert.rejects(createFakeWifiAdapter({ aps: [open] }).connect("nope", open.ssid), kind("failed"));
  });

  test("faults: unsupported, connectFails, apDisappears, rejoinFails, addProfileFails, scanFails (changeable at any time)", async () => {
    const a = createFakeWifiAdapter({ aps: [open] });
    a.faults.unsupported = "No adapter here";
    assert.deepEqual(await a.info(), { supported: false, reason: "No adapter here", interfaceName: null });
    delete a.faults.unsupported;

    await a.addTempProfile(open.ssid, undefined, "p");
    a.faults.connectFails = true;
    await assert.rejects(a.connect("p", open.ssid), kind("timeout"));
    a.faults.connectFails = false;

    a.faults.apDisappears = true;
    assert.deepEqual((await a.scan()).map((n) => n.ssid), ["HomeNet"]);
    await assert.rejects(a.connect("p", open.ssid), kind("not_found"));
    a.faults.apDisappears = false;

    await a.connect("p", open.ssid);
    a.faults.rejoinFails = true;
    await assert.rejects(a.connect("HomeNet", "HomeNet"), kind("timeout"));
    a.faults.rejoinFails = false;
    await a.connect("HomeNet", "HomeNet");

    a.faults.addProfileFails = true;
    await assert.rejects(a.addTempProfile(open.ssid, undefined, "q"), kind("failed"));
    a.faults.scanFails = true;
    await assert.rejects(a.scan(), kind("failed"));
  });

  test("an aborted connect stops with `aborted`", async () => {
    const a = createFakeWifiAdapter({ aps: [open], connectDelayMs: 5000 });
    await a.addTempProfile(open.ssid, undefined, "p");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(a.connect("p", open.ssid, { signal: ac.signal }), kind("aborted"));
  });

  test("a PC that starts without Wi-Fi", async () => {
    const a = createFakeWifiAdapter({ aps: [open], currentSsid: null });
    assert.deepEqual(await a.current(), { ssid: null, profile: null });
  });
});

describe("--fake-ap parsing", () => {
  test("ssid=host:port with options", () => {
    assert.deepEqual(parseFakeAp("esp32-a1b2c3=127.0.0.1:8211"), { ssid: "esp32-a1b2c3", host: "127.0.0.1:8211" });
    assert.deepEqual(parseFakeAp("esp32-a1b2c3=127.0.0.1:8211,secured=password123,lan=127.0.0.1:8212"), {
      ssid: "esp32-a1b2c3",
      host: "127.0.0.1:8211",
      password: "password123",
      secured: true,
      lanHost: "127.0.0.1:8212",
    });
  });
  test("bad values are explained in plain words", () => {
    for (const [bad, re] of [
      ["esp32-a1b2c3", /use <ssid>=<host:port>/],
      ["HomeNet=127.0.0.1:1", /esp32-<6 hex/],
      ["esp32-a1b2c3=localhost", /not host:port/],
      ["esp32-a1b2c3=127.0.0.1:1,secured=short", /8 to 63/],
      ["esp32-a1b2c3=127.0.0.1:1,lan=nope", /not host:port/],
      ["esp32-a1b2c3=127.0.0.1:1,color=red", /unknown option "color"/],
    ] as const) {
      assert.throws(() => parseFakeAp(bad), re);
    }
  });
});

describe("none adapter", () => {
  test("says why, scans nothing, refuses to change anything", async () => {
    const a = createNoneAdapter("Not here");
    assert.deepEqual(await a.info(), { supported: false, reason: "Not here", interfaceName: null });
    assert.deepEqual(await a.scan(), []);
    assert.deepEqual(await a.current(), { ssid: null, profile: null });
    await assert.rejects(a.addTempProfile("esp32-a1b2c3", undefined, "p"), kind("unsupported"));
    await assert.rejects(a.connect("p", "s"), kind("unsupported"));
    await assert.rejects(a.endpoint("192.168.4.1"), kind("unsupported"));
  });
});
