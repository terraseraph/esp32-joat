import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceStatus, OtaApplyResult, OtaStatus } from "../src/types/device-api";
import { rawRequest } from "./helpers";
import { makeFakeImage, startFakeDevice, type FakeDevice, type FakeDeviceOptions } from "./fake/fakeDevice";
import { FAST, WsClient, cmd, failsWith, get, result, sleep, statusOf, waitUntil } from "./fake/testkit";

async function withDevice(opts: FakeDeviceOptions, fn: (dev: FakeDevice) => Promise<void>): Promise<void> {
  const dev = await startFakeDevice({ ...FAST, ...opts });
  try {
    await fn(dev);
  } finally {
    await dev.close();
  }
}

const postRaw = (dev: FakeDevice, path: string, body?: string) =>
  rawRequest(dev.url, { method: "POST", path: `/api/v1${path}`, headers: { "Content-Type": "application/json" }, body });

async function upload(dev: FakeDevice, image: Buffer): Promise<{ ok: boolean; result?: OtaStatus; error?: string }> {
  const r = await fetch(`${dev.url}/api/v1/ota`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(image) });
  return (await r.json()) as { ok: boolean; result?: OtaStatus; error?: string };
}

/** Wait until the device answers /status again, then return it. */
async function backOnline(dev: FakeDevice, minBootCount: number): Promise<DeviceStatus> {
  await waitUntil(async () => (await statusOf(dev)).boot_count >= minBootCount, 4000, "device back online");
  return statusOf(dev);
}

describe("availability: refuse, hang, online", () => {
  it("goOffline('refuse') refuses connections and keeps state; goOnline() re-listens on the same port", async () => {
    await withDevice({ seed: "demo", name: "Keeper" }, async (dev) => {
      const port = dev.port;
      await dev.goOffline("refuse");
      assert.equal(dev.availability, "refuse");
      await assert.rejects(fetch(`${dev.url}/api/v1/status`), (e: Error) => /fetch failed/.test(e.message));
      await assert.rejects(rawRequest(dev.url, { path: "/api/v1/status" }), /ECONNREFUSED/);
      await dev.goOnline();
      assert.equal(dev.port, port);
      const s = await statusOf(dev);
      assert.equal(s.name, "Keeper");
      assert.equal(s.boot_count, 1, "going offline is not a reboot");
      assert.ok(Object.keys(s.io).length > 0);
    });
  });

  it("goOffline('hang') accepts connections but never answers", async () => {
    await withDevice({}, async (dev) => {
      await dev.goOffline("hang");
      assert.equal(dev.availability, "hang");
      await assert.rejects(fetch(`${dev.url}/api/v1/status`, { signal: AbortSignal.timeout(250) }));
      await dev.goOnline();
      assert.equal((await get(dev, "/status")).status, 200);
    });
  });

  it("offline drops WebSocket clients; hang leaves them open but silent", async () => {
    await withDevice({}, async (dev) => {
      const a = await WsClient.connect(dev);
      await dev.goOffline("hang");
      dev.emit("telemetry", {});
      await sleep(80);
      assert.equal(a.events.length, 0);
      assert.equal(a.closed, false);
      await dev.goOffline("refuse");
      await waitUntil(() => a.closed, 1000, "ws close");
      assert.equal(dev.wsClientCount, 0);
      await dev.goOnline();
    });
  });

  it("close() stops the listener for good", async () => {
    const dev = await startFakeDevice({ ...FAST });
    await dev.close();
    await assert.rejects(rawRequest(dev.url, { path: "/api/v1/status" }), /ECONNREFUSED/);
    await dev.close(); // idempotent
  });
});

