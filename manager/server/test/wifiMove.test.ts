import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import type { AppContext } from "../src/appContext";
import { defineRoute } from "../src/http/router";
import { validateWifiCredentials, wifiChangeWords, type WifiMoveConfig } from "../src/wifimove";
import type { DeviceSummary, Job } from "../src/types/api";
import type { WifiMoveCheckResult, WifiMoveJobResult, WifiMoveSettings } from "../src/types/api-wifimove";
import { startFakeDevice, type FakeDevice, type FakeDeviceOptions } from "./fake/fakeDevice";
import { FAST, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";
import { closedPort } from "./helpers/net";
import { FrameRecorder, readAllFiles } from "./setupKit";

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = <T = unknown>(url: string, body?: unknown) =>
  fetchJson<T>(url, { method: "POST", headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const FAST_MOVE: WifiMoveConfig = { findTimeoutMs: 3000, roundMs: 300, intervalMs: 40, settleMs: 50 };
const PASSWORD = "correct-horse-battery";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

interface Rig {
  srv: TestServer & { app: AppContext };
  dev: FakeDevice;
  id: string;
  base: string;
  wifi: string;
  logs: string[];
  /** A free loopback port: where a device moves to. */
  newPort: number;
  start(body: unknown): Promise<{ status: number; body: Job & { code?: string; details?: unknown } }>;
  done(jobId: string): Promise<Job>;
}

async function startWithApp(opts: Parameters<typeof startTestServer>[0]): Promise<TestServer & { app: AppContext }> {
  let captured: AppContext | undefined;
  const route = defineRoute({
    method: "GET",
    path: "/api/test/app",
    summary: "test",
    tags: ["test"],
    response: Type.Unknown(),
    handler: ({ app }) => {
      captured = app;
      return { body: {} };
    },
  });
  const srv = await startTestServer({ ...opts, extraRoutes: [route] });
  await fetchJson(`${srv.base}/api/test/app`);
  assert.ok(captured);
  return Object.assign(srv, { app: captured });
}

async function rig(opts: { fake?: FakeDeviceOptions; move?: WifiMoveConfig; known?: boolean; server?: Parameters<typeof startTestServer>[0] } = {}): Promise<Rig> {
  const newPort = await closedPort();
  const dev = await startFakeDevice({ ...FAST, pendingFirmware: true, wifiMoves: { "workshop-wifi": `127.0.0.1:${newPort}` }, ...opts.fake });
  const logs: string[] = [];
  const srv = await startWithApp({
    pollIntervalMs: 60_000,
    pollTimeoutMs: 400,
    registrySaveDebounceMs: 40,
    networkScan: false,
    wifiAdapter: "fake",
    discovery: { mdns: false, interfaces: () => [], probeTimeoutMs: 300 },
    jobs: { wsThrottleMs: 0 },
    wifiMove: { ...FAST_MOVE, ...opts.move },
    log: (m) => logs.push(m),
    ...opts.server,
  });
  cleanup.push(async () => {
    await srv.close();
    await dev.close();
  });
  const added = await post<DeviceSummary>(`${srv.base}/api/devices`, { host: `127.0.0.1:${dev.port}` });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  // The Manager can look at the new address (a typed discovery target; no mDNS, no sweep).
  if (opts.known !== false) {
    const put = await fetchJson(`${srv.base}/api/settings`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ discoveryTargets: [`127.0.0.1:${newPort}`] }) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }
  const wifi = `${srv.base}/api/devices/${dev.id}/wifi`;
  return {
    srv,
    dev,
    id: dev.id,
    base: srv.base,
    wifi,
    logs,
    newPort,
    start: (body) => post(wifi, body) as never,
    done: (jobId) => srv.app.jobs.whenDone(jobId),
  };
}

const hostOf = (r: Rig): string => r.srv.app.registry.get(r.id)?.host ?? "";
const result = (j: Job): WifiMoveJobResult => j.result as WifiMoveJobResult;
const stepStatuses = (j: Job): string => j.steps.map((s) => `${s.id}:${s.status}`).join(" ");

// ---------------------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------------------

describe("credentials rules", () => {
  test("ssid 1-32 bytes, password empty or 8-63", () => {
    assert.deepEqual(validateWifiCredentials("Home", undefined), []);
    assert.deepEqual(validateWifiCredentials("Home", ""), []);
    assert.deepEqual(validateWifiCredentials("Home", "12345678"), []);
    assert.deepEqual(validateWifiCredentials("Home", "x".repeat(63)), []);
    assert.deepEqual(validateWifiCredentials("a".repeat(32), ""), []);
    assert.deepEqual(validateWifiCredentials("", "").map((e) => e.field), ["ssid"]);
    assert.deepEqual(validateWifiCredentials("a".repeat(33), "").map((e) => e.field), ["ssid"]);
    assert.deepEqual(validateWifiCredentials("é".repeat(17), "").map((e) => e.field), ["ssid"], "34 bytes, 17 characters");
    assert.deepEqual(validateWifiCredentials("Home", "1234567").map((e) => e.field), ["password"]);
    assert.deepEqual(validateWifiCredentials("Home", "x".repeat(64)).map((e) => e.field), ["password"]);
    assert.deepEqual(validateWifiCredentials("", "short").map((e) => e.field), ["ssid", "password"]);
  });

  test("the last change in words", () => {
    assert.equal(wifiChangeWords(undefined), null);
    assert.equal(wifiChangeWords({ result: "none" }), null);
    assert.match(wifiChangeWords({ result: "failed", ssid: "Net", reason: "auth", restored_previous: true }) ?? "", /refused the password.*previous network/);
    assert.match(wifiChangeWords({ result: "failed", reason: "no_ap" }) ?? "", /could not find/);
    assert.match(wifiChangeWords({ result: "ok", ssid: "Net" }) ?? "", /joined "Net"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// GET / check / refusals
// ---------------------------------------------------------------------------------------------------------------

describe("GET /api/devices/:id/wifi", () => {
  test("pending firmware: supported, with the PC's network from the adapter", async () => {
    const r = await rig();
    const g = await fetchJson<WifiMoveSettings>(r.wifi);
    assert.equal(g.status, 200);
    assert.equal(g.body.supported, true);
    assert.equal(g.body.reason, null);
    assert.equal(g.body.state, "sta_connected");
    assert.equal(g.body.ip, "192.168.1.42");
    assert.equal(g.body.ipMode, "dhcp");
    assert.equal(g.body.staticIp, false);
    assert.equal(g.body.lastChange, null);
    assert.equal(g.body.pcSsid, "HomeNet");
    assert.equal(g.body.pcSsidKnown, true);
    assert.equal(g.body.setupApAvailable, true);
    assert.equal(g.body.activeJobId, null);
  });

  test("current firmware: not supported, starting is a 409", async () => {
    const r = await rig({ fake: { pendingFirmware: false } });
    const g = await fetchJson<WifiMoveSettings>(r.wifi);
    assert.equal(g.body.supported, false);
    assert.match(g.body.reason ?? "", /firmware/);
    assert.equal(g.body.lastChange, null);
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    assert.equal(s.status, 409);
    assert.equal(s.body.code, "wifi_change_unsupported");
    const c = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "workshop-wifi" });
    assert.equal(c.body.ok, false);
    assert.equal(c.body.errors[0]?.field, "device");
    assert.equal(r.srv.app.jobs.list().length, 0, "no job was created");
  });

  test("unknown device is 404, an unreachable device is 502", async () => {
    const r = await rig();
    assert.equal((await fetchJson(`${r.base}/api/devices/aaaaaaaaaaaa/wifi`)).status, 404);
    await r.dev.goOffline("refuse");
    const g = await fetchJson<{ transport: boolean }>(r.wifi);
    assert.equal(g.status, 502);
    assert.equal(g.body.transport, true);
    assert.equal((await r.start({ ssid: "workshop-wifi", password: PASSWORD })).status, 502);
  });

  test("shows the last change in words and the fixed address", async () => {
    const r = await rig();
    r.dev.state.network.ip_mode = "static";
    r.dev.state.network.wifi_change = { result: "failed", ssid: "Other", reason: "auth", restored_previous: true, seq: 2 };
    const g = await fetchJson<WifiMoveSettings>(r.wifi);
    assert.equal(g.body.staticIp, true);
    assert.equal(g.body.lastChange?.reason, "auth");
    assert.match(g.body.lastChange?.words ?? "", /refused the password/);
  });
});

describe("POST /api/devices/:id/wifi/check", () => {
  test("rules and warnings", async () => {
    const r = await rig();
    const ok = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "HomeNet", password: PASSWORD });
    assert.deepEqual(ok.body, { ok: true, errors: [], warnings: [] });
    const other = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "workshop-wifi" });
    assert.deepEqual(other.body.warnings.map((w) => w.code), ["pc_other_network"]);
    assert.match(other.body.warnings[0]?.message ?? "", /"HomeNet".*"workshop-wifi"/);
    const bad = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "", password: "short" });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    assert.deepEqual(bad.body.errors.map((e) => e.field), ["ssid", "password"]);
    r.dev.state.network.ip_mode = "static";
    const fixed = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "HomeNet" });
    assert.deepEqual(fixed.body.warnings.map((w) => w.code), ["static_ip_reset"]);
    r.dev.state.network.wifi_change = { result: "testing", seq: 1 };
    const busy = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "HomeNet" });
    assert.equal(busy.body.ok, false);
    assert.equal(busy.body.errors[0]?.field, "device");
  });

  test("a PC without a Wi-Fi adapter: the network is unknown", async () => {
    const r = await rig({ server: { wifiAdapter: "none" } });
    const c = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "workshop-wifi" });
    assert.deepEqual(c.body.warnings.map((w) => w.code), ["pc_network_unknown"]);
    const g = await fetchJson<WifiMoveSettings>(r.wifi);
    assert.equal(g.body.pcSsid, null);
    assert.equal(g.body.pcSsidKnown, false);
    assert.equal(g.body.setupApAvailable, false);
  });
});

