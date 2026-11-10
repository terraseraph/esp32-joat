import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import type { BrowserWsMessage, DeviceSummary, ErrorResponse } from "../src/types/api";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, level, sleep, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, tmpDataDir, type TestServer } from "./helpers";
import { closedPort, startPlainServer } from "./helpers/net";

const JSON_HEADERS = { "Content-Type": "application/json" };
const send = <T = unknown>(method: string, url: string, body?: unknown) =>
  fetchJson<T>(url, { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = <T = unknown>(url: string, body?: unknown) => send<T>("POST", url, body);

let idCounter = 0;
/** Unique 12-hex-char device id per fake. */
const nextId = (): string => (0xa1b2c3d40000 + ++idCounter).toString(16);
const startFake = (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> =>
  startFakeDevice({ ...FAST, seed: "demo", id: nextId(), ...extra });

function readRegistry(dataDir: string): { devices: Array<Record<string, unknown>>; ignored: string[] } {
  return JSON.parse(readFileSync(path.join(dataDir, "registry.json"), "utf8"));
}

describe("devices API", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const startAndTrack = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> => {
    const d = await startFake(extra);
    fakes.push(d);
    return d;
  };
  const api = (p: string): string => `${srv.base}${p}`;
  const add = async (d: FakeDevice): Promise<DeviceSummary> => {
    const r = await post<DeviceSummary>(api("/api/devices"), { host: `127.0.0.1:${d.port}` });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    return r.body;
  };
  const summary = async (id: string): Promise<DeviceSummary> => (await fetchJson<DeviceSummary>(api(`/api/devices/${id}`))).body;
  const refresh = async (id: string): Promise<DeviceSummary> => (await post<DeviceSummary>(api(`/api/devices/${id}/refresh`))).body;

  before(async () => {
    srv = await startTestServer({ pollIntervalMs: 60_000, pollTimeoutMs: 400, rebootWindowMs: 5000, registrySaveDebounceMs: 40 });
  });
  after(async () => {
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
  });

  // ---- manual add -----------------------------------------------------------------------------------------

  test("manual add: 201 with a summary, 200 for the same device again, listed and fetchable", async () => {
    const dev = await startAndTrack({ name: "Bench node" });
    const r1 = await post<DeviceSummary>(api("/api/devices"), { host: `127.0.0.1:${dev.port}` });
    assert.equal(r1.status, 201);
    const s = r1.body;
    assert.equal(s.id, dev.id);
    assert.equal(s.name, "Bench node");
    assert.equal(s.host, `127.0.0.1:${dev.port}`);
    assert.equal(s.addedVia, "manual");
    assert.equal(s.health, "online");
    assert.equal(s.label, "");
    assert.deepEqual(s.attention, []);
    assert.match(s.lastSeen ?? "", /^\d{4}-\d\d-\d\dT/);
    assert.equal(typeof s.fw, "string");
    assert.equal(typeof s.uptime_s, "number");
    assert.equal(s.boot_state, "healthy");
    assert.equal(s.safe_mode, false);
    assert.equal(s.fwMatchesTarget, null);
    assert.equal(s.link, "closed");
    assert.equal(s.queue, 0);
    assert.equal(typeof s.memory.total, "number");
    assert.equal(s.memory.pressure, "ok");
    assert.equal(typeof s.mqtt.configured, "boolean");
    assert.equal(typeof s.ota.running_partition, "string");
    assert.ok((s.io_count ?? 0) > 0, "demo seed has configured pins");
    assert.equal(typeof s.module_count, "number");

    const r2 = await post<DeviceSummary>(api("/api/devices"), { host: `http://127.0.0.1:${dev.port}/` });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.id, dev.id);

    const list = await fetchJson<DeviceSummary[]>(api("/api/devices"));
    assert.equal(list.status, 200);
    assert.equal(list.body.filter((d) => d.id === dev.id).length, 1);
    assert.deepEqual((await fetchJson<DeviceSummary>(api(`/api/devices/${dev.id}`))).body.id, dev.id);
  });

  test("manual add by hostname stores the resolved IP and re-adds the same device", async () => {
    const dev = await startAndTrack();
    const r1 = await post<DeviceSummary>(api("/api/devices"), { host: `localhost:${dev.port}` });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.host, `127.0.0.1:${dev.port}`);
    const r2 = await post<DeviceSummary>(api("/api/devices"), { host: `127.0.0.1:${dev.port}` });
    assert.equal(r2.status, 200);
  });

  test("manual add errors: invalid_host, device_unreachable, probe_timeout, captive_redirect, not_de_esp32", async () => {
    const add = (host: string) => post<ErrorResponse>(api("/api/devices"), { host });
    const bad = await add("http://192.168.1.5/status");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_host");
    assert.equal((await post<ErrorResponse>(api("/api/devices"), {})).body.code, "invalid_body");
    assert.equal((await add("")).status, 400);

    const port = await closedPort();
    const refused = await add(`127.0.0.1:${port}`);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, "device_unreachable");
    assert.ok(refused.body.error.includes(`127.0.0.1:${port}`), "message names the host");

    const hung = await startAndTrack();
    await hung.goOffline("hang");
    const t = await add(`127.0.0.1:${hung.port}`);
    assert.equal(t.status, 422);
    assert.equal(t.body.code, "probe_timeout");
    assert.ok(t.body.error.includes(`127.0.0.1:${hung.port}`));

    const portal = await startPlainServer((_req, res) => {
      res.writeHead(302, { Location: "http://192.168.4.1/" });
      res.end();
    });
    const c = await add(portal.host);
    assert.equal(c.status, 422);
    assert.equal(c.body.code, "captive_redirect");
    assert.match(c.body.error, /redirects to http:\/\/192\.168\.4\.1\/ — this looks like a device in setup mode or another captive portal/);
    await portal.close();

    const web = await startPlainServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
    });
    const n = await add(web.host);
    assert.equal(n.status, 422);
    assert.equal(n.body.code, "not_de_esp32");
    await web.close();

    const text = await startPlainServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("nope");
    });
    assert.equal((await add(text.host)).body.code, "not_de_esp32");
    await text.close();

  });

  test("a status that is JSON but fails the fingerprint is not_de_esp32", async () => {
    const fake = await startPlainServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "a1b2c3d4e5f6", name: "pretender", hostname: "my-box" }));
    });
    const r = await post<ErrorResponse>(api("/api/devices"), { host: fake.host });
    assert.equal(r.body.code, "not_de_esp32");
    await fake.close();
  });

  test("unknown device ids are 404 unknown_device on every device route", async () => {
    const id = "ffffffffffff";
    const calls: Array<[string, string, unknown?]> = [
      ["GET", `/api/devices/${id}`],
      ["PATCH", `/api/devices/${id}`, { label: "x" }],
      ["DELETE", `/api/devices/${id}`],
      ["POST", `/api/devices/${id}/refresh`],
      ["POST", `/api/devices/${id}/command`, { cmd: "pin.set" }],
      ["GET", `/api/devices/${id}/v1/status`],
      ["POST", `/api/devices/${id}/v1/command`, { cmd: "pin.set" }],
    ];
    for (const [m, p, b] of calls) {
      const r = await send<ErrorResponse>(m, api(p), b);
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.equal(r.body.code, "unknown_device");
    }
  });

  // ---- PATCH / DELETE ----------------------------------------------------------------------------------------

  test("PATCH label/notes/host, validation, and DELETE (forget only)", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    const p1 = await send<DeviceSummary>("PATCH", api(`/api/devices/${id}`), { label: "  Garage door  ", notes: "behind the shelf" });
    assert.equal(p1.status, 200);
    assert.equal(p1.body.label, "Garage door");
    assert.equal(p1.body.notes, "behind the shelf");
    assert.equal((await send<DeviceSummary>("PATCH", api(`/api/devices/${id}`), {})).status, 200);

    assert.equal((await send<ErrorResponse>("PATCH", api(`/api/devices/${id}`), { label: "x".repeat(65) })).body.code, "invalid_body");
    assert.equal((await send<ErrorResponse>("PATCH", api(`/api/devices/${id}`), { notes: "x".repeat(2001) })).body.code, "invalid_body");
    assert.equal((await send<ErrorResponse>("PATCH", api(`/api/devices/${id}`), { color: "red" })).body.code, "invalid_body");
    const badHost = await send<ErrorResponse>("PATCH", api(`/api/devices/${id}`), { host: "http://1.2.3.4/x" });
    assert.equal(badHost.status, 400);
    assert.equal(badHost.body.code, "invalid_host");
    assert.equal((await summary(id)).label, "Garage door");

    const before = dev.requestLog.length;
    const del = await fetchJson(api(`/api/devices/${id}`), { method: "DELETE" });
    assert.equal(del.status, 204);
    assert.equal((await fetchJson<ErrorResponse>(api(`/api/devices/${id}`))).status, 404);
    assert.equal(dev.requestLog.length, before, "forgetting never touches the device");
    await waitUntil(() => !readRegistry(srv.dataDir).devices.some((d) => d.id === id), 2000, "registry save");
  });

  test("the list is sorted by title (label, else name), case-insensitively", async () => {
    const a = await startAndTrack({ name: "zulu" });
    const b = await startAndTrack({ name: "Alpha" });
    const c = await startAndTrack({ name: "mike" });
    const [sa, sb, sc] = [await add(a), await add(b), await add(c)];
    await send("PATCH", api(`/api/devices/${sc.id}`), { label: "Aaa first" });
    const list = (await fetchJson<DeviceSummary[]>(api("/api/devices"))).body.filter((d) => [sa.id, sb.id, sc.id].includes(d.id));
    assert.deepEqual(
      list.map((d) => d.label || d.name),
      ["Aaa first", "Alpha", "zulu"],
    );
    for (const s of [sa, sb, sc]) await fetchJson(api(`/api/devices/${s.id}`), { method: "DELETE" });
  });

  // ---- health -----------------------------------------------------------------------------------------------

  test("health: kill the fake -> unreachable after 1 poll -> offline after 2; goOnline -> online", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    assert.equal((await summary(id)).health, "online");
    await dev.goOffline("refuse");
    const s1 = await refresh(id);
    assert.equal(s1.health, "unreachable");
    assert.ok(s1.fw, "cached values are kept while offline");
    assert.ok(s1.lastSeen);
    assert.equal((await refresh(id)).health, "offline");
    assert.equal((await refresh(id)).health, "offline");
    await dev.goOnline();
    const back = await refresh(id);
    assert.equal(back.health, "online");
    assert.equal(back.id, id);
  });

  test("health: a hung device times out (unreachable), then recovers", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    await dev.goOffline("hang");
    const t0 = Date.now();
    assert.equal((await refresh(id)).health, "unreachable");
    assert.ok(Date.now() - t0 >= 350, "waited for the poll timeout");
    await dev.goOnline();
    assert.equal((await refresh(id)).health, "online");
  });

  test("health: a device answering as a different id is a failure with host_mismatch", async () => {
    const a = await startAndTrack();
    const b = await startAndTrack();
    const { id } = await add(a);
    const patched = await send<DeviceSummary>("PATCH", api(`/api/devices/${id}`), { host: `127.0.0.1:${b.port}` });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.health, "unreachable");
    assert.ok(patched.body.attention.includes("host_mismatch"));
    assert.equal(patched.body.name, a.state.name, "the other device's name did not overwrite ours");
    const again = await refresh(id);
    assert.equal(again.health, "offline");
    assert.ok(again.attention.includes("host_mismatch"));

    const fixed = await send<DeviceSummary>("PATCH", api(`/api/devices/${id}`), { host: `127.0.0.1:${a.port}` });
    assert.equal(fixed.body.health, "online");
    assert.ok(!fixed.body.attention.includes("host_mismatch"));
  });

  test("attention flags follow the status exactly (spec 3.4)", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    assert.deepEqual((await summary(id)).attention, []);

    dev.state.mqtt.connected = false;
    dev.state.memory.pressure = "warn";
    dev.state.memory.alloc_failed = true;
    dev.state.ota.image_state = "pending_verify";
    dev.state.ota.session = "error";
    dev.state.network.state = "apsta_recovery";
    dev.state.boot_state = "diagnostics";
    const flags = (await refresh(id)).attention;
    for (const f of ["boot_unhealthy", "memory_pressure", "alloc_failed", "ota_pending_verify", "ota_error", "mqtt_disconnected", "wifi_recovery"]) {
      assert.ok(flags.includes(f as never), `missing ${f} in ${flags.join(",")}`);
    }
    assert.ok(!flags.includes("safe_mode"));

    // MQTT never configured is NOT an attention flag
    dev.state.mqtt.uri = "";
    assert.ok(!(await refresh(id)).attention.includes("mqtt_disconnected"));
  });

  test("a device in safe mode raises safe_mode (and boot_unhealthy)", async () => {
    const dev = await startAndTrack({ safeMode: true });
    const s = await add(dev);
    assert.equal(s.safe_mode, true);
    assert.ok(s.safe_reason);
    assert.ok(s.attention.includes("safe_mode"));
    assert.ok(s.attention.includes("boot_unhealthy"));
  });

  test("an MQTT-configured but disconnected device raises mqtt_disconnected", async () => {
    const dev = await startAndTrack({ mqtt: { uri: "mqtt://192.168.1.10:1883", root: "devices", connected: false } });
    const s = await add(dev);
    assert.equal(s.mqtt.configured, true);
    assert.equal(s.mqtt.connected, false);
    assert.ok(s.attention.includes("mqtt_disconnected"));
  });

  // ---- command -------------------------------------------------------------------------------------------------

  test("POST /command returns the device envelope unchanged (ok true and ok false are both HTTP 200)", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    const ok = await post<{ v: number; ok: boolean; corr?: string; result?: { gpio: number; value: number } }>(api(`/api/devices/${id}/command`), {
      cmd: "pin.configure",
      pin: { gpio: 4, mode: "out" },
      corr: "c-1",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.corr, "c-1");
    const set = await post<{ ok: boolean; result: { gpio: number; value: number } }>(api(`/api/devices/${id}/command`), { cmd: "pin.set", gpio: 4, value: 1 });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body, { v: 1, ok: true, result: { gpio: 4, value: 1 } });
    assert.equal(await level(dev, "gpio_4"), 1);

    const fail = await post<{ v: number; ok: boolean; error: string }>(api(`/api/devices/${id}/command`), { cmd: "no.such.command" });
    assert.equal(fail.status, 200);
    assert.equal(fail.body.ok, false);
    assert.equal(typeof fail.body.error, "string");
  });

  test("POST /command validates `cmd`, refuses oversize bodies locally, and reports transport failures as 502", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    assert.equal((await post<ErrorResponse>(api(`/api/devices/${id}/command`), { gpio: 4 })).body.code, "invalid_body");
    assert.equal((await post<ErrorResponse>(api(`/api/devices/${id}/command`), { cmd: 5 })).body.code, "invalid_body");

    const before = dev.requestLog.length;
    const big = await post<ErrorResponse>(api(`/api/devices/${id}/command`), { cmd: "mqtt.configure", uri: "mqtt://x/" + "a".repeat(1600) });
    assert.equal(big.status, 413);
    assert.equal(big.body.code, "body_too_large_for_device");
    assert.match(big.body.error, /1536/);
    assert.equal(dev.requestLog.length, before, "never sent");

    await dev.goOffline("refuse");
    const down = await post<{ ok: boolean; error: string; code: string; transport: boolean }>(api(`/api/devices/${id}/command`), { cmd: "pin.set", gpio: 4, value: 1 });
    assert.equal(down.status, 502);
    assert.equal(down.body.ok, false);
    assert.equal(down.body.transport, true);
    assert.match(down.body.code, /^device_(unreachable|reset)$/);
    assert.ok(down.body.error.length > 5);
    await dev.goOnline();

  });

  test("successful pin.configure updates the stored pin shadow; mode disabled removes it; identity.set_name updates the name", async () => {
    const dev = await startAndTrack({ seed: "empty" });
    const { id } = await add(dev);
    const shadow = (): Record<string, unknown> => (readRegistry(srv.dataDir).devices.find((d) => d.id === id)?.pinShadow ?? {}) as Record<string, unknown>;

    const r = await post<{ ok: boolean }>(api(`/api/devices/${id}/command`), { cmd: "pin.configure", pin: { gpio: 5, mode: "out", invert: true, boot: 1 } });
    assert.equal(r.body.ok, true);
    await waitUntil(() => "5" in shadow(), 2000, "pin shadow saved");
    assert.deepEqual(shadow()["5"], { gpio: 5, mode: "out", invert: true, boot: 1 }, "the minimal object that was sent");

    // fields at top level (the other documented form)
    await post(api(`/api/devices/${id}/command`), { cmd: "pin.configure", gpio: 16, mode: "in", pull_up: true });
    await waitUntil(() => "16" in shadow(), 2000, "top-level pin shadow");
    assert.deepEqual(shadow()["16"], { gpio: 16, mode: "in", pull_up: true });

    // a failed configure leaves it alone
    const bad = await post<{ ok: boolean }>(api(`/api/devices/${id}/command`), { cmd: "pin.configure", pin: { gpio: 5, mode: "bogus" } });
    assert.equal(bad.body.ok, false);
    await sleep(100);
    assert.equal((shadow()["5"] as { mode: string }).mode, "out");

    await post(api(`/api/devices/${id}/command`), { cmd: "pin.configure", pin: { gpio: 5, mode: "disabled" } });
    await waitUntil(() => !("5" in shadow()), 2000, "shadow entry removed");
    assert.ok("16" in shadow());

    const renamed = await post<{ ok: boolean; result: { name: string } }>(api(`/api/devices/${id}/command`), { cmd: "identity.set_name", name: "Porch light" });
    assert.equal(renamed.body.ok, true);
    assert.equal((await summary(id)).name, "Porch light", "no need to wait for the next poll");
  });

  // ---- proxy ---------------------------------------------------------------------------------------------------

  test("GET v1/* is a passthrough (status, pins, query string, JSON body unchanged)", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    const direct = await fetchJson<Record<string, unknown>>(`${dev.url}/api/v1/status`);
    const proxied = await fetchJson<Record<string, unknown>>(api(`/api/devices/${id}/v1/status`));
    assert.equal(proxied.status, 200);
    assert.match(proxied.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(proxied.body.id, direct.body.id);
    assert.equal(proxied.body.hostname, direct.body.hostname);
    assert.deepEqual(Object.keys(proxied.body).sort(), Object.keys(direct.body).sort());

    const pins = await fetchJson<Record<string, unknown>>(api(`/api/devices/${id}/v1/pins`));
    assert.equal(pins.status, 200);
    assert.ok(Object.keys(pins.body).some((k) => k.startsWith("gpio_")));
    assert.equal((await fetchJson(api(`/api/devices/${id}/v1/openapi.json?x=1`))).status, 200);
    assert.equal((await fetchJson<unknown[]>(api(`/api/devices/${id}/v1/network/scan`))).status, 200);
  });

  test("POST v1/command and v1/pins pass bodies through and return the device's reply", async () => {
    const dev = await startAndTrack({ seed: "empty" });
    const { id } = await add(dev);
    const cfg = await post<{ v: number; ok: boolean }>(api(`/api/devices/${id}/v1/pins`), { gpio: 17, mode: "out" });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.ok, true);
    const set = await post<{ ok: boolean; result: { value: number } }>(api(`/api/devices/${id}/v1/command`), { cmd: "pin.set", gpio: 17, value: 1 });
    assert.deepEqual(set.body, { v: 1, ok: true, result: { gpio: 17, value: 1 } });
    assert.equal(await level(dev, "gpio_17"), 1);
    // the passthrough applies the same shadow rule
    await waitUntil(() => "17" in ((readRegistry(srv.dataDir).devices.find((d) => d.id === id)?.pinShadow ?? {}) as object), 2000, "shadow via proxy");
  });

  test("POST v1/*: oversize bodies are refused locally (413), v1/ota and v1/ws are refused, unknown routes are a 502 captive_redirect", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    const before = dev.requestLog.length;
    const big = await post<ErrorResponse>(api(`/api/devices/${id}/v1/command`), { cmd: "mqtt.configure", uri: "x".repeat(1700) });
    assert.equal(big.status, 413);
    assert.equal(big.body.code, "body_too_large_for_device");
    assert.equal(dev.requestLog.length, before);

    const ota = await post<ErrorResponse>(api(`/api/devices/${id}/v1/ota`), { x: 1 });
    assert.equal(ota.status, 400);
    assert.equal(ota.body.code, "use_ota_endpoint");
    const ws = await fetchJson<ErrorResponse>(api(`/api/devices/${id}/v1/ws`));
    assert.equal(ws.status, 400);
    assert.equal(dev.requestLog.length, before);

    const odd = await fetchJson<{ ok: boolean; code: string; transport: boolean }>(api(`/api/devices/${id}/v1/no/such/route`));
    assert.equal(odd.status, 502);
    assert.equal(odd.body.code, "device_captive_redirect");
    assert.equal(odd.body.transport, true);

    const evil = await fetchJson<ErrorResponse>(api(`/api/devices/${id}/v1/..%2Fx`));
    assert.equal(evil.status, 400);
  });

  test("passthrough: the device's own error status is kept, and transport failures are 502 {ok:false,transport:true}", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    // an empty POST body: the device answers 400 text "json"; status and body come back unchanged
    const raw = await fetch(api(`/api/devices/${id}/v1/command`), { method: "POST", headers: JSON_HEADERS, body: "" });
    assert.equal(raw.status, 400);
    assert.equal((await raw.text()).trim(), "json");

    await dev.goOffline("refuse");
    const down = await fetchJson<{ ok: boolean; error: string; code: string; transport: boolean }>(api(`/api/devices/${id}/v1/status`));
    assert.equal(down.status, 502);
    assert.equal(down.body.ok, false);
    assert.equal(down.body.transport, true);
    assert.equal(down.body.code, "device_unreachable");
    await dev.goOnline();
  });

  test("system.reboot through the proxy and the command route: expectedRestart, then recovers", async () => {
    const dev = await startAndTrack();
    const { id } = await add(dev);
    const viaProxy = await post<{ ok: boolean; result: { expectedRestart: boolean } }>(api(`/api/devices/${id}/v1/system/reboot`));
    assert.deepEqual(viaProxy.body, { v: 1, ok: true, result: { expectedRestart: true } });
    assert.equal((await summary(id)).health, "rebooting");
    await waitUntil(async () => (await refresh(id)).health === "online", 4000, "device back after reboot");
  });

  // ---- queue ------------------------------------------------------------------------------------------------------

  test("requests to one device are serialised and `queue` shows the depth", async () => {
    const dev = await startAndTrack({ scanDelayMs: 300 });
    const { id } = await add(dev);
    const scan = fetchJson(api(`/api/devices/${id}/v1/network/scan`));
    await waitUntil(async () => (await summary(id)).queue >= 1, 1000, "scan queued");
    const t0 = Date.now();
    const status = await fetchJson(api(`/api/devices/${id}/v1/status`));
    assert.equal(status.status, 200);
    assert.ok(Date.now() - t0 >= 150, "status waited behind the slow scan");
    await scan;
    assert.equal((await summary(id)).queue, 0);
  });
});

