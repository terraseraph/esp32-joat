import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { MqttReconfigureEvent, TelemetrySnapshot } from "../src/types/device-api";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, WsClient, cmd, failsWith, post, result, sleep, waitUntil } from "./fake/testkit";

describe("device WebSocket: events", () => {
  let dev: FakeDevice;
  let ws: WsClient;
  before(async () => {
    dev = await startFakeDevice({ ...FAST, seed: "demo" });
    ws = await WsClient.connect(dev);
  });
  after(async () => {
    await ws.close();
    await dev.close();
  });

  it("pin.set emits io/gpio, io/pwm and io/servo with the new state", async () => {
    result(await cmd(dev, { cmd: "pin.set", gpio: 4, value: 1 }));
    result(await cmd(dev, { cmd: "pin.set", gpio: 18, value: 600, mode: "pwm" }));
    result(await cmd(dev, { cmd: "pin.set", gpio: 19, value: 30, mode: "servo" }));
    await ws.waitFor("io/servo", (d) => (d as { angle: number }).angle === 30);
    assert.deepEqual(ws.of("io/gpio").at(-1), { id: "gpio_4", mode: "out", gpio: 4, level: 1 });
    assert.equal(ws.of("io/pwm").at(-1)?.duty, 600);
    assert.equal(ws.of("io/servo").at(-1)?.pulse_us, 833);
  });

  it("pin.configure emits io/<mode>; disabled emits nothing", async () => {
    const n = ws.events.length;
    result(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 13, mode: "pwm", hz: 500 } }));
    await ws.waitFor("io/pwm", (d) => (d as { gpio: number }).gpio === 13);
    result(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 13, mode: "disabled" } }));
    await sleep(60);
    assert.equal(ws.events.length, n + 1);
  });

  it("module.add emits io/env and io/rfid", async () => {
    result(await cmd(dev, { cmd: "module.add", type: "mfrc522", pins: { sck: 14, miso: 12, mosi: 13, ss: 15 }, bus: "hspi" }));
    await ws.waitFor("io/rfid", (d) => (d as { id: string }).id === "rfid0");
    result(await cmd(dev, { cmd: "module.configure", id: "env0", enabled: true, settings: { sample_ms: 500 } }));
    await ws.waitFor("io/env", (d) => (d as { id: string }).id === "env0");
  });

  it("io.hydrate re-emits every io key", async () => {
    const before = ws.events.length;
    const r = result<{ pins: number }>(await cmd(dev, { cmd: "io.hydrate" }));
    await waitUntil(() => ws.events.length >= before + r.pins, 2000, "hydrate frames");
    const frames = ws.events.slice(before, before + r.pins).map((e) => e.topic);
    for (const t of ["io/gpio", "io/adc", "io/pwm", "io/servo", "io/env", "io/rfid"]) assert.ok(frames.includes(t), t);
  });

  it("ADC input emits io/adc only past the hysteresis; rules react to it", async () => {
    const before = ws.of("io/adc").length;
    dev.setInput(32, 1655); // moved 5 mV < 20 mV hysteresis
    await sleep(40);
    assert.equal(ws.of("io/adc").length, before);
    dev.setInput(32, 2500);
    await ws.waitFor("io/adc", (d) => (d as { mv: number }).mv === 2500);
    await ws.waitFor("io/gpio", (d) => (d as { id: string; level: number }).id === "gpio_4" && (d as { level: number }).level === 1); // demo rule r32
  });

  it("mqtt.configure leaks the whole request, password and old_root (firmware bug, kept on purpose)", async () => {
    result(await cmd(dev, { cmd: "mqtt.configure", uri: "mqtt://10.0.0.9:1883", user: "bob", password: "s3cret!", root: "lab" }));
    const e = (await ws.waitFor("mqtt/reconfigure")) as MqttReconfigureEvent;
    assert.equal(e.password, "s3cret!");
    assert.equal(e.user, "bob");
    assert.equal(e.uri, "mqtt://10.0.0.9:1883");
    assert.equal(e.root, "lab");
    assert.equal(e.old_root, "devices");
  });

  it("identity.set_name emits identity/rename; network changes emit net", async () => {
    result(await cmd(dev, { cmd: "identity.set_name", name: "Bench A" }));
    const r = (await ws.waitFor("identity/rename")) as { old_topic_id: string; topic_id: string; name: string };
    assert.deepEqual([r.topic_id, r.name], ["Bench_A", "Bench A"]);
    assert.ok(r.old_topic_id.length > 0);
    result(await cmd(dev, { cmd: "network.recovery_ap" }));
    const net = (await ws.waitFor("net", (d) => (d as { state: string }).state === "apsta_recovery")) as { state: string; sta_ip: string };
    assert.deepEqual(Object.keys(net).sort(), ["sta_ip", "state"]);
  });

  it("emit() pushes arbitrary frames to registered clients", async () => {
    dev.emit("io/gpio", { id: "gpio_99", mode: "in", gpio: 99, level: 1 });
    await ws.waitFor("io/gpio", (d) => (d as { gpio: number }).gpio === 99);
  });
});

describe("device WebSocket: telemetry", () => {
  it("pushes a full telemetry snapshot every telemetryIntervalMs, only while a client is registered", async () => {
    const dev = await startFakeDevice({ ...FAST, telemetryIntervalMs: 80, seed: "demo" });
    try {
      await sleep(200);
      const ws = await WsClient.connect(dev);
      await waitUntil(() => ws.of("telemetry").length >= 3, 2000, "3 telemetry frames");
      const t = ws.of("telemetry")[0] as TelemetrySnapshot;
      assert.equal(t.id, dev.id);
      for (const k of ["v", "uptime_s", "memory", "network", "mqtt", "ota", "io"]) assert.ok(k in t, k);
      assert.ok(!("name" in t), "telemetry has no status-only fields");
      await ws.close();
    } finally {
      await dev.close();
    }
  });
});

