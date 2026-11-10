import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";
import type { BrowserWsMessage, DeviceSummary } from "../src/types/api";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, sleep, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

/**
 * Health polling is skipped while a browser watches a device and its live link is healthy (spec 3.4); it resumes at once
 * when the link stops being live. The fake device's requestLog shows exactly which `/status` calls reached it.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
let counter = 0;
const nextId = (): string => (0xc1d2e3f40000 + ++counter).toString(16);

const OPTS = {
  pollIntervalMs: 100,
  pollTimeoutMs: 400,
  rebootWindowMs: 5000,
  registrySaveDebounceMs: 20,
  linkIdleCloseMs: 150,
  fullDetectMs: 400,
  livePollMs: 100,
  linkBackoffMinMs: 40,
  linkBackoffMaxMs: 200,
  hydrateSettleMs: 40,
  hydrateMaxMs: 500,
};

const statusCalls = (dev: FakeDevice, since = 0): number => dev.requestLog.filter((r) => r.kind === "http" && r.method === "GET" && r.path.endsWith("/status") && r.at >= since).length;

class Browser {
  readonly msgs: BrowserWsMessage[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => this.msgs.push(JSON.parse(d.toString()) as BrowserWsMessage));
  }
  static connect(url: string): Promise<Browser> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const b = new Browser(ws);
      ws.once("open", () => resolve(b));
      ws.once("error", reject);
    });
  }
  watch(...ids: string[]): void {
    this.ws.send(JSON.stringify({ t: "watch", ids }));
  }
  linkIs(id: string, state: string): boolean {
    return this.msgs.some((m) => m.t === "link" && m.id === id && m.ws === state);
  }
  close(): void {
    this.ws.close();
  }
}

describe("health polling while a device is watched", () => {
  let srv: TestServer;
  const fakes: FakeDevice[] = [];
  const browsers: Browser[] = [];
  const api = (p: string): string => `${srv.base}${p}`;

  const startFake = async (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> => {
    const d = await startFakeDevice({ ...FAST, seed: "demo", id: nextId(), telemetryIntervalMs: 50, ...extra });
    fakes.push(d);
    return d;
  };
  const add = async (d: FakeDevice, base = srv.base): Promise<string> => {
    const r = await fetchJson<DeviceSummary>(`${base}/api/devices`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ host: `127.0.0.1:${d.port}` }) });
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    return r.body.id;
  };
  const summary = async (id: string, base = srv.base): Promise<DeviceSummary> => (await fetchJson<DeviceSummary>(`${base}/api/devices/${id}`)).body;
  const watch = async (id: string, s: TestServer = srv): Promise<Browser> => {
    const b = await Browser.connect(`ws://127.0.0.1:${s.port}/api/ws`);
    browsers.push(b);
    b.watch(id);
    await waitUntil(() => b.linkIs(id, "open"), 3000, "link open");
    return b;
  };

  before(async () => {
    srv = await startTestServer({ ...OPTS, discovery: { mdns: false, interfaces: () => [] } });
  });
  after(async () => {
    for (const b of browsers) b.close();
    await srv.close();
    await Promise.all(fakes.map((f) => f.close()));
  });

  test("unwatched devices are polled every interval", async () => {
    const dev = await startFake();
    const id = await add(dev);
    const from = Date.now();
    await sleep(750);
    assert.ok(statusCalls(dev, from) >= 4, `only ${statusCalls(dev, from)} polls in 750 ms`);
    assert.equal((await summary(id)).health, "online");
  });

  test("watched + live: no /status request for many intervals; frames keep lastSeen fresh and the device online", async () => {
    const dev = await startFake();
    const id = await add(dev);
    await watch(id);
    await sleep(250); // let a poll that was already in flight finish
    const from = Date.now();
    const seen0 = (await summary(id)).lastSeen;
    await sleep(900); // ~9 poll intervals
    assert.equal(statusCalls(dev, from), 0, "the poller left the watched device alone");
    const s = await summary(id);
    assert.equal(s.health, "online");
    assert.equal(s.link, "open");
    assert.ok(seen0 && s.lastSeen && Date.parse(s.lastSeen) > Date.parse(seen0), `lastSeen moved on (${seen0} -> ${s.lastSeen})`);
    assert.ok(Date.now() - Date.parse(s.lastSeen ?? "0") < 600, "lastSeen is recent");
  });

  test("a telemetry frame refreshes the cached summary while the poller is idle", async () => {
    const dev = await startFake();
    const id = await add(dev);
    await watch(id);
    await sleep(250);
    const from = Date.now();
    dev.state.memory.internal.free = 123_456;
    await waitUntil(async () => (await summary(id)).memory.free === 123_456, 3000, "mem_free from telemetry");
    assert.equal(statusCalls(dev, from), 0, "no poll was needed for it");
  });

  test("unwatching resumes polling at once (not at the next interval)", async () => {
    const dev = await startFake();
    const id = await add(dev);
    const b = await watch(id);
    await sleep(250);
    const from = Date.now();
    b.close();
    // the device link stays open for linkIdleCloseMs (150), yet nobody watches: the poll comes now
    await waitUntil(() => statusCalls(dev, from) >= 1, 80 + 1000, "a poll right after the last watcher left");
    const first = dev.requestLog.find((r) => r.path.endsWith("/status") && r.at >= from);
    assert.ok(first && first.at - from < 90, `first poll ${first ? first.at - from : "never"} ms after unwatch`);
    await sleep(500);
    assert.ok(statusCalls(dev, from) >= 4, "normal polling again");
  });

  test("frames stop: polling resumes once the live window has run out", async () => {
    const dev = await startFake({ telemetryIntervalMs: 0 }); // no telemetry, only the hydrate burst
    const id = await add(dev);
    await sleep(250);
    await watch(id);
    const from = Date.now();
    await waitUntil(() => statusCalls(dev, from) >= 2, 2500, "polls after the frames stopped");
    assert.equal((await summary(id)).health, "online");
  });

  test("a manual refresh always polls, also while live", async () => {
    const dev = await startFake();
    const id = await add(dev);
    await watch(id);
    await sleep(250);
    const from = Date.now();
    const r = await fetchJson(api(`/api/devices/${id}/refresh`), { method: "POST" });
    assert.equal(r.status, 200);
    assert.ok(statusCalls(dev, from) >= 1);
  });

  test("the link drops: the device is polled at once (the poll interval here is 60 s)", async () => {
    const slow = await startTestServer({ ...OPTS, pollIntervalMs: 60_000, discovery: { mdns: false, interfaces: () => [] } });
    try {
      const dev = await startFake();
      const id = await add(dev, slow.base);
      await watch(id, slow);
      await sleep(150);
      assert.equal((await summary(id, slow.base)).health, "online");
      const from = Date.now();
      await dev.goOffline("refuse"); // kills the device socket; nothing but liveLost can notice within a minute
      await waitUntil(async () => (await summary(id, slow.base)).health !== "online", 2500, "health leaves online");
      assert.ok(Date.now() - from < 2500);
      await dev.goOnline();
      await waitUntil(async () => (await summary(id, slow.base)).health === "online", 4000, "online again after the device returns");
    } finally {
      await slow.close();
    }
  });
});
