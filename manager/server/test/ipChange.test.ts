import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Type } from "@sinclair/typebox";
import type { AppContext } from "../src/appContext";
import { defineRoute } from "../src/http/router";
import { parseIpChangeMap } from "../src/cli";
import { defaultResolveHost, refusalFor, type IpChangeConfig } from "../src/ipchange";
import { ipWarnings, parseIp4, validateIpChange } from "../src/ipchange/validate";
import type { IpChangeBody, IpCheckResult, IpField, IpJobResult, IpSettings } from "../src/types/api-ip";
import type { DeviceSummary, Job } from "../src/types/api";
import { startFakeDevice, type FakeDevice, type FakeDeviceOptions } from "./fake/fakeDevice";
import { FAST, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

const JSON_HEADERS = { "Content-Type": "application/json" };
const post = <T = unknown>(url: string, body?: unknown) =>
  fetchJson<T>(url, { method: "POST", headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const STATIC = { mode: "static", ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1" } as const;
const st = (over: Partial<Record<"ip" | "netmask" | "gateway" | "dns", string>> = {}): IpChangeBody => ({ ...STATIC, ...over });
const fieldsOf = (b: IpChangeBody): IpField[] => validateIpChange(b).errors.map((e) => e.field);

// ---------------------------------------------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------------------------------------------

describe("validation (mirrors the firmware rules)", () => {
  test("a valid config passes, dns defaults to the gateway", () => {
    const v = validateIpChange(st());
    assert.deepEqual(v.errors, []);
    assert.deepEqual(v.config, { ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: "192.168.1.1" });
    assert.equal(validateIpChange(st({ dns: "" })).config?.dns, "192.168.1.1");
    assert.equal(validateIpChange(st({ dns: "8.8.8.8" })).config?.dns, "8.8.8.8");
    assert.deepEqual(validateIpChange({ mode: "dhcp" }), { errors: [] });
  });

  const table: [string, IpChangeBody, IpField[]][] = [
    ["not a dotted quad", st({ ip: "192.168.1" }), ["ip"]],
    ["leading zero", st({ ip: "192.168.01.50" }), ["ip"]],
    ["octet above 255", st({ gateway: "192.168.1.256" }), ["gateway"]],
    ["words", st({ netmask: "wide" }), ["netmask"]],
    ["empty ip", st({ ip: "" }), ["ip"]],
    ["non contiguous netmask", st({ netmask: "255.0.255.0" }), ["netmask"]],
    ["netmask /31", st({ netmask: "255.255.255.254" }), ["netmask"]],
    ["netmask /0", st({ netmask: "0.0.0.0" }), ["netmask"]],
    ["loopback ip", st({ ip: "127.0.0.5", gateway: "127.0.0.1", netmask: "255.0.0.0" }), ["ip", "gateway"]],
    ["multicast ip", st({ ip: "224.0.0.9" }), ["ip"]],
    ["0.x ip", st({ ip: "0.1.2.3" }), ["ip"]],
    ["gateway in another subnet", st({ gateway: "192.168.2.1" }), ["gateway"]],
    ["ip equals gateway", st({ ip: "192.168.1.1" }), ["ip"]],
    ["ip is the network address", st({ ip: "192.168.1.0" }), ["ip"]],
    ["ip is the broadcast address", st({ ip: "192.168.1.255" }), ["ip"]],
    ["gateway is the broadcast address", st({ gateway: "192.168.1.255" }), ["gateway"]],
    ["overlaps the setup network", st({ ip: "192.168.4.20", gateway: "192.168.4.1" }), ["ip"]],
    ["wide network containing the setup network", st({ ip: "192.168.1.5", netmask: "255.255.0.0" }), ["ip"]],
    ["dns not an address", st({ dns: "dns.example" }), ["dns"]],
    ["dns multicast", st({ dns: "239.1.1.1" }), ["dns"]],
    ["several problems are all reported", st({ ip: "x", netmask: "y", gateway: "z", dns: "w" }), ["ip", "netmask", "gateway", "dns"]],
  ];
  for (const [name, body, fields] of table) {
    test(`invalid: ${name}`, () => {
      const v = validateIpChange(body);
      assert.deepEqual(fieldsOf(body), fields);
      assert.equal(v.config, undefined);
      for (const e of v.errors) assert.ok(e.message.length > 10 && !/0x|errno|undefined/i.test(e.message), e.message);
    });
  }

  test("valid edge cases: /30, /8 outside the setup range, the lowest and highest hosts", () => {
    assert.deepEqual(fieldsOf(st({ ip: "10.0.0.2", netmask: "255.255.255.252", gateway: "10.0.0.1" })), []);
    assert.deepEqual(fieldsOf(st({ ip: "10.20.30.40", netmask: "255.0.0.0", gateway: "10.0.0.1" })), []);
    assert.deepEqual(fieldsOf(st({ ip: "192.168.1.254", gateway: "192.168.1.1" })), []);
    assert.deepEqual(fieldsOf(st({ ip: "192.168.5.9", gateway: "192.168.5.1" })), []);
    assert.equal(parseIp4("1.2.3.4"), 0x01020304);
    assert.equal(parseIp4("1.2.3.4 "), null);
  });
});

describe("warnings", () => {
  const base = { interfaces: [{ address: "192.168.1.10", netmask: "255.255.255.0" }], others: [] as { name: string; host: string }[] };
  test("an address outside every PC network", () => {
    assert.deepEqual(ipWarnings({ ...base, body: st() }), []);
    const w = ipWarnings({ ...base, body: st({ ip: "10.0.0.5", gateway: "10.0.0.1" }) });
    assert.deepEqual(w.map((x) => x.code), ["outside_pc_subnets"]);
    assert.deepEqual(ipWarnings({ ...base, interfaces: [], body: st({ ip: "10.0.0.5", gateway: "10.0.0.1" }) }), [], "unknown networks give no warning");
  });
  test("an address used by another registered device (port ignored)", () => {
    const w = ipWarnings({ ...base, others: [{ name: "Kitchen", host: "192.168.1.50:8080" }, { name: "Other", host: "192.168.1.51" }], body: st() });
    assert.equal(w.length, 1);
    assert.equal(w[0]?.code, "address_in_use");
    assert.match(w[0]?.message ?? "", /Kitchen/);
  });
  test("same as current", () => {
    const current = { mode: "static", ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: "192.168.1.1" };
    assert.deepEqual(ipWarnings({ ...base, body: st(), current }).map((x) => x.code), ["same_as_current"]);
    assert.deepEqual(ipWarnings({ ...base, body: st({ dns: "8.8.8.8" }), current }), []);
    assert.deepEqual(ipWarnings({ ...base, body: { mode: "dhcp" }, current: { ...current, mode: "dhcp" } }).map((x) => x.code), ["same_as_current"]);
    assert.deepEqual(ipWarnings({ ...base, body: { mode: "dhcp" }, current }), []);
  });
});

describe("helpers", () => {
  test("defaultResolveHost: new address with the current port, loopback stays", () => {
    assert.equal(defaultResolveHost("192.168.1.50", "192.168.1.42"), "192.168.1.50");
    assert.equal(defaultResolveHost("192.168.1.50", "192.168.1.42:8080"), "192.168.1.50:8080");
    assert.equal(defaultResolveHost("192.168.1.50", "127.0.0.1:8221"), "127.0.0.1:8221");
  });
  test("refusalFor turns the device's words into plain ones", () => {
    const e = (t: string) => refusalFor(t);
    assert.equal(e("no saved wifi network").code, "ip_change_refused");
    assert.match(e("no saved wifi network").message, /no saved Wi-Fi/);
    assert.match(e("wifi change in progress").message, /testing a Wi-Fi change/);
    assert.match(e("ip change already pending").message, /already waiting/);
    assert.match(e("station not connected").message, /not connected/);
    assert.match(e("weird").message, /refused the change: weird/);
    const v = e("gateway must be in the same subnet as ip");
    assert.equal(v.status, 422);
    assert.equal(v.code, "invalid_ip_config");
  });
  test("--ip-change-map parsing", () => {
    assert.deepEqual(parseIpChangeMap(["192.168.1.50=127.0.0.1:8221", "10.0.0.2=127.0.0.1:9"]), { "192.168.1.50": "127.0.0.1:8221", "10.0.0.2": "127.0.0.1:9" });
    assert.throws(() => parseIpChangeMap(["nope"]), /Invalid --ip-change-map/);
    assert.throws(() => parseIpChangeMap(["1.2.3.4="]), /Invalid --ip-change-map/);
    assert.throws(() => parseIpChangeMap(["999.1.1.1=127.0.0.1:1"]), /Invalid --ip-change-map/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The routes and the job, against the fake device (pending firmware)
// ---------------------------------------------------------------------------------------------------------------

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** Start the server with a throwaway route that hands the test the app context (the same trick as the job tests). */
async function startWithApp(opts: Parameters<typeof startTestServer>[0]): Promise<TestServer & { app: AppContext }> {
  let captured: AppContext | undefined;
  const route = defineRoute({ method: "GET", path: "/api/test/app", summary: "test", tags: ["test"], response: Type.Unknown(), handler: ({ app }) => { captured = app; return { body: {} }; } });
  const srv = await startTestServer({ ...opts, extraRoutes: [route] });
  await fetchJson(`${srv.base}/api/test/app`);
  assert.ok(captured);
  return Object.assign(srv, { app: captured });
}

interface Rig {
  srv: TestServer & { app: AppContext };
  dev: FakeDevice;
  id: string;
  ip: string;
  url: string;
  job(id: string): Promise<Job>;
  start(body: unknown): Promise<{ status: number; body: Job & { code?: string; details?: unknown } }>;
  summary(): Promise<DeviceSummary>;
}

const FAST_IP: IpChangeConfig = { applyDelayMs: 40, probeIntervalMs: 25, probeTimeoutMs: 300, reachTimeoutMs: 400, dhcpTimeoutMs: 1500, confirmWindowMs: 5000, interfaces: () => [] };

async function rig(opts: { fake?: FakeDeviceOptions; ip?: IpChangeConfig } = {}): Promise<Rig> {
  const dev = await startFakeDevice({ ...FAST, pendingFirmware: true, ipApplyDelayMs: 30, ipConfirmWindowMs: 5000, ...opts.fake });
  const srv = await startWithApp({
    pollIntervalMs: 60_000,
    pollTimeoutMs: 400,
    registrySaveDebounceMs: 40,
    networkScan: false,
    discovery: { mdns: false, interfaces: () => [] },
    jobs: { wsThrottleMs: 0 },
    ipChange: { ...FAST_IP, ...opts.ip },
  });
  cleanup.push(async () => {
    await srv.close();
    await dev.close();
  });
  const added = await post<DeviceSummary>(`${srv.base}/api/devices`, { host: `127.0.0.1:${dev.port}` });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const id = dev.id;
  const ip = `${srv.base}/api/devices/${id}/ip`;
  return {
    srv,
    dev,
    id,
    ip: `127.0.0.1:${dev.port}`,
    url: ip,
    async job(jobId) {
      const j = await srv.app.jobs.whenDone(jobId);
      return j;
    },
    start: (body) => post(ip, body) as never,
    async summary() {
      return (await fetchJson<DeviceSummary>(`${srv.base}/api/devices/${id}`)).body;
    },
  };
}

const registryHost = (r: Rig): string => r.srv.app.registry.get(r.id)?.host ?? "";
const result = (j: Job): IpJobResult => j.result as IpJobResult;
const stepStatuses = (j: Job): string => j.steps.map((s) => `${s.id}:${s.status}`).join(" ");

describe("GET /api/devices/:id/ip", () => {
  test("pending firmware: dhcp settings", async () => {
    const r = await rig();
    const g = await fetchJson<IpSettings>(r.url);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, {
      supported: true,
      reason: null,
      ipMode: "dhcp",
      ip: "192.168.1.42",
      netmask: "255.255.255.0",
      gateway: "192.168.1.1",
      dns: "192.168.1.1",
      staConnected: true,
      ipChange: { result: "none" },
      activeJobId: null,
    });
  });

  test("current firmware: not supported, with a plain reason; starting is a 409", async () => {
    const r = await rig({ fake: { pendingFirmware: false } });
    const g = await fetchJson<IpSettings>(r.url);
    assert.equal(g.body.supported, false);
    assert.equal(g.body.ipMode, null);
    assert.equal(g.body.ipChange, null);
    assert.match(g.body.reason ?? "", /firmware/);
    const s = await r.start(STATIC);
    assert.equal(s.status, 409);
    assert.equal(s.body.code, "ip_change_unsupported");
    const c = await post<IpCheckResult>(`${r.url}/check`, STATIC);
    assert.equal(c.body.ok, false);
    assert.equal(c.body.errors[0]?.field, "mode");
  });

  test("unknown device is 404, an unreachable device is 502", async () => {
    const r = await rig();
    assert.equal((await fetchJson(`${r.srv.base}/api/devices/aaaaaaaaaaaa/ip`)).status, 404);
    r.dev.goOffline("refuse");
    const g = await fetchJson<{ transport: boolean; code: string }>(r.url);
    assert.equal(g.status, 502);
    assert.equal(g.body.transport, true);
    assert.equal((await post(`${r.url}/check`, STATIC)).status, 200, "the rules still apply without the device");
    assert.equal((await r.start(STATIC)).status, 502);
  });
});

describe("POST /api/devices/:id/ip/check", () => {
  test("valid, invalid and warnings", async () => {
    const r = await rig({ ip: { interfaces: () => [{ address: "192.168.1.10", netmask: "255.255.255.0" }] } });
    const ok = await post<IpCheckResult>(`${r.url}/check`, STATIC);
    assert.deepEqual(ok.body, { ok: true, errors: [], warnings: [] });
    const bad = await post<IpCheckResult>(`${r.url}/check`, { ...STATIC, ip: "192.168.1.1" });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    assert.deepEqual(bad.body.errors.map((e) => e.field), ["ip"]);
    const away = await post<IpCheckResult>(`${r.url}/check`, { ...STATIC, ip: "10.9.8.7", gateway: "10.9.8.1" });
    assert.deepEqual(away.body.warnings.map((w) => w.code), ["outside_pc_subnets"]);
    assert.equal(away.body.ok, true);
    const same = await post<IpCheckResult>(`${r.url}/check`, { mode: "dhcp" });
    assert.deepEqual(same.body.warnings.map((w) => w.code), ["same_as_current"]);
    assert.equal((await post(`${r.url}/check`, { mode: "static", ip: "1.2.3.4" })).status, 400, "missing fields are a malformed body");
  });

  test("not connected: static is refused with a mode error, dhcp is fine", async () => {
    const r = await rig();
    r.dev.state.network.sta_connected = false;
    const c = await post<IpCheckResult>(`${r.url}/check`, STATIC);
    assert.deepEqual(c.body.errors.map((e) => e.field), ["mode"]);
    assert.equal((await post<IpCheckResult>(`${r.url}/check`, { mode: "dhcp" })).body.ok, true);
  });
});

describe("static change", () => {
  test("set -> reach -> confirm -> ok; loopback device keeps its stored host", async () => {
    const r = await rig();
    const s = await r.start(STATIC);
    assert.equal(s.status, 201);
    assert.equal(s.body.kind, "ip-change");
    assert.deepEqual(s.body.steps.map((x) => x.id), ["check", "send", "apply", "reach", "confirm", "save"]);
    assert.deepEqual(s.body.params, { mode: "static", ip: "192.168.1.50", netmask: "255.255.255.0", gateway: "192.168.1.1", dns: "192.168.1.1" });
    const j = await r.job(s.body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(stepStatuses(j), "check:done send:done apply:done reach:done confirm:done save:done");
    assert.deepEqual(result(j), { outcome: "ok", reason: null, host: r.ip, ipMode: "static" });
    assert.equal(registryHost(r), r.ip);
    assert.equal(j.devices[0]?.state, "done");

    const g = (await fetchJson<IpSettings>(r.url)).body;
    assert.equal(g.ipMode, "static");
    assert.equal(g.ip, "192.168.1.50");
    assert.equal(g.ipChange?.result, "ok");
    assert.equal(g.ipChange?.reason, "confirmed");
    assert.equal(g.activeJobId, null);
    await waitUntil(async () => (await r.summary()).ip_mode === "static", 2000, "summary ip_mode");
  });

  test("a device that really moved: the stored host becomes the new address, port kept", async () => {
    // Bound to every loopback address, so 127.0.0.2 reaches the same fake: stands in for "the new address".
    const dev = await startFakeDevice({ ...FAST, pendingFirmware: true, ipApplyDelayMs: 30, host: "0.0.0.0" });
    const srv = await startWithApp({
      pollIntervalMs: 60_000,
      pollTimeoutMs: 400,
      registrySaveDebounceMs: 40,
      networkScan: false,
      discovery: { mdns: false, interfaces: () => [] },
      jobs: { wsThrottleMs: 0 },
      ipChange: { ...FAST_IP, resolveHost: (_ip, cur) => cur.replace("127.0.0.1", "127.0.0.2") },
    });
    cleanup.push(async () => {
      await srv.close();
      await dev.close();
    });
    assert.equal((await post(`${srv.base}/api/devices`, { host: `127.0.0.1:${dev.port}` })).status, 201);
    const s = await post<Job>(`${srv.base}/api/devices/${dev.id}/ip`, STATIC);
    const j = await srv.app.jobs.whenDone(s.body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(srv.app.registry.get(dev.id)?.host, `127.0.0.2:${dev.port}`);
    assert.equal(result(j).host, `127.0.0.2:${dev.port}`);
  });

  test("the confirm step shows the seconds left", async () => {
    const r = await rig();
    const seen: string[] = [];
    r.srv.app.jobs.onChange((j) => {
      const d = j.steps.find((x) => x.id === "confirm")?.detail;
      if (d) seen.push(d);
    });
    const s = await r.start(STATIC);
    await r.job(s.body.id);
    assert.ok(seen.some((d) => /^\d+ seconds left to confirm$/.test(d)), seen.join(" | "));
  });

  test("an unreachable new address: waits for the device to go back, then ends reverted with a plain message; the stored host is unchanged", async () => {
    const r = await rig({ fake: { ipConfirmWindowMs: 500 }, ip: { hostMap: { "192.168.1.50": "127.0.0.1:1" }, confirmWindowMs: 500, revertMarginMs: 1500 } });
    const seen: string[] = [];
    r.srv.app.jobs.onChange((j) => {
      const s = j.steps.find((x) => x.id === "revert");
      if (s?.detail) seen.push(s.detail);
    });
    const s = await r.start(STATIC);
    const j = await r.job(s.body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "reverted");
    assert.equal(j.error?.step, "revert");
    assert.equal(j.error?.message, "Could not reach the device at 192.168.1.50; it went back to 192.168.1.42 (DHCP) by itself. Nothing was changed.");
    assert.equal(result(j).outcome, "reverted");
    assert.equal(result(j).host, r.ip);
    assert.equal(registryHost(r), r.ip);
    assert.equal(j.steps.find((x) => x.id === "revert")?.label, "Waiting for the device to go back to its previous setting");
    assert.equal(stepStatuses(j), "check:done send:done apply:done reach:failed confirm:skipped save:skipped revert:done");
    assert.ok(seen.some((d) => /^\d+ seconds? left\. Checking /.test(d)), "a countdown line is shown: " + seen.join(" | "));
    const g = (await fetchJson<IpSettings>(r.url)).body;
    assert.equal(g.ipMode, "dhcp");
    assert.equal(g.ipChange?.reason, "not_confirmed");
  });

  test("the countdown starts from confirm_left_s when the device reported it, else from the configured window", async () => {
    const r = await rig({ fake: { ipConfirmWindowMs: 5000 }, ip: { hostMap: { "192.168.1.50": "127.0.0.1:1" }, confirmWindowMs: 5000, revertMarginMs: 100 } });
    const seen: string[] = [];
    r.srv.app.jobs.onChange((j) => {
      const d = j.steps.find((x) => x.id === "revert")?.detail;
      if (d) seen.push(d);
    });
    const s = await r.start(STATIC);
    await waitUntil(() => seen.length > 0, 3000, "revert step detail");
    const m = /^(\d+) seconds? left/.exec(seen[0] ?? "");
    assert.ok(m, seen[0]);
    assert.ok(Number(m[1]) <= 5 && Number(m[1]) >= 3, seen[0]);
    r.srv.app.jobs.cancel(s.body.id);
    await r.job(s.body.id);
  });

  test("the device is not seen at the old address either: not_reachable with guidance", async () => {
    const r = await rig({ fake: { ipConfirmWindowMs: 100000 }, ip: { hostMap: { "192.168.1.50": "127.0.0.1:1" }, confirmWindowMs: 300, revertMarginMs: 200, reachTimeoutMs: 100 } });
    const s = await r.start(STATIC);
    await waitUntil(() => r.dev.state.pending?.ipSeq === 1, 1000);
    r.dev.goOffline("refuse");
    const j = await r.job(s.body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "not_reachable");
    assert.match(j.error?.message ?? "", /did not answer at its old address/);
    assert.match(j.error?.message ?? "", /scan/);
    assert.match(j.error?.message ?? "", /setup Wi-Fi/);
    assert.equal(result(j).outcome, "unknown");
    assert.equal(registryHost(r), r.ip);
  });

  test("cancel while waiting for the revert stops waiting with an honest message", async () => {
    const r = await rig({ fake: { ipConfirmWindowMs: 100000 }, ip: { hostMap: { "192.168.1.50": "127.0.0.1:1" }, confirmWindowMs: 60000, reachTimeoutMs: 100 } });
    const s = await r.start(STATIC);
    await waitUntil(async () => (await r.srv.app.jobs.get(s.body.id))?.steps.find((x) => x.id === "revert")?.status === "running", 3000, "waiting step");
    r.srv.app.jobs.cancel(s.body.id);
    const j = await r.job(s.body.id);
    assert.equal(j.state, "cancelled");
    assert.match(j.message ?? "", /stopped waiting/);
    assert.match(j.message ?? "", /run a scan/);
    assert.equal(registryHost(r), r.ip);
  });

  test("the window closes before the confirm arrives: reverted", async () => {
    // The device applies after 20 ms and gives up after 150 ms; the Manager only looks after 400 ms.
    const r = await rig({ fake: { ipApplyDelayMs: 20, ipConfirmWindowMs: 150 }, ip: { applyDelayMs: 400 } });
    const s = await r.start(STATIC);
    const j = await r.job(s.body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "reverted");
    assert.equal(result(j).outcome, "reverted");
    assert.equal(j.devices[0]?.state, "reverted");
    assert.equal(registryHost(r), r.ip);
  });

  test("the device refuses the confirmation: confirm_refused", async () => {
    const r = await rig({ fake: { ipApplyDelayMs: 20 }, ip: { applyDelayMs: 100 } });
    const s = await r.start(STATIC);
    // After the reply, someone else confirms first and then the seq is stale: force a mismatch by bumping the device's seq.
    await waitUntil(() => r.dev.state.pending?.ipSeq === 1, 1000);
    r.dev.state.pending!.ipSeq = 7;
    if (r.dev.state.network.ip_change) r.dev.state.network.ip_change.seq = 8;
    const j = await r.job(s.body.id);
    assert.equal(j.state, "failed", JSON.stringify(j.result));
    assert.equal(j.error?.code, "confirm_refused");
    assert.equal(registryHost(r), r.ip);
  });

  test("cancel before the confirm: the job says the device reverts by itself", async () => {
    const r = await rig({ fake: { ipConfirmWindowMs: 300 }, ip: { applyDelayMs: 2000 } });
    const s = await r.start(STATIC);
    r.srv.app.jobs.cancel(s.body.id);
    const j = await r.job(s.body.id);
    assert.equal(j.state, "cancelled");
    assert.match(j.message ?? "", /goes back to its previous setting by itself/);
    assert.equal(result(j).outcome, "failed");
    assert.equal(registryHost(r), r.ip);
    await waitUntil(async () => (await fetchJson<IpSettings>(r.url)).body.ipChange?.result === "reverted", 3000, "device revert");
  });
});

describe("refusals and concurrency", () => {
  test("invalid settings: 422 invalid_ip_config with the errors as details; nothing is sent", async () => {
    const r = await rig();
    const s = await r.start({ ...STATIC, gateway: "10.0.0.1" });
    assert.equal(s.status, 422);
    assert.equal(s.body.code, "invalid_ip_config");
    assert.deepEqual((s.body.details as { field: string }[]).map((e) => e.field), ["gateway"]);
    assert.equal(r.dev.state.network.ip_change?.result, "none");
    assert.equal((await r.start({ mode: "static", ip: "1.2.3.4" })).status, 400);
    assert.equal((await r.start({ mode: "auto" })).status, 400);
  });

  test("the device refuses: no saved Wi-Fi, not connected, change already pending", async () => {
    const r = await rig();
    r.dev.state.network.provisioned = false;
    let s = await r.start(STATIC);
    assert.equal(s.status, 409);
    assert.equal(s.body.code, "ip_change_refused");
    assert.match((s.body as unknown as { error: string }).error, /no saved Wi-Fi/);
    r.dev.state.network.provisioned = true;
    r.dev.state.network.sta_connected = false;
    s = await r.start(STATIC);
    assert.equal(s.status, 409);
    assert.match((s.body as unknown as { error: string }).error, /not connected to Wi-Fi/);
    r.dev.state.network.sta_connected = true;
    r.dev.state.network.ip_change = { result: "pending", applied: true };
    s = await r.start(STATIC);
    assert.equal(s.status, 409);
    assert.equal(s.body.code, "ip_change_refused");
    assert.match((s.body as unknown as { error: string }).error, /already waiting/);
  });

  test("a second change while one runs is 409 ip_change_running, and GET shows the job", async () => {
    const r = await rig({ ip: { applyDelayMs: 600 } });
    const first = await r.start(STATIC);
    assert.equal(first.status, 201);
    const second = await r.start({ ...STATIC, ip: "192.168.1.51" });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "ip_change_running");
    assert.equal((await fetchJson<IpSettings>(r.url)).body.activeJobId, first.body.id);
    const done = await r.job(first.body.id);
    assert.equal(done.state, "succeeded");
    assert.equal((await fetchJson<IpSettings>(r.url)).body.activeJobId, null);
    // simultaneous requests: exactly one starts
    const [a, b] = await Promise.all([r.start({ mode: "dhcp" }), r.start({ mode: "dhcp" })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  });
});

describe("switching to DHCP", () => {
  test("static -> dhcp: confirms itself, no confirm step", async () => {
    const r = await rig();
    const a = await r.start(STATIC);
    assert.equal((await r.job(a.body.id)).state, "succeeded");
    const s = await r.start({ mode: "dhcp" });
    assert.equal(s.status, 201);
    const j = await r.job(s.body.id);
    assert.equal(j.state, "succeeded", JSON.stringify(j.error));
    assert.equal(stepStatuses(j), "check:done send:done apply:done reach:done confirm:skipped save:done");
    assert.deepEqual(result(j), { outcome: "ok", reason: null, host: r.ip, ipMode: "dhcp" });
    const g = (await fetchJson<IpSettings>(r.url)).body;
    assert.equal(g.ipMode, "dhcp");
    assert.equal(g.ipChange?.reason, "dhcp_lease");
  });

  test("a device that is offline switches at once", async () => {
    const r = await rig();
    r.dev.state.network.sta_connected = false;
    const j = await r.job((await r.start({ mode: "dhcp" })).body.id);
    assert.equal(j.state, "succeeded");
    assert.equal(stepStatuses(j), "check:done send:done apply:skipped reach:skipped confirm:skipped save:done");
    assert.equal(result(j).outcome, "ok");
  });

  test("no lease: the device kept its previous setting", async () => {
    const r = await rig({ fake: { ipApplyDelayMs: 60_000 } }); // the fake never applies it by itself; the test plays the device
    const s = await r.start({ mode: "dhcp" });
    r.dev.state.network.ip_change = { ...(r.dev.state.network.ip_change ?? { result: "pending" }), result: "reverted", reason: "no_dhcp_lease", applied: false };
    const j = await r.job(s.body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "no_dhcp_lease");
    assert.equal(result(j).outcome, "no_dhcp_lease");
    assert.equal(j.devices[0]?.state, "reverted");
    assert.equal(registryHost(r), r.ip);
  });

  test("the device cannot be found afterwards: lost_device, outcome unknown, host unchanged", async () => {
    const r = await rig({ fake: { ipApplyDelayMs: 60_000 }, ip: { dhcpTimeoutMs: 300 } });
    const s = await r.start({ mode: "dhcp" });
    r.dev.goOffline("refuse");
    const j = await r.job(s.body.id);
    assert.equal(j.state, "failed");
    assert.equal(j.error?.code, "lost_device");
    assert.equal(result(j).outcome, "unknown");
    assert.equal(registryHost(r), r.ip);
  });
});

describe("Wi-Fi change resets a static address", () => {
  test("GET shows dhcp and the device's reset record", async () => {
    const r = await rig();
    assert.equal((await r.job((await r.start(STATIC)).body.id)).state, "succeeded");
    assert.equal((await fetchJson<IpSettings>(r.url)).body.ipMode, "static");
    const w = await post(`${r.srv.base}/api/devices/${r.id}/command`, { cmd: "network.wifi.set", ssid: "othernet", password: "correct horse" });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const g = (await fetchJson<IpSettings>(r.url)).body;
    assert.equal(g.ipMode, "dhcp");
    assert.equal(g.ip, "192.168.1.42");
    assert.equal(g.ipChange?.result, "reset");
    assert.equal(g.ipChange?.reason, "wifi_change");
  });
});

describe("fleet summary", () => {
  test("ip_mode is null on firmware that does not report it, dhcp/static on newer firmware", async () => {
    const old = await rig({ fake: { pendingFirmware: false } });
    assert.equal((await old.summary()).ip_mode, null);
    const r = await rig();
    assert.equal((await r.summary()).ip_mode, "dhcp");
  });
});
