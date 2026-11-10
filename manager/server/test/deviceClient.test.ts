import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, mock, test } from "node:test";
import {
  DeviceError,
  MAX_DEVICE_BODY,
  commandFor,
  createDeviceClient,
  createDevicePool,
  expectsRestart,
  timeoutFor,
  type DeviceClient,
} from "../src/device/client";
import { SerialQueue } from "../src/device/queue";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, sleep, waitUntil } from "./fake/testkit";
import { closedPort, startPlainServer } from "./helpers/net";

async function rejectsWith(p: Promise<unknown>, kind: DeviceError["kind"]): Promise<DeviceError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof DeviceError, `expected DeviceError, got ${String(e)}`);
    assert.equal(e.kind, kind, e.message);
    return e;
  }
  assert.fail(`expected a ${kind} error`);
}

describe("device client against the fake device", () => {
  let dev: FakeDevice;
  let client: DeviceClient;
  before(async () => {
    dev = await startFakeDevice({ ...FAST, seed: "demo", id: "aa11bb22cc33" });
    client = createDeviceClient({ host: `127.0.0.1:${dev.port}` });
  });
  after(async () => {
    client.destroy();
    await dev.close();
  });

  test("status, getJson, command envelope", async () => {
    const st = await client.status();
    assert.equal(st.id, "aa11bb22cc33");
    assert.equal(typeof (await client.getJson<{ gpio_4?: unknown }>("/pins")), "object");
    const env = await client.command({ cmd: "pin.set", gpio: 4, value: 1 });
    assert.equal(env.v, 1);
    assert.ok("ok" in env);
    const bad = await client.command({ cmd: "definitely.not.a.command" });
    assert.equal(bad.ok, false);
  });

  test("a closed port is `refused`", async () => {
    const c = createDeviceClient({ host: `127.0.0.1:${await closedPort()}` });
    const e = await rejectsWith(c.status(), "refused");
    assert.match(e.message, /refused/i);
    c.destroy();
  });

  test("an unreachable local bind address is `unreachable`, proving localAddress is applied", async () => {
    const c = createDeviceClient({ host: `127.0.0.1:${dev.port}`, localAddress: "203.0.113.77" });
    await rejectsWith(c.status(), "unreachable");
    // per call wins over the client default
    const ok = await c.status({ localAddress: "127.0.0.1" });
    assert.equal(ok.id, "aa11bb22cc33");
    c.destroy();
  });

  test("localAddress reaches http.request (per client and per call)", async () => {
    const spy = mock.method(http, "request");
    try {
      const c = createDeviceClient({ host: `127.0.0.1:${dev.port}`, localAddress: "127.0.0.1" });
      await c.status();
      await c.status({ localAddress: "127.0.0.1" });
      const plain = createDeviceClient({ host: `127.0.0.1:${dev.port}` });
      await plain.status();
      const opts = spy.mock.calls.map((call) => (call.arguments[0] as http.RequestOptions).localAddress);
      assert.deepEqual(opts, ["127.0.0.1", "127.0.0.1", undefined]);
      c.destroy();
      plain.destroy();
    } finally {
      spy.mock.restore();
    }
  });

  test("a hung device is a `timeout` after the per-call timeout", async () => {
    const hung = await startFakeDevice({ ...FAST, id: "bb22cc33dd44" });
    await hung.goOffline("hang");
    const c = createDeviceClient({ host: `127.0.0.1:${hung.port}` });
    const t0 = Date.now();
    const e = await rejectsWith(c.status({ timeoutMs: 250 }), "timeout");
    const took = Date.now() - t0;
    assert.ok(took >= 200 && took < 1500, `took ${took} ms`);
    assert.match(e.message, /did not answer/);
    c.destroy();
    await hung.close();
  });

  test("a redirect is `captive_redirect` with the Location, never followed", async () => {
    const e = await rejectsWith(client.request("GET", "/definitely-unknown"), "captive_redirect");
    assert.equal(e.location, "http://192.168.4.1/");
    assert.equal(e.status, 302);
    assert.match(e.message, /192\.168\.4\.1/);
  });

  test("bodies over 1536 bytes are refused locally and never sent", async () => {
    const before = dev.requestLog.length;
    const e = await rejectsWith(client.command({ cmd: "mqtt.configure", uri: "x".repeat(MAX_DEVICE_BODY) }), "body_too_large");
    assert.match(e.message, /1536/);
    await sleep(30);
    assert.equal(dev.requestLog.length, before, "the fake saw nothing");
    // exactly at the limit is sent: pad so the JSON is 1536 bytes
    const base = JSON.stringify({ cmd: "identity.set_name", name: "", pad: "" }).length;
    const exact = { cmd: "identity.set_name", name: "", pad: "x".repeat(MAX_DEVICE_BODY - base) };
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), MAX_DEVICE_BODY);
    await client.command(exact);
    assert.equal(dev.requestLog.length, before + 1);
  });

  test("the device's `400 json` text is a clear http_status error", async () => {
    const e = await rejectsWith(client.postJson("/command", []), "http_status");
    assert.equal(e.status, 400);
    assert.match(e.message, /invalid JSON/);
  });

  test("calls to one device run strictly one after another (queue) and report depth", async () => {
    const order: string[] = [];
    const scan = client.getJson("/network/scan").then(() => order.push("scan"));
    const stat = client.getJson("/status").then(() => order.push("status"));
    assert.equal(client.queueDepth, 2);
    await Promise.all([scan, stat]);
    assert.deepEqual(order, ["scan", "status"]);
    assert.equal(client.queueDepth, 0);
    const log = dev.requestLog.slice(-2).map((e) => e.path);
    assert.deepEqual(log, ["/api/v1/network/scan", "/api/v1/status"]);
  });

  test("expected restart: system.reboot's reset becomes ok + expectedRestart, then the device is back", async () => {
    const rebooter = await startFakeDevice({ ...FAST, id: "cc33dd44ee55" });
    const c = createDeviceClient({ host: `127.0.0.1:${rebooter.port}` });
    const res = await c.request("POST", "/command", { json: { cmd: "system.reboot", corr: "r1" } });
    assert.equal(res.expectedRestart, true);
    assert.deepEqual(res.json, { v: 1, ok: true, corr: "r1", result: { expectedRestart: true } });
    const back = (): Promise<void> => waitUntil(async () => (await c.status().catch(() => null))?.id === "cc33dd44ee55", 3000, "device back after reboot");
    await back();
    const res2 = await c.request("POST", "/system/reboot");
    assert.deepEqual(res2.json, { v: 1, ok: true, result: { expectedRestart: true } });
    await back();
    // a non-restart command must NOT be masked
    await rebooter.goOffline("refuse");
    // (a POST on the stale pooled socket reports a reset; a fresh connection would say refused)
    await assert.rejects(c.command({ cmd: "pin.set", gpio: 4, value: 1 }), (e) => e instanceof DeviceError && (e.kind === "refused" || e.kind === "reset"));
    c.destroy();
    await rebooter.close();
  });

  test("a connection reset is retried once for GETs but never for POSTs", async () => {
    let n = 0;
    const s = await startPlainServer((req, res) => {
      n++;
      if (n % 2 === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ n }));
    });
    const c = createDeviceClient({ host: s.host });
    assert.deepEqual(await c.getJson("/status"), { n: 2 }); // 1st attempt reset, retry answered
    n = 2; // next request is the odd one again
    await rejectsWith(c.postJson("/command", { cmd: "pin.set" }), "reset");
    c.destroy();
    await s.close();
  });
});

