import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import { createDevicePool } from "../src/device/client";
import { createHealthService } from "../src/device/health";
import { createDiscoveryService, type DiscoveryService } from "../src/discovery";
import type { MdnsFactory, MdnsLike, MdnsPacket } from "../src/discovery/mdns";
import { createRegistry } from "../src/store/registry";
import { createSettingsService } from "../src/store/settings";
import type { AdoptResponse, BrowserWsMessage, DeviceSummary, DiscoveryResult, DiscoveryState, ErrorResponse, SettingsResponse } from "../src/types/api";
import type { StartOptions } from "../src/app";
import { createBrowserHub } from "../src/ws/browserHub";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, sleep, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, tmpDataDir, type TestServer } from "./helpers";
import { closedPort, startPlainServer } from "./helpers/net";

const JSON_HEADERS = { "Content-Type": "application/json" };
const send = <T = unknown>(method: string, url: string, body?: unknown) =>
  fetchJson<T>(url, { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = <T = unknown>(url: string, body?: unknown) => send<T>("POST", url, body);

let idCounter = 0;
const nextId = (): string => (0xd1e5c0000000 + ++idCounter).toString(16);
const startFake = (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> => startFakeDevice({ ...FAST, seed: "demo", id: nextId(), ...extra });
const tgt = (d: FakeDevice): string => `127.0.0.1:${d.port}`;

/** A TCP server that accepts connections and never answers (a hung host). */
function startBlackHole(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s);
      s.on("error", () => {});
      s.on("close", () => sockets.delete(s));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            for (const s of sockets) s.destroy();
          }),
      }),
    );
  });
}

const SERVER_OPTS = { pollIntervalMs: 60_000, pollTimeoutMs: 400, registrySaveDebounceMs: 40 };
const DISC = { mdns: false as const, interfaces: () => [], probeTimeoutMs: 400 };