describe("device WebSocket: commands", () => {
  it("replies on the same socket with corr echoed, for any command", async () => {
    const dev = await startFakeDevice({ ...FAST });
    try {
      const ws = await WsClient.connect(dev);
      ws.send({ cmd: "rule.list", corr: "one" });
      ws.send({ cmd: "bogus", corr: "two" });
      await waitUntil(() => ws.replies.length === 2, 2000, "two replies");
      assert.deepEqual(ws.replies.find((r) => r.corr === "one"), { v: 1, ok: true, corr: "one", result: { v: 1, rules: [] } });
      assert.deepEqual(ws.replies.find((r) => r.corr === "two"), { v: 1, ok: false, corr: "two", error: "unknown cmd" });
      assert.equal(ws.events.length, 0, "replies are not events");
      ws.send("{not json");
      await waitUntil(() => ws.replies.length === 3, 2000, "error reply");
      assert.equal(ws.replies[2]?.ok, false);
      await ws.close();
    } finally {
      await dev.close();
    }
  });

  it("has no 1536 byte body cap (unlike HTTP)", async () => {
    const dev = await startFakeDevice({ ...FAST });
    try {
      const ws = await WsClient.connect(dev);
      const name = "N".repeat(1900);
      const env = await ws.call<{ name: string }>({ cmd: "pin.configure", pin: { gpio: 13, mode: "out", name } });
      assert.equal(result<{ name?: string }>(env).name, name);
      const http = await post(dev, "/command", { cmd: "pin.configure", pin: { gpio: 14, mode: "out", name } }).catch(() => null);
      assert.ok(http === null || http.status === 400);
      await ws.close();
    } finally {
      await dev.close();
    }
  });

  it("a WebSocket command waits behind a slow request (single httpd task)", async () => {
    const dev = await startFakeDevice({ ...FAST, scanDelayMs: 300 });
    try {
      const ws = await WsClient.connect(dev);
      const t0 = Date.now();
      const scan = ws.call({ cmd: "network.wifi.scan" });
      await sleep(20);
      const list = ws.call({ cmd: "rule.list" });
      await list;
      assert.ok(Date.now() - t0 >= 280);
      await scan;
      await ws.close();
    } finally {
      await dev.close();
    }
  });
});

describe("device WebSocket: the 4-client limit", () => {
  it("a 5th client is accepted but not registered: no events, commands still answered; slots free up on close", async () => {
    const dev = await startFakeDevice({ ...FAST });
    try {
      const clients: WsClient[] = [];
      for (let i = 0; i < 5; i++) clients.push(await WsClient.connect(dev));
      assert.equal(dev.wsClientCount, 5);
      assert.equal(dev.registeredWsCount, 4);
      const [c1, c2, c3, c4, c5] = clients as [WsClient, WsClient, WsClient, WsClient, WsClient];

      result(await cmd(dev, { cmd: "pin.configure", pin: { gpio: 13, mode: "out" } }));
      for (const c of [c1, c2, c3, c4]) await c.waitFor("io/gpio");
      await sleep(100);
      assert.equal(c5.events.length, 0, "the 5th client gets nothing");

      const env = await c5.call({ cmd: "rule.list" });
      assert.equal(env.ok, true, "but its commands are answered");
      const set = await c5.call({ cmd: "pin.set", gpio: 13, value: 1 });
      assert.equal(set.ok, true);
      await c1.waitFor("io/gpio", (d) => (d as { level: number }).level === 1);
      await sleep(60);
      assert.equal(c5.events.length, 0);

      // free a slot: already-connected unregistered clients stay unregistered, the next NEW one gets it
      await c1.close();
      await waitUntil(() => dev.registeredWsCount === 3, 1000, "slot freed");
      assert.equal(dev.wsClientCount, 4);
      const c6 = await WsClient.connect(dev);
      assert.equal(dev.registeredWsCount, 4);
      result(await cmd(dev, { cmd: "pin.set", gpio: 13, value: 0 }));
      await c6.waitFor("io/gpio", (d) => (d as { level: number }).level === 0);
      await sleep(60);
      assert.equal(c5.events.length, 0, "c5 never gets registered retroactively");

      for (const c of [c2, c3, c4, c5, c6]) await c.close();
      await waitUntil(() => dev.wsClientCount === 0 && dev.registeredWsCount === 0, 1000, "all closed");
    } finally {
      await dev.close();
    }
  });

  it("wsLimit is configurable", async () => {
    const dev = await startFakeDevice({ ...FAST, wsLimit: 1 });
    try {
      const a = await WsClient.connect(dev);
      const b = await WsClient.connect(dev);
      assert.equal(dev.registeredWsCount, 1);
      dev.emit("telemetry", { x: 1 });
      await a.waitFor("telemetry");
      await sleep(50);
      assert.equal(b.events.length, 0);
      failsWith(await b.call({ cmd: "pin.set", gpio: 1 }), "value required");
      await a.close();
      await b.close();
    } finally {
      await dev.close();
    }
  });

  it("no client, no events: emit is a no-op without registered clients", async () => {
    const dev = await startFakeDevice({ ...FAST });
    try {
      dev.emit("telemetry", {});
      assert.equal(dev.registeredWsCount, 0);
    } finally {
      await dev.close();
    }
  });
});
