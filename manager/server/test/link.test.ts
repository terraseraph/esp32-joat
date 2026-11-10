import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import type { BrowserWsMessage, DeviceSummary, PinConfigResponse } from "../src/types/api";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, WsClient, cmd as deviceCmd, sleep, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

type Msg = BrowserWsMessage;
type Of<T extends Msg["t"]> = Extract<Msg, { t: T }>;

/** A browser WebSocket that records every frame (raw text and parsed). */
class Browser {
  readonly msgs: Msg[] = [];
  readonly raw: string[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const text = d.toString();
      this.raw.push(text);
      this.msgs.push(JSON.parse(text) as Msg);
    });
  }
  static connect(url: string, headers: Record<string, string> = {}): Promise<Browser> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      const b = new Browser(ws);
      ws.once("open", () => resolve(b));
      ws.once("error", reject);
    });
  }
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }
  watch(...ids: string[]): void {
    this.send({ t: "watch", ids });
  }
  of<T extends Msg["t"]>(t: T, id?: string): Of<T>[] {
    return this.msgs.filter((m): m is Of<T> => m.t === t && (id === undefined || (m as { id?: string }).id === id));
  }
  links(id: string): string[] {
    return this.of("link", id).map((m) => m.ws);
  }
  async until(pred: (m: Msg) => boolean, what: string, timeoutMs = 3000): Promise<Msg> {
    await waitUntil(() => this.msgs.some(pred), timeoutMs, what);
    return this.msgs.find(pred) as Msg;
  }
  async cmd(id: string, body: Record<string, unknown>, corr = `k${Math.random().toString(36).slice(2)}`): Promise<Of<"cmdResult">> {
    this.send({ t: "cmd", id, corr, body });
    return (await this.until((m) => m.t === "cmdResult" && m.corr === corr, `cmdResult for ${String(body.cmd)}`, 5000)) as Of<"cmdResult">;
  }
  close(): void {
    this.ws.close();
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };
let idCounter = 0;
const nextId = (): string => (0xb1c2d3e40000 + ++idCounter).toString(16);

const OPTS = {
  pollIntervalMs: 60_000,
  pollTimeoutMs: 400,
  rebootWindowMs: 5000,
  registrySaveDebounceMs: 40,
  linkIdleCloseMs: 150,
  fullDetectMs: 300,
  livePollMs: 100,
  linkBackoffMinMs: 40,
  linkBackoffMaxMs: 200,
  hydrateSettleMs: 40,
  hydrateMaxMs: 500,
};

