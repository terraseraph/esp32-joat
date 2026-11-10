import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { backgroundDecision, createBackgroundTimer } from "../src/discovery";
import { browseMdns, MdnsCollector, type MdnsFactory, type MdnsLike, type MdnsPacket } from "../src/discovery/mdns";
import { buildSweepPlan, canonicalTarget, interfacesFromOs, parseSubnet, parseTarget, runPool, SubnetError, TargetError, type OsInterfaces } from "../src/discovery/sweep";
import { sleep } from "./fake/testkit";

// ---- sweep plan ---------------------------------------------------------------------------------------------------

test("sweep plan: a /24 interface gives .1-.254 minus its own address", () => {
  const plan = buildSweepPlan([{ address: "192.168.1.20", netmask: "255.255.255.0" }]);
  assert.deepEqual(plan.subnets, ["192.168.1.0/24"]);
  assert.equal(plan.hosts.length, 253);
  assert.equal(plan.hosts[0], "192.168.1.1");
  assert.equal(plan.hosts.at(-1), "192.168.1.254");
  assert.ok(!plan.hosts.includes("192.168.1.20"));
  assert.ok(!plan.hosts.includes("192.168.1.0") && !plan.hosts.includes("192.168.1.255"));
});

test("sweep plan: interfaces wider than /24 are clamped to the /24 containing the interface address", () => {
  const plan = buildSweepPlan([{ address: "10.1.2.30", netmask: "255.255.0.0" }]);
  assert.deepEqual(plan.subnets, ["10.1.2.0/24"]);
  assert.equal(plan.hosts.length, 253);
  assert.ok(plan.hosts.every((h) => h.startsWith("10.1.2.")));
});

test("sweep plan: narrower subnets keep their real size; /31 and /32 sweep nothing", () => {
  const small = buildSweepPlan([{ address: "172.16.0.5", netmask: "255.255.255.248" }]);
  assert.deepEqual(small.subnets, ["172.16.0.0/29"]);
  assert.deepEqual(small.hosts, ["172.16.0.1", "172.16.0.2", "172.16.0.3", "172.16.0.4", "172.16.0.6"]);
  assert.deepEqual(buildSweepPlan([{ address: "172.16.0.5", netmask: "255.255.255.255" }]), { subnets: [], hosts: [] });
});

test("sweep plan: own addresses on any interface are skipped and overlapping ranges are not repeated", () => {
  const plan = buildSweepPlan([
    { address: "192.168.1.20", netmask: "255.255.255.0" },
    { address: "192.168.1.21", netmask: "255.255.255.0" },
    { address: "192.168.7.9", netmask: "255.255.255.0" },
  ]);
  assert.deepEqual(plan.subnets, ["192.168.1.0/24", "192.168.7.0/24"]);
  assert.equal(plan.hosts.length, 252 + 253);
  assert.equal(new Set(plan.hosts).size, plan.hosts.length);
  assert.ok(!plan.hosts.includes("192.168.1.21"));
});

test("sweep plan: explicit subnets are added (wider than /24 clamped to the given address' /24)", () => {
  const plan = buildSweepPlan([], ["10.20.30.40/16", "192.168.5.0/24"]);
  assert.deepEqual(plan.subnets, ["10.20.30.0/24", "192.168.5.0/24"]);
  assert.equal(plan.hosts.length, 508);
  assert.deepEqual(parseSubnet("172.16.9.200/12"), parseSubnet("172.16.9.0/24"));
});

test("parseSubnet rejects anything that is not a sweepable CIDR", () => {
  for (const bad of ["192.168.1.0", "192.168.1.0/", "192.168.1.0/24/1", "300.1.1.1/24", "192.168.1.0/7", "192.168.1.0/31", "192.168.1.0/32", "127.0.0.0/24", "169.254.1.0/24", "224.0.0.0/24", "0.0.0.0/24", "banana", "", "192.168.1.0/ 24"]) {
    assert.throws(() => parseSubnet(bad), SubnetError, bad);
  }
  assert.throws(() => buildSweepPlan([], ["nope"]), SubnetError);
});

test("interfacesFromOs skips internal, loopback and link-local addresses and non-IPv4 families", () => {
  const raw: OsInterfaces = {
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
    eth0: [
      { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", internal: false },
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false },
      { address: "169.254.7.7", netmask: "255.255.0.0", family: "IPv4", internal: false },
    ],
    docker: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: 4, internal: false }],
    tun: [{ address: "127.5.5.5", netmask: "255.0.0.0", family: "IPv4", internal: false }],
  };
  assert.deepEqual(interfacesFromOs(raw), [
    { address: "192.168.1.20", netmask: "255.255.255.0" },
    { address: "172.17.0.1", netmask: "255.255.0.0" },
  ]);
});