describe("reboot and factory reset: no response, then back", () => {
  it("POST /system/reboot: the socket dies without a response, the device is offline, then back with boot_count + 1", async () => {
    await withDevice({ seed: "demo", rebootMs: 250 }, async (dev) => {
      const before = await statusOf(dev);
      const port = dev.port;
      await assert.rejects(postRaw(dev, "/system/reboot"), (e: NodeJS.ErrnoException) => /socket hang up|ECONNRESET/.test(`${e.code} ${e.message}`));
      assert.equal(dev.availability, "refuse");
      await assert.rejects(rawRequest(dev.url, { path: "/api/v1/status" }), /ECONNREFUSED/);
      const after = await backOnline(dev, before.boot_count + 1);
      assert.equal(dev.port, port);
      assert.equal(after.id, before.id);
      assert.equal(after.boot_count, before.boot_count + 1);
      assert.equal(after.reset_reason, 3);
      assert.ok(after.uptime_s <= 1);
      assert.deepEqual(Object.keys(after.io), Object.keys(before.io), "persisted config survives a reboot");
    });
  });

  it("system.reboot over a command and over the WebSocket", async () => {
    await withDevice({}, async (dev) => {
      await assert.rejects(postRaw(dev, "/command", JSON.stringify({ cmd: "system.reboot", corr: "r" })));
      await backOnline(dev, 2);
      const ws = await WsClient.connect(dev);
      ws.send({ cmd: "system.reboot", corr: "w" });
      await waitUntil(() => ws.closed, 1000, "ws dropped");
      assert.equal(ws.replies.length, 0, "no reply is sent");
      await backOnline(dev, 3);
    });
  });

  it("reboot() resolves when the device is back", async () => {
    await withDevice({ rebootMs: 100 }, async (dev) => {
      await dev.reboot();
      assert.equal(dev.availability, "online");
      assert.equal(dev.state.boot_count, 2);
      assert.equal((await statusOf(dev)).boot_count, 2);
    });
  });

  it("factory reset wipes the config and the device stays off the LAN", async () => {
    await withDevice({ seed: "demo", name: "Wipe me" }, async (dev) => {
      const before = await statusOf(dev);
      assert.ok(Object.keys(before.io).length > 0);
      await assert.rejects(postRaw(dev, "/system/factory_reset"));
      await sleep(FAST.rebootMs! + 150);
      assert.equal(dev.availability, "refuse", "left the LAN as a SoftAP");
      await assert.rejects(rawRequest(dev.url, { path: "/api/v1/status" }), /ECONNREFUSED/);
      assert.deepEqual([dev.state.pins, dev.state.modules, dev.state.rules], [[], [], []]);
      await dev.goOnline();
      const s = await statusOf(dev);
      assert.deepEqual(s.io, {});
      assert.equal(s.name, s.hostname);
      assert.equal(s.network.state, "ap_only");
      assert.equal(s.network.provisioned, false);
      assert.equal(s.network.sta_connected, false);
      assert.equal(s.mqtt.uri, "");
      assert.equal(s.mqtt.connected, false);
      assert.equal(dev.state.mqtt.user, "");
      assert.equal(dev.state.apPassword, "");
      assert.equal(s.boot_count, before.boot_count + 1);
      assert.equal(s.id, before.id);
      assert.equal(result<{ rules: unknown[] }>(await cmd(dev, { cmd: "rule.list" })).rules.length, 0);
    });
  });

  it("factoryResetReturns brings it back online, wiped", async () => {
    await withDevice({ seed: "demo", factoryResetReturns: true }, async (dev) => {
      await assert.rejects(postRaw(dev, "/command", JSON.stringify({ cmd: "system.factory_reset" })));
      const s = await backOnline(dev, 2);
      assert.deepEqual(s.io, {});
      assert.equal(s.network.state, "ap_only");
    });
  });

  it("network.wifi.clear replies, then the device leaves the LAN", async () => {
    await withDevice({ seed: "demo" }, async (dev) => {
      const env = await cmd<{ state: string }>(dev, { cmd: "network.wifi.clear" });
      assert.equal(result(env).state, "ap_only");
      await waitUntil(() => dev.availability === "refuse", 1000, "offline");
      await assert.rejects(rawRequest(dev.url, { path: "/api/v1/status" }), /ECONNREFUSED/);
      assert.equal(dev.state.network.provisioned, false);
      assert.equal(dev.state.boot_count, 1, "no reboot");
      await dev.goOnline();
      assert.equal((await statusOf(dev)).network.state, "ap_only");
    });
  });
});