describe("device link and live fan-out", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const browsers: Browser[] = [];
  const clients: WsClient[] = [];
  const api = (p: string): string => `${srv.base}${p}`;
  const wsUrl = (): string => `ws://127.0.0.1:${srv.port}/api/ws`;

  const startFake = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> => {
    const d = await startFakeDevice({ ...FAST, seed: "demo", id: nextId(), ...extra });
    fakes.push(d);
    return d;
  };
  const add = async (d: FakeDevice): Promise<string> => {
    const r = await fetchJson<DeviceSummary>(api("/api/devices"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ host: `127.0.0.1:${d.port}` }) });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    return r.body.id;
  };
  const browser = async (): Promise<Browser> => {
    const b = await Browser.connect(wsUrl());
    browsers.push(b);
    return b;
  };
  /** Add a fake device, open a browser, watch it and wait until the link is open and the first snapshot arrived. */
  const watched = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<{ dev: FakeDevice; id: string; b: Browser }> => {
    const dev = await startFake(extra);
    const id = await add(dev);
    const b = await browser();
    b.watch(id);
    await b.until((m) => m.t === "link" && m.id === id && m.ws === "open", "link open");
    await b.until((m) => m.t === "live" && m.id === id, "live snapshot");
    return { dev, id, b };
  };
  const summary = async (id: string): Promise<DeviceSummary> => (await fetchJson<DeviceSummary>(api(`/api/devices/${id}`))).body;
  const post = (p: string, body: unknown) => fetchJson<Record<string, unknown>>(api(p), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

  before(async () => {
    srv = await startTestServer(OPTS);
  });
  after(async () => {
    for (const b of browsers) b.close();
    for (const c of clients) await c.close();
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
  });

  test("two browsers watching one device share ONE device socket; live snapshot after hydrate; replies are not events", async () => {
    const dev = await startFake();
    const id = await add(dev);
    const a = await browser();
    const b = await browser();
    a.watch(id);
    b.watch(id);
    for (const x of [a, b]) {
      await x.until((m) => m.t === "link" && m.id === id && m.ws === "open", "link open");
      const live = (await x.until((m) => m.t === "live" && m.id === id, "live")) as Of<"live">;
      assert.deepEqual(Object.keys(live.io).sort(), ["adc_32", "gpio_27", "gpio_4", "mod_env0", "pwm_18", "servo_19"]);
      assert.equal(live.io.gpio_27 && "level" in live.io.gpio_27 ? live.io.gpio_27.level : null, 1);
      assert.ok(x.links(id)[0] === "connecting" || x.links(id)[0] === "open");
    }
    assert.equal(dev.wsClientCount, 1);
    assert.equal((await summary(id)).link, "open");
    // the hydrate reply and every other reply frame stay inside the server
    for (const x of [a, b]) {
      assert.equal(x.of("event", id).filter((e) => typeof e.topic !== "string" || (e.data as { corr?: string } | undefined)?.corr !== undefined).length, 0);
      assert.ok(!x.raw.some((r) => r.includes("mgr-hydrate")));
    }
    // a third socket joining later gets the cached snapshot at once
    const c = await browser();
    c.watch(id);
    await c.until((m) => m.t === "live" && m.id === id, "cached live");
    assert.equal(dev.wsClientCount, 1);
  });

  test("io changes fan out only to watchers; unknown ids are ignored; messages carry the device id", async () => {
    const { dev, id, b } = await watched();
    const bystander = await browser();
    bystander.watch("0123456789ab", "not-a-device");
    await sleep(30);
    dev.setInput(27, 0);
    const io = (await b.until((m) => m.t === "io" && m.id === id && m.data.id === "gpio_27", "io gpio_27")) as Of<"io">;
    assert.equal(io.topic, "io/gpio");
    assert.equal("level" in io.data ? io.data.level : null, 0);
    await sleep(100);
    assert.deepEqual(bystander.msgs.map((m) => m.t).filter((t) => t !== "hello" && t !== "devices" && t !== "device"), []);
    assert.equal(bystander.of("link").length, 0);
  });

  test("unwatching closes the device socket after the idle time; closing the browser unwatches", async () => {
    const { dev, id, b } = await watched();
    const other = await browser();
    other.watch(id);
    await other.until((m) => m.t === "link" && m.id === id, "link");
    b.watch(); // one watcher left: stays open
    await sleep(OPTS.linkIdleCloseMs * 2);
    assert.equal(dev.wsClientCount, 1);
    assert.equal((await summary(id)).link, "open");
    other.close(); // last watcher gone
    await sleep(30);
    assert.equal(dev.wsClientCount, 1, "not closed at once");
    await waitUntil(() => dev.wsClientCount === 0, 2000, "device socket closed");
    await waitUntil(async () => (await summary(id)).link === "closed", 2000, "summary link closed");
    // watching again reopens (and the cache was dropped, so a fresh snapshot arrives)
    const again = await browser();
    again.watch(id);
    await again.until((m) => m.t === "link" && m.id === id && m.ws === "open", "link reopened");
    assert.equal(dev.wsClientCount, 1);
  });

  test("full: a device with all slots taken gives link full and synthesised io from GET /pins polls", async () => {
    const dev = await startFake();
    for (let i = 0; i < 4; i++) clients.push(await WsClient.connect(dev));
    const id = await add(dev);
    const b = await browser();
    b.watch(id);
    await b.until((m) => m.t === "link" && m.id === id && m.ws === "full", "link full");
    assert.equal(dev.wsClientCount, 5);
    assert.equal((await summary(id)).link, "full");
    // the first poll result is a snapshot
    const live = (await b.until((m) => m.t === "live" && m.id === id, "live from poll")) as Of<"live">;
    assert.ok(live.io.gpio_27);
    const before = b.msgs.length;
    dev.setInput(27, 0);
    const io = (await b.until((m) => m.t === "io" && m.id === id && m.data.id === "gpio_27", "synthesised io")) as Of<"io">;
    assert.equal(io.topic, "io/gpio");
    assert.equal("level" in io.data ? io.data.level : null, 0);
    // only the changed key is sent
    await sleep(250);
    const ios = b.msgs.slice(before).filter((m): m is Of<"io"> => m.t === "io");
    assert.deepEqual([...new Set(ios.map((m) => m.data.id))], ["gpio_27"]);
    // commands still work (HTTP path, the link is not open)
    const r = await b.cmd(id, { cmd: "pin.set", gpio: 4, value: 1 });
    assert.equal(r.res.ok, true);
    assert.equal(dev.requestLog.filter((e) => e.kind === "ws" && e.path === "pin.set").length, 0);
    // a slot frees up: the next reconnect is registered and the link becomes open (events flow again)
    for (const c of clients.splice(0)) await c.close();
  });

  test("mqtt/reconfigure frames (with the MQTT password) are never forwarded", async () => {
    const { dev, id, b } = await watched();
    const spy = await WsClient.connect(dev);
    clients.push(spy);
    const r = await b.cmd(id, { cmd: "mqtt.configure", uri: "mqtt://10.9.8.7:1883", user: "bob", password: "hunter2-secret" });
    assert.equal(r.res.ok, true);
    await spy.waitFor("mqtt/reconfigure"); // the device did leak it to its other client
    await sleep(120);
    for (const raw of b.raw) {
      assert.ok(!raw.includes("mqtt/reconfigure"), raw);
      assert.ok(!raw.includes("hunter2-secret"), raw);
    }
  });

  test("the device socket reconnects after a reboot and a new snapshot arrives", async () => {
    const { dev, id, b } = await watched();
    const lives = b.of("live", id).length;
    await dev.reboot();
    await waitUntil(() => b.of("live", id).length > lives && b.links(id).slice(-1)[0] === "open", 4000, "open and live after reconnect");
    assert.ok(b.links(id).includes("connecting"));
    assert.equal(dev.wsClientCount, 1);
  });

  test("browser cmd over the open link: server corr to the device, browser corr back, events flow", async () => {
    const { dev, id, b } = await watched();
    const r = await b.cmd(id, { cmd: "pin.set", gpio: 4, value: 1 }, "my-corr");
    assert.equal(r.corr, "my-corr");
    assert.equal(r.id, id);
    assert.deepEqual(r.res, { v: 1, ok: true, result: { gpio: 4, value: 1 } });
    assert.equal(dev.requestLog.filter((e) => e.kind === "ws" && e.path === "pin.set").length, 1);
    await b.until((m) => m.t === "io" && m.id === id && m.data.id === "gpio_4" && "level" in m.data && m.data.level === 1, "io from the command");
    // a device-side failure is an ok:false envelope, not a transport error
    const bad = await b.cmd(id, { cmd: "pin.set", gpio: 5, value: 1 });
    assert.equal(bad.res.ok, false);
    assert.match(bad.res.error ?? "", /ESP_ERR_INVALID_STATE/);
  });

  test("browser cmd over HTTP when nobody watches; failures and unknown devices are ok:false", async () => {
    const dev = await startFake();
    const id = await add(dev);
    const b = await browser(); // not watching
    const r = await b.cmd(id, { cmd: "pin.set", gpio: 4, value: 1 });
    assert.deepEqual(r.res, { v: 1, ok: true, result: { gpio: 4, value: 1 } });
    assert.equal(dev.requestLog.filter((e) => e.kind === "ws").length, 0);
    assert.ok(dev.requestLog.some((e) => e.kind === "http" && e.method === "POST" && e.path === "/api/v1/command"));
    const unknown = await b.cmd("0123456789ab", { cmd: "pin.set", gpio: 4, value: 1 });
    assert.equal(unknown.res.ok, false);
    const malformed = await b.cmd(id, {});
    assert.equal(malformed.res.ok, false);
    await dev.goOffline("refuse");
    const down = await b.cmd(id, { cmd: "pin.set", gpio: 4, value: 1 });
    assert.equal(down.res.ok, false);
    assert.match(down.res.error ?? "", /refused|reach|closed/i);
  });

  test("system.reboot over the browser socket takes the HTTP path: expectedRestart and health rebooting", async () => {
    const { id, b } = await watched();
    const r = await b.cmd(id, { cmd: "system.reboot" });
    assert.deepEqual(r.res, { v: 1, ok: true, result: { expectedRestart: true } });
    assert.equal((await summary(id)).health, "rebooting");
    await waitUntil(() => b.links(id).slice(-1)[0] === "open" && b.links(id).includes("connecting"), 5000, "link back after the reboot");
  });

  test("a config change pushes a fresh live snapshot (also when keys disappear), through every path", async () => {
    const { id, b } = await watched();
    const liveCount = () => b.of("live", id).length;
    const lastLive = (): Of<"live"> => b.of("live", id).slice(-1)[0]!;

    let n = liveCount();
    assert.equal((await b.cmd(id, { cmd: "pin.configure", pin: { gpio: 13, mode: "out" } })).res.ok, true); // WS path
    await waitUntil(() => liveCount() > n && "gpio_13" in lastLive().io, 3000, "live with gpio_13");

    n = liveCount();
    assert.equal((await post(`/api/devices/${id}/command`, { cmd: "pin.configure", pin: { gpio: 14, mode: "out" } })).status, 200); // REST /command
    await waitUntil(() => liveCount() > n && "gpio_14" in lastLive().io, 3000, "live with gpio_14");

    n = liveCount();
    assert.equal((await post(`/api/devices/${id}/v1/pins`, { gpio: 13, mode: "disabled" })).status, 200); // passthrough, removes a key
    await waitUntil(() => liveCount() > n && !("gpio_13" in lastLive().io), 3000, "live without gpio_13");
    assert.ok("gpio_14" in lastLive().io);

    n = liveCount();
    assert.equal((await post(`/api/devices/${id}/command`, { cmd: "module.remove", id: "env0" })).status, 200);
    await waitUntil(() => liveCount() > n && !("mod_env0" in lastLive().io), 3000, "live without mod_env0");
  });

  test("identity/rename events update the stored name and are forwarded", async () => {
    const { dev, id, b } = await watched();
    dev.emit("identity/rename", { old_topic_id: "old", topic_id: "new", name: "From event" });
    await waitUntil(async () => (await summary(id)).name === "From event", 2000, "registry name");
    const ev = (await b.until((m) => m.t === "event" && m.id === id && m.topic === "identity/rename", "event")) as Of<"event">;
    assert.equal((ev.data as { name: string }).name, "From event");
    // and the command itself (any path) updates it too
    assert.equal((await b.cmd(id, { cmd: "identity.set_name", name: "Via command" })).res.ok, true);
    await waitUntil(async () => (await summary(id)).name === "Via command", 2000, "name after set_name");
  });

  test("telemetry and other events are forwarded as event messages", async () => {
    const { dev, id, b } = await watched();
    dev.emit("net", { state: "sta_connected", sta_ip: "10.1.1.1" });
    const ev = (await b.until((m) => m.t === "event" && m.id === id && m.topic === "net", "net event")) as Of<"event">;
    assert.deepEqual(ev.data, { state: "sta_connected", sta_ip: "10.1.1.1" });
  });

  test("forgetting a device closes its link at once", async () => {
    const { dev, id, b } = await watched();
    const r = await fetchJson(api(`/api/devices/${id}`), { method: "DELETE" });
    assert.equal(r.status, 204);
    await waitUntil(() => dev.wsClientCount === 0, 1000, "device socket closed");
    await b.until((m) => m.t === "deviceRemoved" && m.id === id, "deviceRemoved");
  });

  test("a changed address reconnects to the new one", async () => {
    const { dev, id } = await watched();
    const moved = await startFake({ id });
    const r = await fetchJson(api(`/api/devices/${id}`), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ host: `127.0.0.1:${moved.port}` }) });
    assert.equal(r.status, 200);
    await waitUntil(() => dev.wsClientCount === 0 && moved.wsClientCount === 1, 3000, "link moved");
  });

  test("a link that cannot open is connecting and retries with backoff until the device answers", async () => {
    const dev = await startFake();
    const id = await add(dev);
    await dev.goOffline("refuse");
    const b = await browser();
    b.watch(id);
    await b.until((m) => m.t === "link" && m.id === id && m.ws === "connecting", "connecting");
    await sleep(250);
    assert.equal(b.links(id).at(-1), "connecting");
    await dev.goOnline();
    await b.until((m) => m.t === "link" && m.id === id && m.ws === "open", "open after the device is back", 4000);
  });
});