test("targets: host[:port] parsing and canonical form", () => {
  assert.deepEqual(parseTarget("127.0.0.1:8101"), { host: "127.0.0.1", port: 8101, isIp: true });
  assert.equal(canonicalTarget("http://127.0.0.1:8101/"), "127.0.0.1:8101");
  assert.equal(canonicalTarget("192.168.1.5:80"), "192.168.1.5");
  assert.equal(canonicalTarget("ESP32-ABC.local"), "esp32-abc.local");
  for (const bad of ["", "a b", "1.2.3.4:99999", "https://1.2.3.4", "1.2.3.4/path", "999.1.1.1"]) assert.throws(() => canonicalTarget(bad), TargetError, bad);
});

test("runPool never exceeds its concurrency and stops when asked", async () => {
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await sleep(15);
    running--;
    seen.push(n);
    return n === 5 ? true : undefined;
  });
  assert.equal(peak, 3);
  assert.ok(seen.length < 10, "stopped early");
});

// ---- mDNS ---------------------------------------------------------------------------------------------------------

const txt = (...pairs: string[]): Buffer[] => pairs.map((p) => Buffer.from(p));

type FakeFactory = MdnsFactory & { instances: EventEmitter[]; destroyed: () => number };

function fakeFactory(packets: MdnsPacket[], extra: { onQuery?: (em: EventEmitter) => void; throwOnCreate?: Error } = {}): FakeFactory {
  const instances: EventEmitter[] = [];
  let destroyed = 0;
  const f = (() => {
    if (extra.throwOnCreate) throw extra.throwOnCreate;
    const em = new EventEmitter();
    instances.push(em);
    const like = Object.assign(em, {
      query() {
        setImmediate(() => {
          for (const p of packets) em.emit("response", p);
          extra.onQuery?.(em);
        });
      },
      destroy() {
        destroyed++;
      },
    });
    return like as unknown as MdnsLike;
  }) as FakeFactory;
  f.instances = instances;
  f.destroyed = () => destroyed;
  return f;
}

test("mdns collector: PTR + SRV + TXT + A become one candidate with the SRV port; TXT is parsed", () => {
  const c = new MdnsCollector();
  c.add({
    answers: [{ name: "_de-esp32._tcp.local", type: "PTR", data: "esp32-a1b2c3._de-esp32._tcp.local" }],
    additionals: [
      { name: "esp32-a1b2c3._de-esp32._tcp.local", type: "SRV", data: { port: 8123, target: "ESP32-A1B2C3.local" } },
      { name: "esp32-a1b2c3._de-esp32._tcp.local", type: "TXT", data: txt("id=a1b2c3d4e5f6", "api=/api/v1", "board=esp32-devkitc") },
      { name: "esp32-a1b2c3.local", type: "A", data: "192.168.1.77" },
    ],
  });
  assert.deepEqual(c.candidates(), [
    {
      ip: "192.168.1.77",
      port: 8123,
      txt: { id: "a1b2c3d4e5f6", api: "/api/v1", board: "esp32-devkitc" },
      instance: "esp32-a1b2c3._de-esp32._tcp.local",
      ours: true,
    },
  ]);
});

test("mdns collector: an _http._tcp instance is ours only when its TXT looks like ours; records can arrive in separate packets", () => {
  const c = new MdnsCollector();
  c.add({ answers: [{ name: "_http._tcp.local", type: "PTR", data: "thing._http._tcp.local" }] });
  c.add({ answers: [{ name: "thing._http._tcp.local", type: "SRV", data: { port: 80, target: "thing.local" } }] });
  c.add({ answers: [{ name: "thing.local", type: "A", data: "10.0.0.9" }] });
  c.add({ answers: [{ name: "printer._http._tcp.local", type: "SRV", data: { port: 631, target: "printer.local" } }] });
  c.add({ answers: [{ name: "printer.local", type: "A", data: "10.0.0.10" }] });
  c.add({ answers: [{ name: "thing._http._tcp.local", type: "TXT", data: txt("id=a1b2c3d4e5f6") }] });
  const out = c.candidates();
  assert.deepEqual(
    out.map((x) => [x.ip, x.port, x.ours]),
    [
      ["10.0.0.9", 80, true],
      ["10.0.0.10", 631, false],
    ],
  );
});