describe("POST /api/devices/:id/wifi: refusals", () => {
  test("invalid ssid or password is a 422 with the fields, and no job", async () => {
    const r = await rig();
    for (const [body, field] of [
      [{ ssid: "", password: PASSWORD }, "ssid"],
      [{ ssid: "a".repeat(33) }, "ssid"],
      [{ ssid: "workshop-wifi", password: "short" }, "password"],
    ] as const) {
      const s = await r.start(body);
      assert.equal(s.status, 422, JSON.stringify(s.body));
      assert.equal(s.body.code, "invalid_wifi_config");
      assert.equal((s.body.details as { field: string }[])[0]?.field, field);
    }
    assert.equal((await r.start({ password: PASSWORD })).status, 400, "ssid is required");
    assert.equal((await r.start({ ssid: "x", timeoutS: 0 })).status, 400);
    assert.equal(r.srv.app.jobs.list().length, 0);
  });

  test("a second move while one runs is a 409 job_running", async () => {
    const r = await rig({ known: false, move: { findTimeoutMs: 20_000 } });
    const a = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    assert.equal(a.status, 202, JSON.stringify(a.body));
    const b = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    assert.equal(b.status, 409);
    assert.equal(b.body.code, "job_running");
    assert.equal((await fetchJson<WifiMoveSettings>(r.wifi)).status, 502, "the device is gone from its old address");
    r.srv.app.jobs.cancel(a.body.id);
    await r.done(a.body.id);
  });

  test("an offline device is a 409 device_offline", async () => {
    const r = await rig();
    await r.dev.goOffline("refuse");
    await post(`${r.base}/api/devices/${r.id}/refresh`);
    await post(`${r.base}/api/devices/${r.id}/refresh`);
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    assert.equal(s.status, 409, JSON.stringify(s.body));
    assert.equal(s.body.code, "device_offline");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------------------------

describe("a move that works", () => {
  test("the device appears at a new address: found by id, registry updated, health polled", async () => {
    const r = await rig();
    const oldHost = hostOf(r);
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    assert.equal(s.status, 202, JSON.stringify(s.body));
    assert.equal(s.body.kind, "wifi-move");
    assert.deepEqual(s.body.params, { ssid: "workshop-wifi", open: false });
    const j = await r.done(s.body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(stepStatuses(j), "check:done send:done switch:done find:done save:done");
    const res = result(j);
    assert.equal(res.outcome, "ok");
    assert.equal(res.oldHost, oldHost);
    assert.equal(res.newHost, `127.0.0.1:${r.newPort}`);
    assert.equal(res.addressChanged, true);
    assert.equal(res.staticIpReset, false);
    assert.equal(hostOf(r), `127.0.0.1:${r.newPort}`);
    assert.equal(r.dev.port, r.newPort);
    const sum = await fetchJson<DeviceSummary>(`${r.base}/api/devices/${r.id}`);
    assert.equal(sum.body.health, "online");
    assert.equal(sum.body.host, `127.0.0.1:${r.newPort}`);
    const again = await fetchJson<WifiMoveSettings>(r.wifi);
    assert.equal(again.body.lastChange?.result, "ok");
    assert.equal(again.body.lastChange?.ssid, "workshop-wifi");
  });

  test("a static address is reset to DHCP and the result says so", async () => {
    const r = await rig();
    const p = r.dev.state.pending!;
    p.saved = { ...p.dhcp, mode: "static", ip: "192.168.1.50" };
    r.dev.state.network.ip_mode = "static";
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    const j = await r.done(s.body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(result(j).staticIpReset, true);
    assert.equal(r.dev.state.network.ip_mode, "dhcp");
  });

  test("the device stays at its address (same address on the new network)", async () => {
    const r = await rig({ fake: { wifiMoves: {} } });
    const s = await r.start({ ssid: "guest" });
    assert.deepEqual(s.body.params, { ssid: "guest", open: true });
    const j = await r.done(s.body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(result(j).addressChanged, false);
    assert.equal(result(j).newHost, `127.0.0.1:${r.dev.port}`);
    assert.equal(stepStatuses(j), "check:done send:done switch:done find:done save:skipped");
  });

  test("the reply is lost (the link dies) and the move still works", async () => {
    const r = await rig({ fake: { wifiSetDropsResponse: true } });
    const j = await r.done((await r.start({ ssid: "workshop-wifi", password: PASSWORD })).body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(hostOf(r), `127.0.0.1:${r.newPort}`);
  });
});

describe("a move that fails and is undone by the device", () => {
  const cases: [string, string, string, RegExp][] = [
    ["wrong password", "auth", "workshop-wifi", /refused the password/],
    ["network not found", "no_ap", "noap", /could not find that network/],
    ["no address from the router", "no_ip", "noip", /did not get an address/],
    ["timeout", "timeout", "timeout", /in time/],
    ["connect failed", "connect_failed", "connect", /could not connect/],
  ];
  for (const [name, code, ssid, words] of cases) {
    test(`${name}: job failed (${code}), previous network restored, address unchanged`, async () => {
      const r = await rig();
      const before = hostOf(r);
      const password = code === "auth" ? "wrong-password" : PASSWORD;
      const s = await r.start({ ssid, password });
      const j = await r.done(s.body.id);
      assert.equal(j.state, "failed");
      assert.equal(j.error?.code, code);
      assert.match(j.error?.message ?? "", words);
      assert.match(j.error?.message ?? "", /previous network/);
      const res = result(j);
      assert.equal(res.outcome, "failed");
      assert.equal(res.reasonCode, code);
      assert.equal(res.restoredPrevious, true);
      assert.equal(res.addressChanged, false);
      assert.equal(hostOf(r), before);
      assert.equal(r.dev.port, Number(before.split(":")[1]), "it never moved");
      assert.equal(j.devices[0]?.state, "reverted");
      const sum = await fetchJson<DeviceSummary>(`${r.base}/api/devices/${r.id}`);
      assert.equal(sum.body.health, "online");
    });
  }

  test("a lost reply and a failure: found at its old address with the failed record", async () => {
    const r = await rig({ fake: { wifiSetFails: true, wifiSetDropsResponse: true } });
    const j = await r.done((await r.start({ ssid: "workshop-wifi", password: PASSWORD })).body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "auth");
    assert.equal(result(j).restoredPrevious, true);
  });

  test("save_failed keeps its special meaning: it is not described as going back", async () => {
    const r = await rig();
    const j = await r.done((await r.start({ ssid: "savefail", password: PASSWORD })).body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "save_failed");
    assert.match(j.error?.message ?? "", /could not save it.*restarts/);
    assert.doesNotMatch(j.error?.message ?? "", /went back/);
    assert.equal(result(j).restoredPrevious, false);
  });

  test("the device answers ok:false without a record: its own message, verbatim", async () => {
    const r = await rig();
    // Make the fake refuse before it records anything.
    const orig = r.dev.options.wifiSetFails;
    assert.equal(orig, false);
    r.dev.state.pending!.wifiTesting = true; // "wifi test failed; credentials not saved" with no new seq
    const check = await post<WifiMoveCheckResult>(`${r.wifi}/check`, { ssid: "x" });
    assert.equal(check.body.ok, true, "the fake's flag is internal; the device record says none");
    const j = await r.done((await r.start({ ssid: "workshop-wifi", password: PASSWORD })).body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "device_refused");
    assert.match(j.error?.message ?? "", /wifi test failed; credentials not saved/);
    assert.equal(hostOf(r), `127.0.0.1:${r.dev.port}`);
  });
});

describe("a device that is not found", () => {
  test("moved to an address nobody looks at: not_found with the recovery advice, registry untouched", async () => {
    const r = await rig({ known: false, move: { findTimeoutMs: 900 } });
    const before = hostOf(r);
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    const j = await r.done(s.body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "not_found");
    assert.match(j.error?.message ?? "", /connect this PC to "workshop-wifi" and scan again/);
    assert.match(j.error?.message ?? "", /Recover over its setup Wi-Fi/);
    assert.equal(result(j).outcome, "not_found");
    assert.equal(hostOf(r), before);
    assert.equal(stepStatuses(j), "check:done send:done switch:done find:failed save:skipped");
    const sum = await fetchJson<DeviceSummary>(`${r.base}/api/devices/${r.id}`);
    assert.notEqual(sum.body.health, "updating", "the Manager lets go of the device");
  });

  test("timeoutS in the request shortens the wait", async () => {
    const r = await rig({ known: false, move: { findTimeoutMs: 60_000 } });
    const t0 = Date.now();
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD, timeoutS: 1 });
    const j = await r.done(s.body.id);
    assert.equal(j.error?.code, "not_found");
    assert.match(j.error?.message ?? "", /within 1 second/);
    assert.ok(Date.now() - t0 < 15_000);
  });
});

describe("cancel", () => {
  test("stops waiting, says the device may already have moved, and lets go of the device", async () => {
    const r = await rig({ known: false, move: { findTimeoutMs: 30_000 } });
    const s = await r.start({ ssid: "workshop-wifi", password: PASSWORD });
    await waitUntil(() => r.srv.app.jobs.get(s.body.id)?.steps.find((x) => x.id === "switch")?.status === "running", 3000);
    const c = await post<Job>(`${r.base}/api/jobs/${s.body.id}/cancel`);
    assert.equal(c.status, 200);
    const j = await r.done(s.body.id);
    assert.equal(j.state, "cancelled");
    assert.equal(result(j).outcome, "unknown");
    assert.match(result(j).reason ?? "", /may already have moved/);
    const sum = await fetchJson<DeviceSummary>(`${r.base}/api/devices/${r.id}`);
    assert.notEqual(sum.body.health, "updating");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The password
// ---------------------------------------------------------------------------------------------------------------

describe("the password", () => {
  for (const failing of [false, true]) {
    test(`appears in no response, WebSocket frame, data file or log line (${failing ? "failed" : "successful"} move)`, async () => {
      const secret = failing ? "wrong-password" : "WIFIpass-LEAK-5528";
      const r = await rig({ fake: failing ? {} : {} });
      const rec = await FrameRecorder.connect({ srv: r.srv } as never);
      const responses: string[] = [];
      const s = await r.start({ ssid: "workshop-wifi", password: secret });
      responses.push(JSON.stringify(s.body));
      const j = await r.done(s.body.id);
      assert.equal(j.state, failing ? "failed" : "succeeded", JSON.stringify(j.error));
      responses.push(JSON.stringify(j));
      for (const p of ["/api/jobs", `/api/jobs/${s.body.id}`, "/api/devices", `/api/devices/${r.id}`, "/api/settings", "/api/openapi.json", `/api/devices/${r.id}/wifi`]) {
        responses.push(JSON.stringify((await fetchJson(`${r.base}${p}`)).body));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      await r.srv.app.registry.flush?.();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const all = [...responses, ...rec.frames, readAllFiles(r.srv.dataDir), r.logs.join("\n")].join("\n----\n");
      rec.close();
      assert.ok(all.includes("workshop-wifi"), "sanity: the snapshot contains job data");
      assert.ok(rec.frames.some((f) => f.includes('"t":"job"')), "sanity: job frames were recorded");
      assert.ok(!all.includes(secret), "the password leaked");
      assert.ok(!all.includes(secret.slice(2, -2)), "part of the password leaked");
    });
  }
});