describe("pin shadow and GET /api/devices/:id/pin-config", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const api = (p: string): string => `${srv.base}${p}`;
  const post = (p: string, body: unknown) => fetchJson<Record<string, unknown>>(api(p), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  const startAdd = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<{ dev: FakeDevice; id: string }> => {
    const dev = await startFakeDevice({ ...FAST, seed: "demo", id: nextId(), ...extra });
    fakes.push(dev);
    const r = await fetchJson<DeviceSummary>(api("/api/devices"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ host: `127.0.0.1:${dev.port}` }) });
    assert.equal(r.status, 201);
    return { dev, id: r.body.id };
  };
  const pinConfig = async (id: string) => fetchJson<PinConfigResponse>(api(`/api/devices/${id}/pin-config`));
  const entry = (r: PinConfigResponse, gpio: number) => r.pins.find((p) => p.gpio === gpio);

  before(async () => {
    srv = await startTestServer({ ...OPTS, linkIdleCloseMs: 100 });
  });
  after(async () => {
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
  });

  test("derives minimal configs from the live state (non-default options only), sorted, without add-on modules", async () => {
    const { id } = await startAdd();
    const r = await pinConfig(id);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.pins.map((p) => [p.gpio, p.mode, p.source]),
      [[4, "out", "live"], [18, "pwm", "live"], [19, "servo", "live"], [27, "in", "live"], [32, "adc", "live"]],
    );
    assert.deepEqual(entry(r.body, 4)?.config, { gpio: 4, mode: "out" });
    assert.deepEqual(entry(r.body, 18)?.config, { gpio: 18, mode: "pwm", duty: 250 });
    assert.deepEqual(entry(r.body, 19)?.config, { gpio: 19, mode: "servo" });
    assert.deepEqual(entry(r.body, 27)?.config, { gpio: 27, mode: "in" });
    assert.deepEqual(entry(r.body, 32)?.config, { gpio: 32, mode: "adc" });
    assert.equal((entry(r.body, 27)?.live as { id?: string }).id, "gpio_27");
  });

  test("non-default options are listed", async () => {
    const { dev, id } = await startAdd();
    await deviceCmd(dev, { cmd: "pin.configure", pin: { gpio: 27, mode: "in", debounce_ms: 20 } });
    await deviceCmd(dev, { cmd: "pin.configure", pin: { gpio: 32, mode: "adc", sample_ms: 100, hysteresis_mv: 40, smooth: 10 } });
    await deviceCmd(dev, { cmd: "pin.configure", pin: { gpio: 19, mode: "servo", angle: 45, min_us: 600, max_us: 2400 } });
    const r = (await pinConfig(id)).body;
    assert.deepEqual(entry(r, 27)?.config, { gpio: 27, mode: "in", debounce_ms: 20 });
    assert.deepEqual(entry(r, 32)?.config, { gpio: 32, mode: "adc", sample_ms: 100, hysteresis_mv: 40, smooth: 10 });
    assert.deepEqual(entry(r, 19)?.config, { gpio: 19, mode: "servo", angle: 45, min_us: 600, max_us: 2400 });
  });

  test("the shadow wins while its mode matches the live mode, on every command path; a mismatch falls back to live", async () => {
    const { dev, id } = await startAdd();
    const b = await Browser.connect(`ws://127.0.0.1:${srv.port}/api/ws`);
    try {
      const sent = { gpio: 13, mode: "out", boot: 1 };
      // 1. POST /command
      assert.equal((await post(`/api/devices/${id}/command`, { cmd: "pin.configure", pin: sent })).status, 200);
      // 2. POST v1/command with flat fields
      assert.equal((await post(`/api/devices/${id}/v1/command`, { cmd: "pin.configure", gpio: 14, mode: "out", boot: 1 })).status, 200);
      // 3. POST v1/pins
      assert.equal((await post(`/api/devices/${id}/v1/pins`, { gpio: 25, mode: "out", boot: 1 })).status, 200);
      // 4. browser WS cmd, link closed -> HTTP path
      assert.equal((await b.cmd(id, { cmd: "pin.configure", pin: { gpio: 26, mode: "out", boot: 1 } })).res.ok, true);
      // 5. browser WS cmd over an open link
      b.watch(id);
      await b.until((m) => m.t === "link" && m.id === id && m.ws === "open", "open");
      assert.equal((await b.cmd(id, { cmd: "pin.configure", pin: { gpio: 33, mode: "out", boot: 1 } })).res.ok, true);
      assert.ok(dev.requestLog.some((e) => e.kind === "ws" && e.path === "pin.configure"));

      const r = (await pinConfig(id)).body;
      for (const gpio of [13, 14, 25, 26, 33]) {
        assert.equal(entry(r, gpio)?.source, "shadow", `gpio ${gpio}`);
        assert.deepEqual(entry(r, gpio)?.config, { gpio, mode: "out", boot: 1 }, `gpio ${gpio}`);
      }
      await shadowIs(srv, id, 13, sent);

      // The device is changed behind the Manager's back: the shadow's mode no longer matches, so live wins.
      await deviceCmd(dev, { cmd: "pin.configure", pin: { gpio: 13, mode: "pwm", hz: 500 } });
      const mismatch = entry((await pinConfig(id)).body, 13);
      assert.equal(mismatch?.source, "live");
      assert.deepEqual(mismatch?.config, { gpio: 13, mode: "pwm", hz: 500 });

      // mode:"disabled" forgets the shadow (through the WS path) and the pin disappears from the list
      assert.equal((await b.cmd(id, { cmd: "pin.configure", pin: { gpio: 14, mode: "disabled" } })).res.ok, true);
      assert.equal(entry((await pinConfig(id)).body, 14), undefined);
      await shadowIs(srv, id, 14, undefined);
      assert.equal((await post(`/api/devices/${id}/v1/pins`, { gpio: 25, mode: "disabled" })).status, 200);
      await shadowIs(srv, id, 25, undefined);
    } finally {
      b.close();
    }
  });

  test("404 for an unknown device, 502 with transport:true when the device is down", async () => {
    const unknown = await fetchJson<{ code: string }>(api("/api/devices/0123456789ab/pin-config"));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_device");
    const { dev, id } = await startAdd();
    await dev.goOffline("refuse");
    const down = await fetchJson<{ ok: boolean; transport: boolean; code: string }>(api(`/api/devices/${id}/pin-config`));
    assert.equal(down.status, 502);
    assert.equal(down.body.transport, true);
    assert.equal(down.body.code, "device_unreachable");
  });
});