test("mdns collector: orphan A records are kept (port 80), AAAA and garbage are ignored", () => {
  const c = new MdnsCollector();
  c.add({
    answers: [
      { name: "esp32-abcdef.local", type: "A", data: "10.0.0.5" },
      { name: "other.local", type: "A", data: "10.0.0.6" },
      { name: "esp32-abcdef.local", type: "AAAA", data: "fe80::1" },
      { name: "x.local", type: "A", data: "not-an-ip" },
      null as unknown as { type: string },
    ],
  });
  assert.deepEqual(
    c.candidates().map((x) => [x.ip, x.port, x.ours]),
    [
      ["10.0.0.5", 80, true],
      ["10.0.0.6", 80, false],
    ],
  );
});

test("browseMdns: answers the query window, destroys the socket and never touches the network (fake socket)", async () => {
  const f = fakeFactory([
    {
      answers: [{ name: "_de-esp32._tcp.local", type: "PTR", data: "esp32-a._de-esp32._tcp.local" }],
      additionals: [
        { name: "esp32-a._de-esp32._tcp.local", type: "SRV", data: { port: 8001, target: "esp32-a.local" } },
        { name: "esp32-a.local", type: "A", data: "127.0.0.1" },
      ],
    },
  ]);
  const r = await browseMdns(f, { windowMs: 120 });
  assert.equal(r.warnings.length, 0);
  assert.equal(r.candidates.length, 1);
  assert.equal(f.destroyed(), 1);
});

test("browseMdns: a socket error ends the browse with a warning (EADDRINUSE hint) and what was heard so far", async () => {
  const f = fakeFactory([], { onQuery: (em) => em.emit("error", Object.assign(new Error("bind EADDRINUSE 0.0.0.0:5353"), { code: "EADDRINUSE" })) });
  const t0 = Date.now();
  const r = await browseMdns(f, { windowMs: 5000 });
  assert.ok(Date.now() - t0 < 1500, "finished early");
  assert.deepEqual(r.candidates, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0] as string, /mDNS socket error.*EADDRINUSE.*5353/);
  assert.equal(f.destroyed(), 1);
});

test("browseMdns: a factory that throws, and an aborted signal, both resolve cleanly", async () => {
  const bad = await browseMdns(fakeFactory([], { throwOnCreate: new Error("no multicast interface") }), { windowMs: 5000 });
  assert.deepEqual(bad.candidates, []);
  assert.match(bad.warnings[0] as string, /could not start: no multicast interface/);

  const ctrl = new AbortController();
  const p = browseMdns(fakeFactory([]), { windowMs: 5000, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 30);
  const t0 = Date.now();
  const r = await p;
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(r.warnings, []);
});

// ---- background scheduling ------------------------------------------------------------------------------------------

test("backgroundDecision: off by default, skipped while a scan runs, skipped above 50 devices", () => {
  assert.equal(backgroundDecision({ enabled: false, running: false, deviceCount: 1 }), "skip_disabled");
  assert.equal(backgroundDecision({ enabled: true, running: true, deviceCount: 1 }), "skip_running");
  assert.equal(backgroundDecision({ enabled: true, running: false, deviceCount: 51 }), "skip_many");
  assert.equal(backgroundDecision({ enabled: true, running: false, deviceCount: 50 }), "scan");
});

test("background timer ticks while enabled, honours period changes and stops when disabled or stopped", async () => {
  const cfg = { enabled: false, periodMs: 40 };
  let ticks = 0;
  const t = createBackgroundTimer({ getConfig: () => cfg, tick: () => void ticks++ });
  t.reschedule();
  await sleep(150);
  assert.equal(ticks, 0, "disabled: no ticks");

  cfg.enabled = true;
  t.reschedule();
  await sleep(230);
  assert.ok(ticks >= 3 && ticks <= 6, `ticks while enabled: ${ticks}`);

  cfg.enabled = false;
  t.reschedule();
  const after = ticks;
  await sleep(150);
  assert.equal(ticks, after, "disabled again: stopped");

  cfg.enabled = true;
  cfg.periodMs = 1000;
  t.reschedule();
  await sleep(150);
  assert.equal(ticks, after, "a long period does not tick early");
  t.stop();
  cfg.periodMs = 20;
  t.reschedule();
  await sleep(100);
  assert.equal(ticks, after, "stopped for good");
});