describe("discovery API: targets, classification, adopt, ignore", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const track = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> => {
    const d = await startFake(extra);
    fakes.push(d);
    return d;
  };
  const api = (p: string): string => `${srv.base}${p}`;
  const state = async (): Promise<DiscoveryState> => (await fetchJson<DiscoveryState>(api("/api/discovery"))).body;
  /** Start a scan (mdns and sweep off unless given) and wait until it is not running. */
  const scan = async (body: Record<string, unknown> = {}): Promise<DiscoveryState> => {
    const r = await post<DiscoveryState>(api("/api/discovery/scan"), { mdns: false, sweep: false, ...body });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.running, true);
    await waitUntil(async () => !(await state()).running, 8000, "scan to finish");
    return state();
  };
  const devices = async (): Promise<DeviceSummary[]> => (await fetchJson<DeviceSummary[]>(api("/api/devices"))).body;
  const byId = (s: DiscoveryState, id: string): DiscoveryResult | undefined => s.results.find((r) => r.id === id);

  before(async () => {
    srv = await startTestServer({ ...SERVER_OPTS, discovery: DISC });
  });
  after(async () => {
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
  });

  test("before any scan: idle, empty; cancel without a scan is a 200", async () => {
    const s = await state();
    assert.equal(s.running, false);
    assert.equal(s.phase, "idle");
    assert.equal(s.startedAt, null);
    assert.deepEqual(s.results, []);
    const c = await post<DiscoveryState>(api("/api/discovery/cancel"));
    assert.equal(c.status, 200);
    assert.equal(c.body.phase, "idle");
  });

  test("a fake device found through a request target is `new`; adopt makes it `known` on the next scan; manual addedVia", async () => {
    const dev = await track({ name: "Bench node" });
    const s = await scan({ targets: [tgt(dev)] });
    assert.equal(s.phase, "done");
    assert.equal(s.running, false);
    assert.ok(s.startedAt && s.finishedAt);
    assert.equal(s.probed, s.total);
    const r = byId(s, dev.id);
    assert.ok(r, JSON.stringify(s.results));
    assert.equal(r.classification, "new");
    assert.equal(r.host, tgt(dev));
    assert.equal(r.via, "target");
    assert.equal(r.name, "Bench node");
    assert.equal(r.setup, false);
    assert.equal(r.netState, "sta_connected");
    assert.ok(r.hostname.startsWith("esp32-"));
    assert.ok(r.fw !== undefined && r.lastSeen);
    assert.equal(r.ipChanged, undefined);
    assert.equal((await devices()).length, 0, "scanning never adds devices by itself");

    const adopt = await post<AdoptResponse>(api("/api/discovery/adopt"), { ids: [dev.id, "ffffffffffff", dev.id.toUpperCase()] });
    assert.equal(adopt.status, 200);
    assert.deepEqual(adopt.body.added.map((a) => a.id), [dev.id]);
    assert.equal(adopt.body.added[0]?.addedVia, "manual", "found only through a typed target");
    assert.equal(adopt.body.added[0]?.host, tgt(dev));
    assert.equal(adopt.body.added[0]?.health, "online", "adopt polls the device");
    assert.deepEqual(adopt.body.skipped, [{ id: "ffffffffffff", reason: "unknown_id" }]);

    assert.equal(byId(await state(), dev.id)?.classification, "known", "reclassified at once");
    const again = await post<AdoptResponse>(api("/api/discovery/adopt"), { ids: [dev.id] });
    assert.deepEqual(again.body, { added: [], skipped: [{ id: dev.id, reason: "already_known" }] });

    const s2 = await scan({ targets: [tgt(dev)] });
    const r2 = byId(s2, dev.id);
    assert.equal(r2?.classification, "known");
    assert.equal(r2?.via, "target+registry");
    assert.equal(r2?.ipChanged, undefined);
    assert.equal((await devices()).length, 1);
  });

  test("discoveryTargets from the settings are probed on every scan; the request body may be omitted", async () => {
    const dev = await track();
    const put = await send<SettingsResponse>("PUT", api("/api/settings"), { discoveryTargets: [`http://127.0.0.1:${dev.port}/`, tgt(dev)] });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.discoveryTargets, [tgt(dev)], "canonical and de-duplicated");

    const started = await post<DiscoveryState>(api("/api/discovery/scan")); // no body at all
    assert.equal(started.status, 202);
    await waitUntil(async () => !(await state()).running, 8000, "scan to finish");
    const s = await state();
    const r = byId(s, dev.id);
    assert.equal(r?.classification, "new");
    assert.equal(r?.via, "target");
    // defaults: mdns and sweep on, but the injected discovery config has no mDNS and no interfaces
    assert.ok(s.warnings.some((w) => /No local IPv4 network/.test(w)), JSON.stringify(s.warnings));
    assert.deepEqual(s.subnets, []);

    await send("PUT", api("/api/settings"), { discoveryTargets: [] });
  });

  test("ignore -> `ignored`, un-ignore -> `new`, adopt of an ignored id un-ignores it", async () => {
    const dev = await track();
    await scan({ targets: [tgt(dev)] });

    const ig = await post<DiscoveryState>(api("/api/discovery/ignore"), { id: dev.id });
    assert.equal(ig.status, 200);
    assert.deepEqual(ig.body.ignored, [dev.id]);
    assert.equal(byId(ig.body, dev.id)?.classification, "ignored");
    assert.equal(byId(await scan({ targets: [tgt(dev)] }), dev.id)?.classification, "ignored", "also after a rescan");

    const un = await send<DiscoveryState>("DELETE", api(`/api/discovery/ignore/${dev.id.toUpperCase()}`));
    assert.equal(un.status, 200);
    assert.deepEqual(un.body.ignored, []);
    assert.equal(byId(un.body, dev.id)?.classification, "new");
    const again = await send<DiscoveryState>("DELETE", api(`/api/discovery/ignore/${dev.id}`));
    assert.equal(again.status, 200, "idempotent");

    await post(api("/api/discovery/ignore"), { id: dev.id });
    const adopt = await post<AdoptResponse>(api("/api/discovery/adopt"), { ids: [dev.id] });
    assert.deepEqual(adopt.body.added.map((a) => a.id), [dev.id]);
    assert.deepEqual((await state()).ignored, []);
    assert.equal(byId(await state(), dev.id)?.classification, "known");

    const bad = await post<ErrorResponse>(api("/api/discovery/ignore"), { id: "nope" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "invalid_id");
    assert.equal((await post<ErrorResponse>(api("/api/discovery/adopt"), { ids: [] })).status, 400);
  });

  test("a device in setup mode is flagged `setup`", async () => {
    const dev = await track();
    dev.state.network.state = "ap_only";
    dev.state.network.sta_ip = "";
    const r = byId(await scan({ targets: [tgt(dev)] }), dev.id);
    assert.equal(r?.setup, true);
    assert.equal(r?.netState, "ap_only");
    dev.state.network.state = "apsta_recovery";
    assert.equal(byId(await scan({ targets: [tgt(dev)] }), dev.id)?.setup, true);
  });

  test("IP change is followed by id: host updated, ipChanged set, health online", async () => {
    const a = await track({ name: "Mover" });
    const add = await post<DeviceSummary>(api("/api/devices"), { host: tgt(a) });
    assert.equal(add.status, 201);
    assert.equal(add.body.health, "online");
    const oldHost = tgt(a);
    await a.close();
    const poll = await post<DeviceSummary>(api(`/api/devices/${a.id}/refresh`));
    assert.notEqual(poll.body.health, "online");

    const b = await track({ id: a.id, name: "Mover" });
    assert.notEqual(b.port, a.port);
    const s = await scan({ targets: [tgt(b)] });
    const r = byId(s, a.id);
    assert.equal(r?.classification, "known");
    assert.equal(r?.host, tgt(b));
    assert.deepEqual(r?.ipChanged, { from: oldHost, to: tgt(b) });
    assert.equal(s.results.filter((x) => x.id === a.id).length, 1, "one entry per device id");

    const now = (await fetchJson<DeviceSummary>(api(`/api/devices/${a.id}`))).body;
    assert.equal(now.host, tgt(b));
    assert.equal(now.health, "online", "pollNow ran against the new address");
    assert.ok(now.lastSeen);
    assert.equal(now.label, "", "the user's label survives (none here) and the entry is not recreated");
    assert.equal(now.addedVia, "manual");

    // the result keeps saying so for the UI until the next scan
    assert.deepEqual(byId(await state(), a.id)?.ipChanged, { from: oldHost, to: tgt(b) });
    // a later scan finds it at the stored address: no change
    assert.equal(byId(await scan({ targets: [tgt(b)] }), a.id)?.ipChanged, undefined);
  });

  test("redirecting, non-JSON, non-ours and bad-id servers are never reported", async () => {
    const clean = await startTestServer({ ...SERVER_OPTS, discovery: DISC });
    const hits: string[] = [];
    const captive = await startPlainServer((req, res) => {
      hits.push(`captive ${req.url}`);
      res.writeHead(302, { Location: "http://192.168.4.1/" }).end();
    });
    const html = await startPlainServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>router</h1>"));
    const impostor = await startPlainServer((_req, res) =>
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "aabbccddeeff", hostname: "printer", chip: "HP", name: "Printer" })),
    );
    const badId = await startPlainServer((_req, res) =>
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "short", hostname: "esp32-xyz", ota: { project: "de_esp32_runtime" } })),
    );
    const err500 = await startPlainServer((_req, res) => res.writeHead(500).end("{}"));
    const closed = await closedPort();
    try {
      await post(`${clean.base}/api/discovery/scan`, { mdns: false, sweep: false, targets: [captive.host, html.host, impostor.host, badId.host, err500.host, `127.0.0.1:${closed}`] });
      await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${clean.base}/api/discovery`)).body.running, 8000, "scan");
      const s = (await fetchJson<DiscoveryState>(`${clean.base}/api/discovery`)).body;
      assert.equal(s.phase, "done");
      assert.deepEqual(s.results, []);
      assert.equal(s.probed, s.total);
      assert.ok(hits.length >= 1, "the captive server was probed");
    } finally {
      await clean.close();
      await Promise.all([captive.close(), html.close(), impostor.close(), badId.close(), err500.close()]);
    }
  });

  test("invalid targets and subnets are 400 with details; nothing starts", async () => {
    const r = await post<ErrorResponse>(api("/api/discovery/scan"), { targets: ["ok.local", "http://[bad"], subnets: ["10.0.0.0/24", "10.0.0.0"] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "invalid_body");
    const paths = (r.body.details as { path: string }[]).map((d) => d.path);
    assert.deepEqual(paths, ["/targets/1", "/subnets/1"]);
    assert.equal((await state()).running, false);
    assert.equal((await post<ErrorResponse>(api("/api/discovery/scan"), { mdns: "yes" })).status, 400);
    assert.equal((await post<ErrorResponse>(api("/api/discovery/scan"), { bogus: 1 })).status, 400);
  });

  test("settings: targets, subnets and background scan are validated and persisted", async () => {
    const put = (body: unknown) => send<SettingsResponse & ErrorResponse>("PUT", api("/api/settings"), body);
    const ok = await put({ discoveryTargets: ["127.0.0.1:8101", "HTTP://127.0.0.1:8102"], extraSubnets: ["192.168.9.0/24", "192.168.9.0/24"], backgroundScan: { enabled: false, periodMin: 7 } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.discoveryTargets, ["127.0.0.1:8101", "127.0.0.1:8102"]);
    assert.deepEqual(ok.body.extraSubnets, ["192.168.9.0/24"]);
    assert.deepEqual(ok.body.backgroundScan, { enabled: false, periodMin: 7 });
    const part = await put({ backgroundScan: { enabled: false } });
    assert.equal(part.body.backgroundScan.periodMin, 7, "partial backgroundScan keeps the rest");

    const badT = await put({ discoveryTargets: ["fine.local", "bad host"] });
    assert.equal(badT.status, 400);
    assert.equal(badT.body.code, "invalid_body");
    assert.equal((badT.body.details as { path: string }[])[0]?.path, "/discoveryTargets/1");
    const badS = await put({ extraSubnets: ["10.0.0.0/33"] });
    assert.equal(badS.status, 400);
    for (const bad of [{ backgroundScan: { periodMin: 0 } }, { backgroundScan: { periodMin: 61 } }, { backgroundScan: { enabled: "on" } }, { backgroundScan: { x: 1 } }]) {
      assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
    }
    const after = (await fetchJson<SettingsResponse>(api("/api/settings"))).body;
    assert.deepEqual(after.discoveryTargets, ["127.0.0.1:8101", "127.0.0.1:8102"], "a rejected update changes nothing");
    await put({ discoveryTargets: [], extraSubnets: [], backgroundScan: { enabled: false, periodMin: 5 } });
  });
});

describe("discovery: sweep, concurrency, cancel, 409, WebSocket", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const api = (p: string): string => `${srv.base}${p}`;
  const state = async (): Promise<DiscoveryState> => (await fetchJson<DiscoveryState>(api("/api/discovery"))).body;
  const waitIdle = (): Promise<void> => waitUntil(async () => !(await state()).running, 8000, "scan to finish");

  before(async () => {
    srv = await startTestServer({ ...SERVER_OPTS, discovery: { ...DISC, probeTimeoutMs: 5000 } });
  });
  after(async () => {
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
    for (const c of cleanups) await c();
  });

  test("cancel mid-scan: state `cancelled` promptly, results found so far are kept; a second start is 409 while running", async () => {
    const good = await startFake();
    fakes.push(good);
    const hole = await startBlackHole();
    cleanups.push(hole.close);
    const r = await post<DiscoveryState>(api("/api/discovery/scan"), { mdns: false, sweep: false, targets: [`127.0.0.1:${hole.port}`, tgt(good)] });
    assert.equal(r.status, 202);
    await waitUntil(async () => (await state()).results.length === 1, 3000, "the good device to show up while the hung one waits");
    const mid = await state();
    assert.equal(mid.running, true);
    assert.equal(mid.phase, "mdns");

    const second = await post<ErrorResponse>(api("/api/discovery/scan"), { mdns: false, sweep: false });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "scan_running");

    const t0 = Date.now();
    const c = await post<DiscoveryState>(api("/api/discovery/cancel"));
    assert.ok(Date.now() - t0 < 1500, `cancel took ${Date.now() - t0} ms`);
    assert.equal(c.status, 200);
    assert.equal(c.body.running, false);
    assert.equal(c.body.phase, "cancelled");
    assert.ok(c.body.finishedAt);
    assert.deepEqual(c.body.results.map((x) => x.id), [good.id], "results so far kept");
    assert.ok(c.body.probed < c.body.total, "the hung probe never finished");
    assert.equal((await state()).phase, "cancelled");
    // and a new scan can start again
    assert.equal((await post(api("/api/discovery/scan"), { mdns: false, sweep: false, targets: [tgt(good)] })).status, 202);
    await waitIdle();
  });

  test("a hung target does not stall past the probe timeout (scan still ends `done`)", async () => {
    const quick = await startTestServer({ ...SERVER_OPTS, discovery: { ...DISC, probeTimeoutMs: 200 } });
    const hole = await startBlackHole();
    try {
      const t0 = Date.now();
      await post(`${quick.base}/api/discovery/scan`, { mdns: false, sweep: false, targets: [`127.0.0.1:${hole.port}`] });
      await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${quick.base}/api/discovery`)).body.running, 5000, "scan");
      assert.ok(Date.now() - t0 < 3000);
      assert.equal((await fetchJson<DiscoveryState>(`${quick.base}/api/discovery`)).body.phase, "done");
    } finally {
      await hole.close();
      await quick.close();
    }
  });

  test("the probe concurrency limit is respected", async () => {
    let running = 0;
    let peak = 0;
    let served = 0;
    const server = http.createServer((_req, res) => {
      running++;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running--;
        served++;
        res.writeHead(404).end();
      }, 120);
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    const port = (server.address() as net.AddressInfo).port;
    const limited = await startTestServer({ ...SERVER_OPTS, discovery: { ...DISC, concurrency: 3 } });
    try {
      const targets = Array.from({ length: 9 }, (_, i) => `127.0.0.${i + 2}:${port}`);
      await post(`${limited.base}/api/discovery/scan`, { mdns: false, sweep: false, targets });
      await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${limited.base}/api/discovery`)).body.running, 8000, "scan");
      assert.equal(served, 9);
      assert.equal(peak, 3, `peak concurrency ${peak}`);
    } finally {
      await limited.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  test("sweep: a tiny injected subnet finds a fake on the sweep port (via sweep, merged with a target of the same address)", async () => {
    const dev = await startFake({ host: "127.0.0.2" });
    fakes.push(dev);
    const sw = await startTestServer({
      ...SERVER_OPTS,
      discovery: { ...DISC, interfaces: () => [{ address: "127.0.0.1", netmask: "255.255.255.252" }], sweepPort: dev.port },
    });
    try {
      const start = await post<DiscoveryState>(`${sw.base}/api/discovery/scan`, { mdns: false });
      assert.equal(start.status, 202);
      assert.deepEqual(start.body.subnets, ["127.0.0.0/30"]);
      assert.equal(start.body.total, 1, "127.0.0.0/30 has hosts .1 and .2; .1 is this machine, so only .2 is probed");
    } catch (e) {
      await sw.close();
      throw e;
    }
    try {
      await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${sw.base}/api/discovery`)).body.running, 8000, "sweep");
      const s = (await fetchJson<DiscoveryState>(`${sw.base}/api/discovery`)).body;
      assert.equal(s.phase, "done");
      const r = s.results.find((x) => x.id === dev.id);
      assert.ok(r, JSON.stringify(s));
      assert.equal(r.via, "sweep");
      assert.equal(r.host, `127.0.0.2:${dev.port}`);
      assert.equal(s.probed, s.total);

      // same address as a target as well: probed once, both vias recorded
      await post(`${sw.base}/api/discovery/scan`, { mdns: false, targets: [`127.0.0.2:${dev.port}`] });
      await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${sw.base}/api/discovery`)).body.running, 8000, "second sweep");
      const s2 = (await fetchJson<DiscoveryState>(`${sw.base}/api/discovery`)).body;
      assert.equal(s2.results.find((x) => x.id === dev.id)?.via, "sweep+target");
      assert.equal(s2.probed, s2.total, "the address that is both a target and a sweep host is probed once but counted for both");
    } finally {
      await sw.close();
    }
  });

  test("sweep with explicit subnets in the request: invalid ones rejected, valid ones listed", async () => {
    const hole = await startBlackHole();
    cleanups.push(hole.close);
    // A hung target keeps the scan in its first phase, so the 192.0.2.0/24 range is planned but never probed (cancelled before the sweep).
    const r = await post<DiscoveryState>(api("/api/discovery/scan"), { mdns: false, subnets: ["192.0.2.77/16"], targets: [`127.0.0.1:${hole.port}`] });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body.subnets, ["192.0.2.0/24"]);
    assert.equal(r.body.total, 254 + 1);
    await sleep(100);
    assert.equal((await state()).phase, "mdns");
    const c = await post<DiscoveryState>(api("/api/discovery/cancel"));
    assert.equal(c.body.phase, "cancelled");
  });

  test("WebSocket: scan messages arrive with phases, progress and a final `done` carrying the results", async () => {
    const swept = await startFake({ host: "127.0.0.2" });
    const targeted = await startFake();
    fakes.push(swept, targeted);
    const sw = await startTestServer({
      ...SERVER_OPTS,
      discovery: { ...DISC, interfaces: () => [{ address: "127.0.0.1", netmask: "255.255.255.252" }], sweepPort: swept.port },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${sw.port}/api/ws`);
    const msgs: BrowserWsMessage[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as BrowserWsMessage));
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    try {
      const mark = msgs.length;
      await post(`${sw.base}/api/discovery/scan`, { mdns: false, targets: [tgt(targeted)] });
      await waitUntil(() => msgs.slice(mark).some((m) => m.t === "scan" && m.phase === "done"), 8000, "the final scan message");
      const scans = msgs.slice(mark).filter((m): m is Extract<BrowserWsMessage, { t: "scan" }> => m.t === "scan");
      const phases = scans.map((m) => m.phase);
      assert.equal(phases[0], "mdns");
      assert.ok(phases.includes("sweep"), `phases: ${phases.join(",")}`);
      assert.equal(phases.at(-1), "done");
      assert.deepEqual([...new Set(phases)], ["mdns", "sweep", "done"], "phases only move forward");
      assert.ok(scans.every((m) => m.total >= m.probed));
      const last = scans.at(-1);
      assert.equal(last?.probed, last?.total);
      assert.equal(last?.total, 2);
      assert.deepEqual(last?.found.map((f) => f.id).sort(), [swept.id, targeted.id].sort());
      assert.ok(last?.found.every((f) => f.classification === "new"));
    } finally {
      ws.close();
      await sw.close();
    }
  });

  test("progress messages are throttled to at most 4 per second", async () => {
    // 60 closed ports on loopback would be slow on Windows; instead feed many quick answers: 40 distinct 127.0.0.x targets on one server
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    const port = (server.address() as net.AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/ws`);
    const times: number[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as BrowserWsMessage;
      if (m.t === "scan") times.push(Date.now());
    });
    await new Promise<void>((res) => ws.once("open", () => res()));
    try {
      const targets = Array.from({ length: 40 }, (_, i) => `127.0.0.${i + 2}:${port}`);
      await post(api("/api/discovery/scan"), { mdns: false, sweep: false, targets });
      await waitIdle();
      await sleep(400);
      assert.ok(times.length >= 2 && times.length <= 8, `scan messages: ${times.length}`);
      // any 1 s window holds at most 5 messages (4 + one boundary)
      for (let i = 0; i < times.length; i++) {
        const inWindow = times.filter((t) => t >= (times[i] as number) && t < (times[i] as number) + 1000).length;
        assert.ok(inWindow <= 5, `${inWindow} messages inside one second`);
      }
    } finally {
      ws.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

// ---- mDNS through the service ----------------------------------------------------------------------------------------

function mdnsFactoryFor(packets: MdnsPacket[], onQuery?: (em: EventEmitter) => void, throwOnCreate?: Error): MdnsFactory {
  return () => {
    if (throwOnCreate) throw throwOnCreate;
    const em = new EventEmitter();
    return Object.assign(em, {
      query() {
        setImmediate(() => {
          for (const p of packets) em.emit("response", p);
          onQuery?.(em);
        });
      },
      destroy() {},
    }) as unknown as MdnsLike;
  };
}

const pairs = (...p: string[]): Buffer[] => p.map((x) => Buffer.from(x));

describe("discovery with a fake mDNS socket", () => {
  const fakes: FakeDevice[] = [];
  const servers: TestServer[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await Promise.all(fakes.map((f) => f.close()));
  });

  async function run(discovery: StartOptions["discovery"], body: Record<string, unknown>): Promise<DiscoveryState> {
    const s = await startTestServer({ ...SERVER_OPTS, discovery });
    servers.push(s);
    await post(`${s.base}/api/discovery/scan`, body);
    await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${s.base}/api/discovery`)).body.running, 8000, "scan");
    return (await fetchJson<DiscoveryState>(`${s.base}/api/discovery`)).body;
  }

  test("a device announced over mDNS is found via mdns (SRV port, TXT before HTTP); a non-ours _http responder is not", async () => {
    const dev = await startFake({ name: "Announced" });
    fakes.push(dev);
    const printer = await startPlainServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>printer</h1>"));
    const jsonThing = await startPlainServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"hello":"world"}'));
    try {
      const inst = "esp32-d1e5c0._de-esp32._tcp.local";
      const packets: MdnsPacket[] = [
        {
          answers: [
            { name: "_de-esp32._tcp.local", type: "PTR", data: inst },
            { name: "_http._tcp.local", type: "PTR", data: "printer._http._tcp.local" },
            { name: "_http._tcp.local", type: "PTR", data: "thing._http._tcp.local" },
          ],
          additionals: [
            { name: inst, type: "SRV", data: { port: dev.port, target: "esp32-d1e5c0.local" } },
            { name: inst, type: "TXT", data: pairs(`id=${dev.id}`, "api=/api/v1", "name=Announced", "fw=fake-1", "board=esp32-devkitc") },
            { name: "esp32-d1e5c0.local", type: "A", data: "127.0.0.1" },
            { name: "printer._http._tcp.local", type: "SRV", data: { port: printer.port, target: "printer.local" } },
            { name: "printer._http._tcp.local", type: "TXT", data: pairs("path=/") },
            { name: "printer.local", type: "A", data: "127.0.0.1" },
            { name: "thing._http._tcp.local", type: "SRV", data: { port: jsonThing.port, target: "thing.local" } },
            { name: "thing.local", type: "A", data: "127.0.0.1" },
          ],
        },
      ];
      const s = await run({ ...DISC, mdns: mdnsFactoryFor(packets), mdnsWindowMs: 150 }, { sweep: false });
      assert.equal(s.phase, "done");
      assert.deepEqual(s.warnings, []);
      assert.equal(s.results.length, 1, JSON.stringify(s.results));
      const r = s.results[0] as DiscoveryResult;
      assert.equal(r.id, dev.id);
      assert.ok(r.via.includes("mdns"));
      assert.equal(r.via, "mdns");
      assert.equal(r.host, `127.0.0.1:${dev.port}`, "port from SRV");
      assert.equal(r.txt?.id, dev.id);
      assert.equal(r.txt?.api, "/api/v1");
      assert.equal(r.classification, "new");
      assert.equal(s.total, 3, "the three mDNS candidates were probed");
      assert.equal(s.probed, 3);
    } finally {
      await Promise.all([printer.close(), jsonThing.close()]);
    }
  });

  test("an mDNS device that is also a registry/target address merges vias; adopt of an mdns+... result records addedVia mdns", async () => {
    const dev = await startFake();
    fakes.push(dev);
    const packets: MdnsPacket[] = [
      {
        answers: [{ name: "_de-esp32._tcp.local", type: "PTR", data: "x._de-esp32._tcp.local" }],
        additionals: [
          { name: "x._de-esp32._tcp.local", type: "SRV", data: { port: dev.port, target: "x.local" } },
          { name: "x.local", type: "A", data: "127.0.0.1" },
        ],
      },
    ];
    const s = await startTestServer({ ...SERVER_OPTS, discovery: { ...DISC, mdns: mdnsFactoryFor(packets), mdnsWindowMs: 100 } });
    servers.push(s);
    await post(`${s.base}/api/discovery/scan`, { sweep: false, targets: [tgt(dev)] });
    await waitUntil(async () => !(await fetchJson<DiscoveryState>(`${s.base}/api/discovery`)).body.running, 8000, "scan");
    const st = (await fetchJson<DiscoveryState>(`${s.base}/api/discovery`)).body;
    assert.equal(st.results[0]?.via, "mdns+target");
    assert.equal(st.total, 1, "one address, probed once");
    const adopt = await post<AdoptResponse>(`${s.base}/api/discovery/adopt`, { ids: [dev.id] });
    assert.equal(adopt.body.added[0]?.addedVia, "mdns");
  });

  test("an mDNS socket error is a warning; the scan still completes and finds the other addresses", async () => {
    const dev = await startFake();
    fakes.push(dev);
    const f = mdnsFactoryFor([], (em) => em.emit("error", Object.assign(new Error("bind EADDRINUSE 0.0.0.0:5353"), { code: "EADDRINUSE" })));
    const s = await run({ ...DISC, mdns: f, mdnsWindowMs: 5000 }, { sweep: false, targets: [tgt(dev)] });
    assert.equal(s.phase, "done");
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0] as string, /mDNS socket error.*5353/);
    assert.equal(s.results.length, 1);

    const s2 = await run({ ...DISC, mdns: mdnsFactoryFor([], undefined, new Error("no interface")), mdnsWindowMs: 100 }, { sweep: false });
    assert.equal(s2.phase, "done");
    assert.match(s2.warnings[0] as string, /could not start/);
  });
});