/** The pin shadow as saved in registry.json, once it equals `want` (undefined = gone). Fails with the last value on timeout. */
async function shadowIs(srv: TestServer, id: string, gpio: number, want: Record<string, unknown> | undefined): Promise<void> {
  let last: Record<string, unknown> | undefined;
  try {
    await waitUntil(() => {
      let reg: { devices: Array<{ id: string; pinShadow: Record<string, Record<string, unknown>> }> };
      try {
        reg = JSON.parse(readFileSync(path.join(srv.dataDir, "registry.json"), "utf8")) as typeof reg;
      } catch {
        return false; // not written yet, or caught mid-save: look again
      }
      last = reg.devices.find((d) => d.id === id)?.pinShadow?.[String(gpio)];
      return JSON.stringify(last) === JSON.stringify(want);
    }, 3000, "saved pin shadow");
  } catch {
    assert.deepEqual(last, want);
  }
}

describe("LAN mode", () => {
  test("a browser socket authenticated by cookie or Bearer token can watch a device and receives link", async () => {
    const srv = await startTestServer({ ...OPTS, lan: true });
    const dev = await startFakeDevice({ ...FAST, seed: "demo", id: nextId() });
    const sockets: Browser[] = [];
    try {
      const added = await fetchJson<DeviceSummary>(`${srv.base}/api/devices`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ host: `127.0.0.1:${dev.port}` }) });
      assert.equal(added.status, 201);
      const id = added.body.id;
      const url = `ws://127.0.0.1:${srv.port}/api/ws`;
      const remote = { Host: "192.168.1.5:5180" };
      await assert.rejects(Browser.connect(url, remote), /401/);
      const byCookie = await Browser.connect(url, { ...remote, Cookie: `dem_token=${srv.token}` });
      const byBearer = await Browser.connect(url, { ...remote, Authorization: `Bearer ${srv.token}` });
      sockets.push(byCookie, byBearer);
      for (const s of sockets) {
        s.watch(id);
        await s.until((m) => m.t === "link" && m.id === id, "link message");
        await s.until((m) => m.t === "link" && m.id === id && m.ws === "open", "link open");
      }
      assert.equal(dev.wsClientCount, 1);
    } finally {
      for (const s of sockets) s.close();
      await srv.close();
      await dev.close();
    }
  });
});
