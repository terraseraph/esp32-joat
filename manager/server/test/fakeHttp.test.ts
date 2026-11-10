import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AccessPoint, DeviceStatus, Hardware, LogsResponse, MqttStatus, NetworkStatus, OpenApiDocument, OtaStatus, TelemetrySnapshot } from "../src/types/device-api";
import { fetchJson, rawRequest } from "./helpers";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { pushLog } from "./fake/state";
import { FAST, cmd, failsWith, get, post, result, sleep } from "./fake/testkit";

describe("fake device: GET routes and shapes", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST, seed: "demo", id: "a4cf12b3c4d5", name: "Workshop node" });
  });
  after(() => dev.close());

  const telemetryKeys = ["v", "id", "fw", "uptime_s", "boot_count", "reset_reason", "heap_free", "heap_min", "memory", "boot_state", "safe_mode", "network", "mqtt", "ota", "io"];
  const statusOnly = ["name", "topic_id", "hostname", "mac", "chip", "chip_info", "ap_ssid", "schema", "generation", "safe_reason", "sinks"];

  it("GET /status is telemetry plus the status-only fields", async () => {
    const r = await get<DeviceStatus>(dev, "/status");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/json");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    for (const k of [...telemetryKeys, ...statusOnly]) assert.ok(k in r.body, `missing ${k}`);
    const s = r.body;
    assert.equal(s.id, "a4cf12b3c4d5");
    assert.equal(s.mac, "a4:cf:12:b3:c4:d5");
    assert.equal(s.hostname, "esp32-b3c4d5");
    assert.equal(s.ap_ssid, s.hostname);
    assert.equal(s.name, "Workshop node");
    assert.equal(s.topic_id, "Workshop_node");
    assert.equal(s.fw, "0.1.0");
    assert.equal(s.schema, 4);
    assert.equal(s.boot_state, "healthy");
    assert.equal(s.chip, "ESP32 rev3");
    assert.deepEqual(Object.keys(s.chip_info).sort(), ["cores", "features", "model", "revision"]);
    assert.deepEqual(Object.keys(s.memory).sort(), ["alloc_failed", "alloc_failed_size", "boot", "dma", "internal", "pressure", "psram", "reserve", "tasks", "tasks_truncated"]);
    assert.equal(s.memory.psram, null);
    assert.equal(s.heap_free, s.memory.internal.free);
    assert.deepEqual(Object.keys(s.sinks ?? {}).sort(), ["mqtt", "rules", "serial", "ws"]);
    assert.ok(!("board" in s), "the real /status has no board field");
  });

  it("name defaults to the hostname", async () => {
    const d = await startFakeDevice({ ...FAST, id: "0123456789ab" });
    try {
      const s = (await get<DeviceStatus>(d, "/status")).body;
      assert.equal(s.name, "esp32-6789ab");
      assert.equal(s.name, s.hostname);
    } finally {
      await d.close();
    }
  });

  it("GET /telemetry has the snapshot keys only", async () => {
    const t = (await get<TelemetrySnapshot>(dev, "/telemetry")).body;
    assert.deepEqual(Object.keys(t).sort(), [...telemetryKeys].sort());
    assert.equal(t.v, 1);
  });

  it("GET /hardware: 19+19 pads, buses, chip and live owners", async () => {
    const h = (await get<Hardware>(dev, "/hardware")).body;
    assert.equal(h.board_id, "esp32-devkitc");
    assert.equal(h.header.left.length, 19);
    assert.equal(h.header.right.length, 19);
    assert.deepEqual(h.header.left[0], { i: 0, silk: "3V3", kind: "power", gpio: null });
    assert.equal(h.header.left[2]?.gpio, 36);
    assert.deepEqual(h.buses.map((b) => b.id), ["vspi", "hspi", "i2c0", "uart0", "uart2"]);
    assert.deepEqual(h.buses.find((b) => b.id === "i2c0")?.pins, { sda: 21, scl: 22 });
    assert.equal(h.chip, "ESP32 rev3");
    assert.equal(h.chip_info.model, "ESP32");
    const pin = (g: number) => h.pins.find((p) => p.gpio === g);
    assert.equal(pin(4)?.owner, "gpio_4");
    assert.equal(pin(18)?.owner, "pwm_18");
    assert.equal(pin(19)?.owner, "servo_19");
    assert.equal(pin(32)?.owner, "adc_32");
    assert.equal(pin(21)?.owner, "mod_env0");
    assert.equal(pin(22)?.owner, "mod_env0");
    assert.equal(pin(13)?.owner, "");
    assert.equal(pin(6)?.flash, true);
    assert.equal(pin(34)?.input_only, true);
    assert.equal(typeof pin(4)?.flags, "number");
  });

  it("GET /pins equals status.io (demo seed)", async () => {
    const pins = (await get<Record<string, unknown>>(dev, "/pins")).body;
    const status = (await get<DeviceStatus>(dev, "/status")).body;
    assert.deepEqual(pins, status.io);
    assert.deepEqual(Object.keys(pins).sort(), ["adc_32", "gpio_27", "gpio_4", "mod_env0", "pwm_18", "servo_19"]);
    assert.deepEqual(pins["gpio_4"], { id: "gpio_4", mode: "out", gpio: 4, level: 0 });
    assert.deepEqual(pins["adc_32"], { id: "adc_32", mode: "adc", gpio: 32, mv: 1650, raw: 2048, sample_ms: 50, hysteresis_mv: 20, smooth: 70 });
    assert.deepEqual(pins["servo_19"], { id: "servo_19", mode: "servo", gpio: 19, angle: 90, pulse_us: 1500, min_us: 500, max_us: 2500, hz: 50 });
    assert.deepEqual(pins["gpio_27"], { id: "gpio_27", mode: "in", gpio: 27, level: 1, debounce_ms: 50 });
  });

  it("GET /network, /mqtt, /ota", async () => {
    const n = (await get<NetworkStatus>(dev, "/network")).body;
    assert.deepEqual(Object.keys(n).sort(), ["ap_ip", "ap_open", "ap_ssid", "hostname", "provisioned", "rssi", "sta_connected", "sta_ip", "state"]);
    assert.equal(n.state, "sta_connected");
    const m = (await get<MqttStatus>(dev, "/mqtt")).body;
    assert.equal(m.connected, true);
    assert.equal(m.uri, "mqtt://192.168.1.10:1883");
    assert.equal(m.prefix, "devices/Workshop_node");
    assert.ok(!("user" in m) && !("password" in m));
    assert.deepEqual(m.sub, ["system/command", "config/set", "components/+/set"]);
    assert.ok("backlog" in m && "backlogs" in m && "io_dropped" in m && "outbox" in m);
    const o = (await get<OtaStatus>(dev, "/ota")).body;
    assert.equal(o.project, "de_esp32_runtime");
    assert.equal(o.app_version, "9dcba89");
    assert.equal(o.running_partition, "ota_0");
    assert.equal(o.next_partition, "ota_1");
    assert.equal(o.image_state, "valid");
    assert.equal(o.session, "idle");
    assert.equal(o.busy, false);
    assert.equal(o.rollback_possible, true);
    assert.ok(!("last_error" in o) && !("incoming_version" in o));
  });

  it("GET /logs: oldest first, at most 80 lines of 159 chars", async () => {
    for (let i = 0; i < 90; i++) pushLog(dev.state, `line ${i} ${"y".repeat(200)}`);
    const r = (await get<LogsResponse>(dev, "/logs")).body;
    assert.equal(r.lines.length, 80);
    assert.ok(r.lines.every((l) => l.length <= 159));
    assert.ok(r.lines[0]?.startsWith("line 10 "));
    assert.ok(r.lines[79]?.startsWith("line 89 "));
  });

  it("GET /network/scan is a bare array of access points", async () => {
    const t0 = Date.now();
    const r = await get<AccessPoint[]>(dev, "/network/scan");
    assert.ok(Date.now() - t0 >= 100, "scan blocks scanDelayMs");
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length >= 3);
    assert.deepEqual(Object.keys(r.body[0]!).sort(), ["auth", "channel", "rssi", "ssid"]);
  });

  it("GET /openapi.json carries the extensions and the only CORS header", async () => {
    const r = await get<OpenApiDocument>(dev, "/openapi.json");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.body.openapi, "3.0.3");
    assert.equal(r.body["x-commands"].length, 25);
    assert.ok(r.body["x-commands"].includes("pin.configure"));
    assert.deepEqual(Object.keys(r.body["x-mqtt"]).sort(), ["prefix", "root", "topics"]);
    assert.deepEqual(r.body["x-discovery"], { mdns: "esp32-b3c4d5", service: "_http._tcp", de_service: "_de-esp32._tcp", board: "esp32-devkitc", port: 80 });
  });

  it("GET / and /index.html serve a page", async () => {
    for (const p of ["/", "/index.html"]) {
      const r = await fetch(`${dev.url}${p}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await r.text(), /Workshop node/);
    }
  });

  it("legacy firmware omits the newer fields", async () => {
    const d = await startFakeDevice({ ...FAST, seed: "demo", legacy: true });
    try {
      const s = (await get<DeviceStatus>(d, "/status")).body;
      assert.ok(!("sinks" in s));
      const m = (await get<Record<string, unknown>>(d, "/mqtt")).body;
      for (const k of ["backlog", "backlogs", "io_dropped", "outbox"]) assert.ok(!(k in m), k);
    } finally {
      await d.close();
    }
  });
});

describe("fake device: POST routes and transport quirks", () => {
  let dev: FakeDevice;
  before(async () => {
    dev = await startFakeDevice({ ...FAST });
  });
  after(() => dev.close());

  it("POST /pins without cmd: the whole body is the pin", async () => {
    const r = await post<{ v: number; ok: boolean; result: Record<string, unknown> }>(dev, "/pins", { gpio: 13, mode: "out", boot: 1 });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.result.gpio, 13);
    assert.equal(r.body.result.mode, "out");
    assert.equal(r.body.result.boot, 1);
    const pins = (await get<Record<string, { level: number }>>(dev, "/pins")).body;
    assert.equal(pins["gpio_13"]?.level, 1);
  });

  it("POST /pins with a cmd runs that command", async () => {
    const r = await post<{ ok: boolean; result: { v: number; rules: unknown[] } }>(dev, "/pins", { cmd: "rule.list" });
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.result, { v: 1, rules: [] });
  });

  it("POST /command echoes corr on success and failure", async () => {
    const ok = await cmd(dev, { cmd: "rule.list", corr: "abc" });
    assert.deepEqual(ok, { v: 1, ok: true, corr: "abc", result: { v: 1, rules: [] } });
    const bad = await cmd(dev, { cmd: "nope", corr: "zzz" });
    assert.deepEqual(bad, { v: 1, ok: false, corr: "zzz", error: "unknown cmd" });
    assert.deepEqual(await cmd(dev, {}), { v: 1, ok: false, error: "unknown cmd" });
  });

  it("POST /network/wifi and /mqtt are envelopes of their commands", async () => {
    const w = await post<{ ok: boolean; result: NetworkStatus & { mdns: unknown } }>(dev, "/network/wifi", { ssid: "workshop-wifi", password: "secret123" });
    assert.equal(w.body.ok, true);
    assert.equal(w.body.result.sta_connected, true);
    assert.ok("mdns" in w.body.result);
    const m = await post<{ ok: boolean; result: { uri: string; root: string } }>(dev, "/mqtt", { uri: "mqtt://10.0.0.2:1883", root: "lab" });
    assert.deepEqual(m.body.result, { uri: "mqtt://10.0.0.2:1883", root: "lab" });
    const bad = await post<{ ok: boolean; error: string }>(dev, "/network/wifi", { ssid: "" });
    assert.equal(bad.body.ok, false);
  });

  it("rejects bodies over 1536 bytes, empty bodies and bad JSON with 400 text json", async () => {
    const big = JSON.stringify({ cmd: "rule.list", pad: "x".repeat(1600) });
    assert.ok(big.length > 1536);
    const r1 = await rawRequest(dev.url, { method: "POST", path: "/api/v1/command", headers: { "Content-Type": "application/json" }, body: big });
    assert.equal(r1.status, 400);
    assert.match(r1.headers["content-type"] ?? "", /^text\/plain/);
    assert.equal(r1.text, "json");
    const r2 = await rawRequest(dev.url, { method: "POST", path: "/api/v1/command", headers: { "Content-Type": "application/json" } });
    assert.equal(r2.status, 400);
    assert.equal(r2.text, "json");
    const r3 = await rawRequest(dev.url, { method: "POST", path: "/api/v1/command", headers: { "Content-Type": "application/json" }, body: "{nope" });
    assert.equal(r3.status, 400);
    assert.equal(r3.text, "json");
    const r4 = await rawRequest(dev.url, { method: "POST", path: "/api/v1/command", body: JSON.stringify({ cmd: "rule.list", pad: "y".repeat(1400) }) });
    assert.equal(r4.status, 200, "a body just under the limit is fine");
    for (const p of ["/api/v1/pins", "/api/v1/network/wifi", "/api/v1/mqtt"]) {
      assert.equal((await rawRequest(dev.url, { method: "POST", path: p })).status, 400, p);
    }
  });

  it("unknown GET and POST redirect to the captive portal", async () => {
    for (const [method, path] of [["GET", "/nope"], ["GET", "/api/v1/nope"], ["POST", "/api/v1/nope"], ["GET", "/generate_204"]] as const) {
      const r = await fetch(`${dev.url}${path}`, { method, redirect: "manual", ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(r.status, 302, `${method} ${path}`);
      assert.equal(r.headers.get("location"), "http://192.168.4.1/");
      assert.equal(await r.text(), "Redirect to the captive portal");
    }
  });

  it("a known path with the wrong method is 405", async () => {
    assert.equal((await fetch(`${dev.url}/api/v1/status`, { method: "POST", body: "{}" })).status, 405);
    assert.equal((await fetch(`${dev.url}/api/v1/command`)).status, 405);
  });

  it("command errors keep the 200 envelope", async () => {
    failsWith(await cmd(dev, { cmd: "module.remove", id: "nothere" }), "unknown module id");
  });

  it("records requests in requestLog", async () => {
    const count = dev.requestLog.length;
    await get(dev, "/status");
    const e = dev.requestLog[dev.requestLog.length - 1]!;
    assert.equal(dev.requestLog.length, count + 1);
    assert.deepEqual([e.kind, e.method, e.path, e.status], ["http", "GET", "/api/v1/status", 200]);
    assert.equal(result<{ rules: unknown[] }>(await cmd(dev, { cmd: "rule.list" })).rules.length, 0);
  });
});

describe("fake device: serial serving and latency", () => {
  it("a slow network/scan delays every other request, including /status", async () => {
    const dev = await startFakeDevice({ ...FAST, scanDelayMs: 400 });
    try {
      const done: string[] = [];
      const t0 = Date.now();
      const scan = fetchJson(`${dev.url}/api/v1/network/scan`).then(() => done.push("scan"));
      await sleep(60);
      const elapsed = await fetchJson(`${dev.url}/api/v1/status`).then(() => {
        done.push("status");
        return Date.now() - t0;
      });
      await scan;
      assert.deepEqual(done, ["scan", "status"]);
      assert.ok(elapsed >= 380, `status answered after ${elapsed} ms, before the scan finished`);
    } finally {
      await dev.close();
    }
  });

  it("latencyMs is added to each request", async () => {
    const dev = await startFakeDevice({ ...FAST, latencyMs: 120 });
    try {
      const t0 = Date.now();
      await get(dev, "/status");
      assert.ok(Date.now() - t0 >= 110);
    } finally {
      await dev.close();
    }
  });

  it("rejects an invalid id", async () => {
    await assert.rejects(startFakeDevice({ id: "XYZ" }), /12 lowercase hex/);
  });

  it("a closed device refuses connections", async () => {
    const dev = await startFakeDevice({ ...FAST });
    const url = dev.url;
    await dev.close();
    await assert.rejects(fetchJson(`${url}/api/v1/status`));
  });
});