// ---- waitForDevice (library call) --------------------------------------------------------------------------------------

async function makeService(config: Parameters<typeof createDiscoveryService>[0]["config"] = { mdns: false, interfaces: () => [], probeTimeoutMs: 300 }): Promise<{ svc: DiscoveryService; close(): Promise<void>; hub: ReturnType<typeof createBrowserHub> }> {
  const dataDir = tmpDataDir();
  const settings = await createSettingsService(dataDir);
  const registry = await createRegistry({ dataDir, debounceMs: 20 });
  const pool = createDevicePool();
  const health = createHealthService({ registry, pool, settings, pollIntervalMs: 60_000, pollTimeoutMs: 300 });
  const hub = createBrowserHub({ version: "test", lan: false });
  const svc = createDiscoveryService({ registry, health, settings, hub, ...(config ? { config } : {}) });
  return {
    svc,
    hub,
    async close() {
      await svc.close();
      health.stop();
      pool.destroy();
      await registry.flush();
      await hub.close();
    },
  };
}

describe("waitForDevice", () => {
  const fakes: FakeDevice[] = [];
  after(() => Promise.all(fakes.map((f) => f.close())));

  test("finds a device that comes online after a delay (targets), without touching the UI scan state", async () => {
    const dev = await startFake();
    fakes.push(dev);
    await dev.goOffline("refuse");
    const { svc, close } = await makeService();
    try {
      const started = Date.now();
      const p = svc.waitForDevice(dev.id, { timeoutMs: 8000, intervalMs: 60, mdns: false, sweep: false, targets: [tgt(dev)] });
      await sleep(400);
      assert.equal(svc.getState().phase, "idle", "no UI scan was started");
      await dev.goOnline();
      const hit = await p;
      assert.ok(hit, "found");
      assert.equal(hit.host, tgt(dev));
      assert.equal(hit.status.id, dev.id);
      assert.ok(Date.now() - started >= 350, "not found before it came online");
      assert.deepEqual(svc.getState().results, []);
      assert.equal(svc.getState().phase, "idle");
    } finally {
      await close();
    }
  });

  test("returns null on timeout and on abort; ignores other devices", async () => {
    const other = await startFake();
    fakes.push(other);
    const closed = await closedPort();
    const { svc, close } = await makeService();
    try {
      let t0 = Date.now();
      assert.equal(await svc.waitForDevice("aaaaaaaaaaaa", { timeoutMs: 500, intervalMs: 50, mdns: false, sweep: false, targets: [`127.0.0.1:${closed}`, tgt(other)] }), null);
      assert.ok(Date.now() - t0 < 2500, `timeout took ${Date.now() - t0} ms`);

      const ctrl = new AbortController();
      t0 = Date.now();
      const p = svc.waitForDevice("aaaaaaaaaaaa", { timeoutMs: 20_000, intervalMs: 50, mdns: false, sweep: false, targets: [`127.0.0.1:${closed}`], signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 150);
      assert.equal(await p, null);
      assert.ok(Date.now() - t0 < 2500);
      assert.equal(await svc.waitForDevice("aaaaaaaaaaaa", { timeoutMs: 1000, signal: ctrl.signal }), null, "an already aborted signal returns at once");
    } finally {
      await close();
    }
  });

  test("works while a UI scan runs and leaves its state alone; also finds through a sweep and through mDNS", async () => {
    const dev = await startFake({ host: "127.0.0.2" });
    fakes.push(dev);
    const hole = await startBlackHole();
    const packets: MdnsPacket[] = [
      {
        answers: [{ name: "_de-esp32._tcp.local", type: "PTR", data: "y._de-esp32._tcp.local" }],
        additionals: [
          { name: "y._de-esp32._tcp.local", type: "SRV", data: { port: dev.port, target: "y.local" } },
          { name: "y.local", type: "A", data: "127.0.0.2" },
        ],
      },
    ];
    const base = { probeTimeoutMs: 300, mdnsWindowMs: 100 };
    const sweeping = await makeService({ ...base, mdns: false, interfaces: () => [{ address: "127.0.0.1", netmask: "255.255.255.252" }], sweepPort: dev.port });
    const browsing = await makeService({ ...base, mdns: mdnsFactoryFor(packets), interfaces: () => [] });
    try {
      // a UI scan is hanging on a black hole while waitForDevice runs
      const ui = sweeping.svc.startScan({ mdns: false, sweep: false, targets: [`127.0.0.1:${hole.port}`] });
      assert.equal(ui.running, true);
      const hit = await sweeping.svc.waitForDevice(dev.id, { timeoutMs: 5000, intervalMs: 50, mdns: false });
      assert.equal(hit?.host, `127.0.0.2:${dev.port}`);
      assert.equal(sweeping.svc.getState().running, true, "the UI scan is untouched");
      assert.equal(sweeping.svc.getState().phase, "mdns");
      assert.deepEqual(sweeping.svc.getState().results, []);
      await sweeping.svc.cancelScan();

      const viaMdns = await browsing.svc.waitForDevice(dev.id, { timeoutMs: 5000, intervalMs: 50, sweep: false });
      assert.equal(viaMdns?.host, `127.0.0.2:${dev.port}`);
    } finally {
      await Promise.all([sweeping.close(), browsing.close(), hole.close()]);
    }
  });
});

// ---- background scanning -------------------------------------------------------------------------------------------------

describe("background scan", () => {
  const fakes: FakeDevice[] = [];
  after(() => Promise.all(fakes.map((f) => f.close())));

  test("off by default; enabling it scans on the timer (final message only on the WebSocket); disabling stops it", async () => {
    const dev = await startFake();
    fakes.push(dev);
    const srv = await startTestServer({ ...SERVER_OPTS, discovery: { ...DISC, backgroundPeriodMs: 120 } });
    const api = (p: string): string => `${srv.base}${p}`;
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/ws`);
    const scans: BrowserWsMessage[] = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as BrowserWsMessage;
      if (m.t === "scan") scans.push(m);
    });
    await new Promise<void>((res) => ws.once("open", () => res()));
    try {
      await send("PUT", api("/api/settings"), { discoveryTargets: [tgt(dev)] });
      await sleep(350);
      assert.equal((await fetchJson<DiscoveryState>(api("/api/discovery"))).body.phase, "idle", "disabled by default: no scan");

      const on = await send<SettingsResponse>("PUT", api("/api/settings"), { backgroundScan: { enabled: true, periodMin: 1 } });
      assert.deepEqual(on.body.backgroundScan, { enabled: true, periodMin: 1 });
      await waitUntil(async () => (await fetchJson<DiscoveryState>(api("/api/discovery"))).body.results.length === 1, 4000, "a background scan to find the device");
      const s = (await fetchJson<DiscoveryState>(api("/api/discovery"))).body;
      assert.equal(s.results[0]?.id, dev.id);
      await sleep(200);
      assert.ok(scans.length >= 1 && scans.every((m) => m.t === "scan" && (m.phase === "done" || m.phase === "cancelled" || m.phase === "error")), `background scans only broadcast their end: ${scans.map((m) => m.t === "scan" && m.phase).join(",")}`);

      await send("PUT", api("/api/settings"), { backgroundScan: { enabled: false } });
      await sleep(100);
      const startedAt = (await fetchJson<DiscoveryState>(api("/api/discovery"))).body.startedAt;
      await sleep(400);
      assert.equal((await fetchJson<DiscoveryState>(api("/api/discovery"))).body.startedAt, startedAt, "no more scans after disabling");
    } finally {
      ws.close();
      await srv.close();
    }
  });
});