describe("OTA upload", () => {
  it("accepts an image, replies, reboots into the other slot, then marks it valid", async () => {
    await withDevice({ seed: "demo", verifyMs: 250 }, async (dev) => {
      const ws = await WsClient.connect(dev);
      const img = makeFakeImage({ version: "newver1", date: "Dec 01 2026", time: "10:11:12", size: 200_000 });
      const reply = await upload(dev, img);
      assert.equal(reply.ok, true);
      assert.equal(reply.result?.session, "rebooting");
      assert.equal(reply.result?.incoming_version, "newver1");
      assert.equal(reply.result?.app_version, "9dcba89", "still the old image until the reboot");
      await waitUntil(() => ws.closed, 2000, "ws dropped by the reboot");

      const s = await backOnline(dev, 2);
      assert.equal(s.ota.app_version, "newver1");
      assert.equal(s.ota.compile_date, "Dec 01 2026");
      assert.equal(s.ota.compile_time, "10:11:12");
      assert.equal(s.ota.running_partition, "ota_1");
      assert.equal(s.ota.next_partition, "ota_0");
      assert.equal(s.ota.image_state, "pending_verify");
      assert.equal(s.ota.rollback_possible, true);
      assert.equal(s.ota.session, "idle");
      await waitUntil(async () => (await get<OtaStatus>(dev, "/ota")).body.image_state === "valid", 2000, "pending_verify -> valid");
      assert.equal(s.fw, "0.1.0");
    });
  });

  it("emits ota/progress every 64 KB and on state changes", async () => {
    await withDevice({}, async (dev) => {
      const ws = await WsClient.connect(dev);
      await upload(dev, makeFakeImage({ version: "p1", size: 200_000 }));
      await waitUntil(() => ws.of("ota/progress").some((p) => p.session === "rebooting"), 2000, "rebooting event");
      const ev = ws.of("ota/progress");
      assert.ok(ev.length >= 5, `expected start + 3 chunks + rebooting, got ${ev.length}`);
      assert.equal(ev[0]?.session, "writing");
      assert.equal(ev[0]?.bytes, 0);
      assert.equal(ev[0]?.total, 200_000);
      const writing = ev.filter((p) => p.session === "writing");
      assert.ok(writing.some((p) => p.bytes >= 65536 && p.percent > 0));
      for (let i = 1; i < writing.length; i++) assert.ok(writing[i]!.bytes >= writing[i - 1]!.bytes);
      assert.equal(ev[ev.length - 1]?.percent, 100);
    });
  });

  it("rejects bad magic, bad descriptor, wrong project and tiny images without rebooting", async () => {
    await withDevice({}, async (dev) => {
      const bad = await upload(dev, makeFakeImage({ firstByte: 0x00 }));
      assert.deepEqual([bad.ok, /0xE9|magic/.test(bad.error ?? "")], [false, true]);
      let o = (await get<OtaStatus>(dev, "/ota")).body;
      assert.equal(o.session, "error");
      assert.ok(o.last_error);
      assert.equal(o.busy, false);

      const badDesc = await upload(dev, makeFakeImage({ descMagic: 0x12345678 }));
      assert.equal(badDesc.ok, false);
      assert.match(badDesc.error ?? "", /magic/);

      const wrong = await upload(dev, makeFakeImage({ project: "other_project", version: "x9" }));
      assert.equal(wrong.ok, false);
      assert.match(wrong.error ?? "", /project/);
      o = (await get<OtaStatus>(dev, "/ota")).body;
      assert.equal(o.incoming_project, "other_project");
      assert.equal(o.incoming_version, "x9");

      const tiny = await upload(dev, Buffer.from([0xe9, 1, 2, 3]));
      assert.equal(tiny.ok, false);

      await sleep(150);
      const s = await statusOf(dev);
      assert.equal(s.boot_count, 1);
      assert.equal(s.ota.app_version, "9dcba89");
      assert.equal(s.ota.running_partition, "ota_0");
    });
  });

  it("requires Content-Length", async () => {
    await withDevice({}, async (dev) => {
      const r = await rawRequest(dev.url, { method: "POST", path: "/api/v1/ota", headers: { "Transfer-Encoding": "chunked" }, body: "abc" });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text), { v: 1, ok: false, error: "Content-Length required" });
    });
  });

  it("a running pending_verify image blocks the next OTA until it is valid", async () => {
    await withDevice({ verifyMs: 400 }, async (dev) => {
      await upload(dev, makeFakeImage({ version: "v2" }));
      await backOnline(dev, 2);
      assert.equal((await get<OtaStatus>(dev, "/ota")).body.image_state, "pending_verify");
      const blocked = await upload(dev, makeFakeImage({ version: "v3" }));
      assert.deepEqual(blocked, { v: 1, ok: false, error: "running image still pending verify" } as unknown);
      failsWith(await cmd(dev, { cmd: "ota.apply", url: "http://x/fw.bin" }), "running image still pending verify");
      await waitUntil(async () => (await get<OtaStatus>(dev, "/ota")).body.image_state === "valid", 2000, "valid");
      const ok = await upload(dev, makeFakeImage({ version: "v3" }));
      assert.equal(ok.ok, true);
      const s = await backOnline(dev, 3);
      assert.equal(s.ota.app_version, "v3");
      assert.equal(s.ota.running_partition, "ota_0", "slots alternate");
    });
  });

  it("fault otaFailAtBytes: the socket dies mid-upload and nothing changes", async () => {
    await withDevice({ faults: { otaFailAtBytes: 70_000 } }, async (dev) => {
      const ws = await WsClient.connect(dev);
      await assert.rejects(upload(dev, makeFakeImage({ size: 300_000 })));
      await sleep(100);
      const o = (await get<OtaStatus>(dev, "/ota")).body;
      assert.equal(o.session, "error");
      assert.equal(o.last_error, "upload aborted");
      assert.equal(o.busy, false);
      assert.equal(dev.availability, "online");
      assert.equal(dev.state.boot_count, 1);
      assert.ok(ws.of("ota/progress").some((p) => p.session === "error" && p.error === "upload aborted"));
      dev.options.faults = {};
      assert.equal((await upload(dev, makeFakeImage({ version: "retry" }))).ok, true, "a retry works");
    });
  });

  it("fault otaRollback: the device comes back on the OLD slot and version", async () => {
    await withDevice({ faults: { otaRollback: true } }, async (dev) => {
      const reply = await upload(dev, makeFakeImage({ version: "bad1" }));
      assert.equal(reply.ok, true);
      const s = await backOnline(dev, 2);
      assert.equal(s.ota.app_version, "9dcba89");
      assert.equal(s.ota.running_partition, "ota_0");
      assert.equal(s.ota.image_state, "valid");
      assert.equal(s.ota.rollback_possible, false);
      assert.ok(s.ota.last_error);
    });
  });
});