describe("pure helpers", () => {
  test("commandFor / timeoutFor / expectsRestart", () => {
    assert.equal(commandFor("POST", "/command", { cmd: "pin.set" }), "pin.set");
    assert.equal(commandFor("POST", "/pins", { gpio: 4, mode: "out" }), "pin.configure");
    assert.equal(commandFor("POST", "/pins", { cmd: "pin.set" }), "pin.set");
    assert.equal(commandFor("POST", "/network/wifi", { ssid: "x" }), "network.wifi.set");
    assert.equal(commandFor("POST", "/system/reboot/", undefined), "system.reboot");
    assert.equal(commandFor("GET", "/network/scan?x=1", undefined), "network.wifi.scan");
    assert.equal(commandFor("GET", "/status", undefined), undefined);

    assert.equal(timeoutFor(undefined, "/status"), 5000);
    assert.equal(timeoutFor("network.wifi.set", "/command"), 25_000);
    assert.equal(timeoutFor(undefined, "/network/wifi"), 25_000);
    assert.equal(timeoutFor("network.wifi.scan", "/command"), 12_000);
    assert.equal(timeoutFor(undefined, "/network/scan"), 12_000);

    assert.equal(expectsRestart("POST", "/command", "system.reboot"), true);
    assert.equal(expectsRestart("POST", "/command", "system.factory_reset"), true);
    assert.equal(expectsRestart("POST", "/command", "ota.rollback"), true);
    assert.equal(expectsRestart("POST", "/system/reboot", undefined), true);
    assert.equal(expectsRestart("POST", "/system/factory_reset", undefined), true);
    assert.equal(expectsRestart("POST", "/command", "pin.set"), false);
    assert.equal(expectsRestart("GET", "/system/reboot", undefined), false);
  });

  test("SerialQueue runs tasks one at a time in order, survives failures, reports depth", async () => {
    const depths: number[] = [];
    const q = new SerialQueue((d) => depths.push(d));
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string, ms: number, fail = false) => async (): Promise<string> => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await sleep(ms);
      running--;
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([q.run(task("a", 40)), q.run(task("b", 5, true)), q.run(task("c", 5))]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected", "fulfilled"],
    );
    assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
    assert.equal(maxRunning, 1);
    assert.equal(q.depth, 0);
    assert.deepEqual(depths, [1, 2, 3, 2, 1, 0]);
  });

  test("pool: one client per device, host change re-points it, drop closes it", async () => {
    const seen: Array<[string, number]> = [];
    const pool = createDevicePool({ onQueueChange: (id, d) => seen.push([id, d]) });
    const a = pool.forDevice("a", "127.0.0.1:1");
    assert.equal(pool.forDevice("a", "127.0.0.1:1"), a);
    assert.equal(pool.forDevice("a", "127.0.0.1:2"), a);
    assert.equal(a.host, "127.0.0.1:2");
    assert.equal(pool.depth("a"), 0);
    assert.equal(pool.depth("zzz"), 0);
    await a.status().catch(() => undefined);
    assert.deepEqual(seen.slice(0, 1), [["a", 1]]);
    pool.drop("a");
    assert.notEqual(pool.forDevice("a", "127.0.0.1:2"), a);
    pool.destroy();
  });
});