describe("reboot handling", () => {
  let srv: TestServer;
  let dev: FakeDevice;
  before(async () => {
    srv = await startTestServer({ pollIntervalMs: 120, pollTimeoutMs: 300, rebootWindowMs: 4000, registrySaveDebounceMs: 30 });
    dev = await startFake({ rebootMs: 500 });
  });
  after(async () => {
    await srv.close();
    await dev.close();
  });

  test("system.reboot via /command: ok+expectedRestart, health rebooting, then online again by polling", async () => {
    const added = await post<DeviceSummary>(`${srv.base}/api/devices`, { host: `127.0.0.1:${dev.port}` });
    const id = added.body.id;
    const r = await post<{ v: number; ok: boolean; result: { expectedRestart: boolean } }>(`${srv.base}/api/devices/${id}/command`, { cmd: "system.reboot" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { v: 1, ok: true, result: { expectedRestart: true } });
    const during = (await fetchJson<DeviceSummary>(`${srv.base}/api/devices/${id}`)).body;
    assert.equal(during.health, "rebooting");
    await sleep(250); // polls fail meanwhile but the state stays rebooting
    assert.equal((await fetchJson<DeviceSummary>(`${srv.base}/api/devices/${id}`)).body.health, "rebooting");
    await waitUntil(async () => (await fetchJson<DeviceSummary>(`${srv.base}/api/devices/${id}`)).body.health === "online", 4000, "online after reboot");
    assert.ok(((await fetchJson<DeviceSummary>(`${srv.base}/api/devices/${id}`)).body.uptime_s ?? 99) < 5);
  });

  test("timer-driven polling: offline detection and recovery without any refresh calls", async () => {
    const d2 = await startFake();
    const added = await post<DeviceSummary>(`${srv.base}/api/devices`, { host: `127.0.0.1:${d2.port}` });
    const id = added.body.id;
    const state = async (): Promise<string> => (await fetchJson<DeviceSummary>(`${srv.base}/api/devices/${id}`)).body.health;
    await d2.goOffline("refuse");
    await waitUntil(async () => (await state()) === "offline", 3000, "offline by polling");
    await d2.goOnline();
    await waitUntil(async () => (await state()) === "online", 3000, "online by polling");
    await d2.close();
  });

  test("the rebooting window ends: a device that never comes back becomes offline", async () => {
    const short = await startTestServer({ pollIntervalMs: 80, pollTimeoutMs: 200, rebootWindowMs: 300 });
    const d3 = await startFake({ rebootMs: 60_000 });
    try {
      const id = (await post<DeviceSummary>(`${short.base}/api/devices`, { host: `127.0.0.1:${d3.port}` })).body.id;
      await post(`${short.base}/api/devices/${id}/command`, { cmd: "system.reboot" });
      assert.equal((await fetchJson<DeviceSummary>(`${short.base}/api/devices/${id}`)).body.health, "rebooting");
      await waitUntil(async () => (await fetchJson<DeviceSummary>(`${short.base}/api/devices/${id}`)).body.health === "offline", 3000, "offline after the window");
    } finally {
      await short.close();
      await d3.close();
    }
  });
});

describe("persistence across Manager restarts", () => {
  test("the registry survives a restart; the device shows up (cached first, then online)", async () => {
    const dev = await startFake({ name: "Persistent one" });
    const first = await startTestServer({ pollIntervalMs: 60_000, pollTimeoutMs: 400 });
    const dataDir = first.dataDir;
    const added = await post<DeviceSummary>(`${first.base}/api/devices`, { host: `127.0.0.1:${dev.port}` });
    assert.equal(added.status, 201);
    const id = added.body.id;
    await send("PATCH", `${first.base}/api/devices/${id}`, { label: "Kept label", notes: "kept notes" });
    await first.close(); // flushes the debounced save (the default window is 1 s; the test never waited for it)
    assert.equal(readRegistry(dataDir).devices.length, 1);

    const second = await startTestServer({ dataDir, pollIntervalMs: 60_000, pollTimeoutMs: 400 });
    try {
      const list = (await fetchJson<DeviceSummary[]>(`${second.base}/api/devices`)).body;
      assert.equal(list.length, 1);
      const s = list[0] as DeviceSummary;
      assert.equal(s.id, id);
      assert.equal(s.label, "Kept label");
      assert.equal(s.notes, "kept notes");
      assert.equal(s.name, "Persistent one");
      assert.ok(s.fw, "cached values render before the first poll");
      assert.equal(s.addedVia, "manual");
      await waitUntil(async () => (await fetchJson<DeviceSummary>(`${second.base}/api/devices/${id}`)).body.health === "online", 3000, "start-up poll");
    } finally {
      await second.close();
      await dev.close();
    }
  });

  test("with the device gone the cached summary is served as offline after start-up polls", async () => {
    const dev = await startFake();
    const first = await startTestServer({ pollIntervalMs: 60_000, pollTimeoutMs: 400 });
    const id = (await post<DeviceSummary>(`${first.base}/api/devices`, { host: `127.0.0.1:${dev.port}` })).body.id;
    await first.close();
    await dev.close();
    const second = await startTestServer({ dataDir: first.dataDir, pollIntervalMs: 100, pollTimeoutMs: 300 });
    try {
      const s0 = (await fetchJson<DeviceSummary>(`${second.base}/api/devices/${id}`)).body;
      assert.ok(["unknown", "unreachable", "offline"].includes(s0.health));
      assert.ok(s0.fw);
      await waitUntil(async () => (await fetchJson<DeviceSummary>(`${second.base}/api/devices/${id}`)).body.health === "offline", 3000, "offline");
    } finally {
      await second.close();
    }
  });

  test("a corrupt registry.json is set aside and the server starts empty", async () => {
    const dataDir = tmpDataDir();
    writeFileSync(path.join(dataDir, "registry.json"), "{ broken");
    const s = await startTestServer({ dataDir });
    try {
      assert.deepEqual((await fetchJson<unknown[]>(`${s.base}/api/devices`)).body, []);
      assert.ok(readdirSync(dataDir).some((f) => f.startsWith("registry.json.corrupt-")));
      assert.equal(existsSync(path.join(dataDir, "registry.json")), false);
    } finally {
      await s.close();
    }
  });
});

describe("browser WebSocket device messages", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ pollIntervalMs: 60_000, pollTimeoutMs: 400 });
  });
  after(() => srv.close());

  function connect(): Promise<{ ws: WebSocket; msgs: BrowserWsMessage[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/ws`);
      const msgs: BrowserWsMessage[] = [];
      ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as BrowserWsMessage));
      ws.once("open", () => resolve({ ws, msgs }));
      ws.once("error", reject);
    });
  }

  test("connect: hello then devices; health changes push `device`; forgetting pushes `deviceRemoved`", async () => {
    const dev = await startFake();
    const id = (await post<DeviceSummary>(`${srv.base}/api/devices`, { host: `127.0.0.1:${dev.port}` })).body.id;
    const { ws, msgs } = await connect();
    try {
      await waitUntil(() => msgs.length >= 2, 2000, "hello + devices");
      assert.equal(msgs[0]?.t, "hello");
      const devices = msgs[1];
      assert.equal(devices?.t, "devices");
      if (devices?.t !== "devices") return;
      assert.equal(devices.list.length, 1);
      assert.equal(devices.list[0]?.id, id);
      assert.equal(devices.list[0]?.health, "online");

      await dev.goOffline("refuse");
      await post(`${srv.base}/api/devices/${id}/refresh`);
      await waitUntil(() => msgs.some((m) => m.t === "device" && m.id === id && m.summary.health === "unreachable"), 2000, "device push");

      // bursts are coalesced: several quick PATCHes, far fewer pushes
      const pushesBefore = msgs.filter((m) => m.t === "device").length;
      for (let i = 0; i < 5; i++) await send("PATCH", `${srv.base}/api/devices/${id}`, { notes: `n${i}` });
      await sleep(350);
      const pushes = msgs.filter((m) => m.t === "device").length - pushesBefore;
      assert.ok(pushes >= 1 && pushes <= 2, `expected a coalesced push, got ${pushes}`);
      const last = [...msgs].reverse().find((m) => m.t === "device");
      assert.equal(last?.t === "device" ? last.summary.notes : null, "n4");

      await fetchJson(`${srv.base}/api/devices/${id}`, { method: "DELETE" });
      await waitUntil(() => msgs.some((m) => m.t === "deviceRemoved" && m.id === id), 2000, "deviceRemoved");
    } finally {
      ws.close();
      await dev.close();
    }
  });

  test("a new device is announced with a `device` push; a `cmd` message is answered with a cmdResult", async () => {
    const { ws, msgs } = await connect();
    const dev = await startFake();
    try {
      await waitUntil(() => msgs.length >= 2, 2000, "hello + devices");
      const id = (await post<DeviceSummary>(`${srv.base}/api/devices`, { host: `127.0.0.1:${dev.port}` })).body.id;
      await waitUntil(() => msgs.some((m) => m.t === "device" && m.id === id), 2000, "added push");

      ws.send(JSON.stringify({ t: "cmd", id, corr: "c-9", body: { cmd: "pin.set", gpio: 4, value: 1 } }));
      ws.send(JSON.stringify({ t: "watch", ids: [id] }));
      await waitUntil(() => msgs.some((m) => m.t === "cmdResult"), 2000, "cmdResult");
      const res = msgs.find((m) => m.t === "cmdResult");
      assert.equal(res?.t === "cmdResult" ? res.corr : null, "c-9");
      assert.equal(res?.t === "cmdResult" ? res.res.ok : null, true);
      await fetchJson(`${srv.base}/api/devices/${id}`, { method: "DELETE" });
    } finally {
      ws.close();
      await dev.close();
    }
  });
});

describe("settings API", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ lan: true, host: "127.0.0.1" });
  });
  after(() => srv.close());
  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${srv.token}`, ...JSON_HEADERS });

  test("GET returns the defaults and never the LAN token; PUT is a validated partial update that persists", async () => {
    const g = await fetchJson<Record<string, unknown>>(`${srv.base}/api/settings`, { headers: auth() });
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, { pollIntervalS: 30, discoveryTargets: [], extraSubnets: [], backgroundScan: { enabled: false, periodMin: 5 }, firmwareBaseUrl: "https://terraseraph.github.io/esp32-joat/", defaultParallelUpdates: 2 });
    assert.ok(!JSON.stringify(g.body).includes(srv.token ?? "never"));

    const put = await fetchJson<Record<string, unknown>>(`${srv.base}/api/settings`, { method: "PUT", headers: auth(), body: JSON.stringify({ pollIntervalS: 60 }) });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { pollIntervalS: 60, discoveryTargets: [], extraSubnets: [], backgroundScan: { enabled: false, periodMin: 5 }, firmwareBaseUrl: "https://terraseraph.github.io/esp32-joat/", defaultParallelUpdates: 2 });
    assert.equal(((await fetchJson(`${srv.base}/api/settings`, { headers: auth() })).body as { pollIntervalS: number }).pollIntervalS, 60);

    const onDisk = JSON.parse(readFileSync(path.join(srv.dataDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.pollIntervalS, 60);
    assert.equal(onDisk.lanToken, srv.token, "the token is preserved by a settings update");

    const empty = await fetchJson(`${srv.base}/api/settings`, { method: "PUT", headers: auth(), body: "{}" });
    assert.equal((empty.body as { pollIntervalS: number }).pollIntervalS, 60);
  });

  test("validation: range 10-300, integers, unknown keys (lanToken!) rejected", async () => {
    const put = (body: unknown) => fetchJson<ErrorResponse>(`${srv.base}/api/settings`, { method: "PUT", headers: auth(), body: JSON.stringify(body) });
    for (const bad of [{ pollIntervalS: 9 }, { pollIntervalS: 301 }, { pollIntervalS: 30.5 }, { pollIntervalS: "30" }, { lanToken: "stolen" }, { other: 1 }]) {
      const r = await put(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.code, "invalid_body");
    }
    assert.equal((await put({ pollIntervalS: 10 })).status, 200);
    assert.equal((await put({ pollIntervalS: 300 })).status, 200);
    const onDisk = JSON.parse(readFileSync(path.join(srv.dataDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.lanToken, srv.token);
  });
});