describe("ota.apply and ota.rollback", () => {
  it("ota.apply replies with status + note, streams ota/progress, then reboots into the new image", async () => {
    await withDevice({ seed: "demo", otaApplyMs: 200 }, async (dev) => {
      const ws = await WsClient.connect(dev);
      const env = await ws.call<OtaApplyResult>({ cmd: "ota.apply", url: "https://example.invalid/fw/de_esp32.bin" });
      const r = result(env);
      assert.equal(r.session, "fetching");
      assert.equal(r.busy, true);
      assert.ok(r.note.length > 0);
      assert.equal(r.app_version, "9dcba89");
      failsWith(await ws.call({ cmd: "ota.apply", url: "http://other/fw.bin" }), "ota busy");
      await waitUntil(() => ws.of("ota/progress").some((p) => p.session === "rebooting"), 2000, "rebooting");
      const fetching = ws.of("ota/progress").filter((p) => p.session === "fetching");
      assert.ok(fetching.length >= 3);
      assert.ok(fetching.some((p) => p.percent > 0 && p.percent < 100));
      for (let i = 1; i < fetching.length; i++) assert.ok(fetching[i]!.percent >= fetching[i - 1]!.percent);
      await waitUntil(() => ws.closed, 2000, "ws dropped by reboot");
      const s = await backOnline(dev, 2);
      assert.notEqual(s.ota.app_version, "9dcba89");
      assert.equal(s.ota.running_partition, "ota_1");
      assert.equal(s.ota.image_state, "pending_verify");
    });
  });

  it("ota.rollback reboots into the previous slot; a second rollback has no valid slot", async () => {
    await withDevice({ seed: "demo", verifyMs: 50 }, async (dev) => {
      assert.equal((await statusOf(dev)).ota.rollback_possible, true);
      await assert.rejects(postRaw(dev, "/command", JSON.stringify({ cmd: "ota.rollback" })));
      const s = await backOnline(dev, 2);
      assert.equal(s.ota.app_version, "5e3c76f");
      assert.equal(s.ota.running_partition, "ota_1");
      assert.equal(s.ota.image_state, "valid");
      assert.equal(s.ota.rollback_possible, false);
      failsWith(await cmd(dev, { cmd: "ota.rollback" }), "no valid previous slot");
    });
  });
});
