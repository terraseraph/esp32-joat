import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import { NETWORK_SCAN_OFF_WARNING } from "../src/discovery";
import type { MdnsFactory } from "../src/discovery/mdns";
import { defineRoute } from "../src/http/router";
import type { DiscoveryState, HealthResponse } from "../src/types/api";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = <T = unknown>(url: string, body?: unknown) =>
  fetchJson<T>(url, { method: "POST", headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** Counts how often discovery reaches for the network. With --no-network-scan both stay at 0. */
function spies() {
  const calls = { mdns: 0, interfaces: 0 };
  const mdns: MdnsFactory = () => {
    calls.mdns++;
    throw new Error("mDNS must not be opened");
  };
  const interfaces = () => {
    calls.interfaces++;
    return [{ address: "127.0.0.1", netmask: "255.255.255.252" }];
  };
  return { calls, mdns, interfaces };
}

const waitRoute = defineRoute({
  method: "POST",
  path: "/api/test/wait-for-device",
  summary: "waitForDevice (test)",
  tags: ["test"],
  body: Type.Object({ id: Type.String(), targets: Type.Optional(Type.Array(Type.String())), timeoutMs: Type.Number() }),
  response: Type.Unknown(),
  handler: async ({ app, body }) => ({
    // mdns/sweep default to true here, exactly like a feature that does not think about it
    body: { found: await app.discovery.waitForDevice(body.id, { timeoutMs: body.timeoutMs, intervalMs: 30, ...(body.targets ? { targets: body.targets } : {}) }) },
  }),
});

describe("--no-network-scan", () => {
  const s = spies();
  let srv: TestServer;
  let dev: FakeDevice;
  const api = (p: string): string => `${srv.base}${p}`;
  const state = async (): Promise<DiscoveryState> => (await fetchJson<DiscoveryState>(api("/api/discovery"))).body;
  const scan = async (body?: unknown): Promise<DiscoveryState> => {
    const r = await post<DiscoveryState>(api("/api/discovery/scan"), body);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await waitUntil(async () => !(await state()).running, 8000, "scan to finish");
    return state();
  };

  before(async () => {
    dev = await startFakeDevice({ ...FAST, seed: "demo", id: "d1e5c0ff0001" });
    srv = await startTestServer({
      networkScan: false,
      wifiAdapter: "fake",
      pollIntervalMs: 60_000,
      pollTimeoutMs: 400,
      registrySaveDebounceMs: 40,
      discovery: { mdns: s.mdns, interfaces: s.interfaces, probeTimeoutMs: 400, backgroundPeriodMs: 30 },
      extraRoutes: [waitRoute],
    });
  });
  after(async () => {
    await srv.close();
    await dev.close();
  });

  test("health and the discovery state say so", async () => {
    const h = await fetchJson<HealthResponse>(api("/api/health"));
    assert.equal(h.body.networkScan, false);
    assert.equal(h.body.wifiAdapter, "fake");
    assert.equal((await state()).networkScan, false);
  });

  test("a running scan never reports the mDNS phase", async () => {
    const r = await post<DiscoveryState>(api("/api/discovery/scan"), { targets: [`127.0.0.1:${dev.port}`] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.notEqual(r.body.phase, "mdns");
    assert.equal(r.body.phase, "sweep", "it goes straight to probing addresses");
    await waitUntil(async () => !(await state()).running, 8000, "scan to finish");
  });

  test("a scan asking for mDNS and a sweep runs without them, still finds a device through its target, and warns", async () => {
    const st = await scan({ mdns: true, sweep: true, targets: [`127.0.0.1:${dev.port}`] });
    assert.equal(st.phase, "done");
    assert.equal(s.calls.mdns, 0, "the mDNS factory was never called");
    assert.equal(s.calls.interfaces, 0, "the interface list was never read, so nothing was swept");
    assert.deepEqual(st.subnets, []);
    assert.deepEqual(st.warnings, [NETWORK_SCAN_OFF_WARNING]);
    assert.match(NETWORK_SCAN_OFF_WARNING, /Network scanning is turned off on this Manager \(started with --no-network-scan\)/);
    assert.equal(st.networkScan, false);
    const r = st.results.find((x) => x.id === dev.id);
    assert.ok(r, JSON.stringify(st.results));
    assert.equal(r.via, "target");
  });

  test("an empty request body (defaults: mdns and sweep on) is treated the same way", async () => {
    const st = await scan();
    assert.equal(st.phase, "done");
    assert.deepEqual(st.warnings, [NETWORK_SCAN_OFF_WARNING]);
    assert.equal(s.calls.mdns + s.calls.interfaces, 0);
  });

  test("a scan that asked for neither has nothing to warn about; settings targets and registry hosts are still probed", async () => {
    await fetchJson(api("/api/settings"), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ discoveryTargets: [`127.0.0.1:${dev.port}`], extraSubnets: ["10.9.8.0/24"] }) });
    const st = await scan({ mdns: false, sweep: false });
    assert.deepEqual(st.warnings, []);
    assert.equal(st.results.find((x) => x.id === dev.id)?.via, "target", "found through the settings' discoveryTargets");
    assert.deepEqual(st.subnets, [], "extraSubnets are not swept either");

    const added = await post<{ id: string }>(api("/api/devices"), { host: `127.0.0.1:${dev.port}` });
    assert.equal(added.status, 201);
    await fetchJson(api("/api/settings"), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ discoveryTargets: [] }) });
    const again = await scan({ mdns: true, sweep: true });
    const known = again.results.find((x) => x.id === dev.id);
    assert.ok(known, "the registered device is probed by its address");
    assert.match(known.via, /registry/);
    assert.equal(known.classification, "known");
    assert.equal(s.calls.mdns + s.calls.interfaces, 0);
  });

  test("waitForDevice does not browse mDNS or sweep either, but finds the device through targets", async () => {
    const r = await post<{ found: { host: string } | null }>(api("/api/test/wait-for-device"), { id: "d1e5c0ff0002", timeoutMs: 250 });
    assert.equal(r.body.found, null, "nothing to find, and no way to look for it on the network");
    const other = await startFakeDevice({ ...FAST, seed: "demo", id: "d1e5c0ff0002" });
    try {
      const hit = await post<{ found: { host: string } | null }>(api("/api/test/wait-for-device"), { id: other.id, targets: [`127.0.0.1:${other.port}`], timeoutMs: 3000 });
      assert.equal(hit.body.found?.host, `127.0.0.1:${other.port}`);
    } finally {
      await other.close();
    }
    assert.equal(s.calls.mdns, 0);
    assert.equal(s.calls.interfaces, 0);
  });

  test("the background scan never runs, even when it is enabled and due", async () => {
    await fetchJson(api("/api/settings"), { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ backgroundScan: { enabled: true, periodMin: 1 } }) });
    const before = (await state()).finishedAt;
    await new Promise((r) => setTimeout(r, 250)); // several 30 ms periods
    const after = await state();
    assert.equal(after.running, false);
    assert.equal(after.finishedAt, before, "no new scan was started");
    assert.equal(s.calls.mdns + s.calls.interfaces, 0);
  });
});

describe("network scanning on (the default)", () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ discovery: { mdns: false, interfaces: () => [] } });
  });
  after(() => srv.close());

  test("health and the state report it, the adapter defaults to system, and no scan warning appears", async () => {
    const h = await fetchJson<HealthResponse>(`${srv.base}/api/health`);
    assert.equal(h.body.networkScan, true);
    assert.equal(h.body.wifiAdapter, "system");
    const r = await post<DiscoveryState>(`${srv.base}/api/discovery/scan`, { mdns: false, sweep: false });
    assert.equal(r.body.networkScan, true);
    assert.deepEqual(r.body.warnings, []);
  });
});
