import assert from "node:assert/strict";
import net from "node:net";
import type { StartOptions } from "../src/app";
import type { DeviceSummary } from "../src/types/api";
import type { FirmwareImage } from "../src/types/api-firmware";
import type { Job } from "../src/types/api-jobs";
import { startFakeDevice, type FakeDevice } from "./fake/fakeDevice";
import { FAST, sleep } from "./fake/testkit";
import { fetchJson, startTestServer, type TestServer } from "./helpers";

/** Shared helpers of the firmware / OTA tests (not a test file itself). */

export const JSON_HEADERS = { "Content-Type": "application/json" };

/** Timings small enough for the fake's `FAST` delays. */
export const OTA_TIMINGS: NonNullable<StartOptions["firmware"]> = {
  verifyPollMs: 30,
  verifyTimeoutMs: 4000,
  pendingVerifyMs: 1500,
  statusTimeoutMs: 600,
  uploadIdleMs: 3000,
  uploadAnswerMs: 3000,
};

let idCounter = 0;
export const nextId = (): string => (0xfe5e1fa60000 + ++idCounter).toString(16);

export const startFake = (extra: Parameters<typeof startFakeDevice>[0] = {}): Promise<FakeDevice> =>
  startFakeDevice({ ...FAST, seed: "demo", id: nextId(), ...extra });

export interface OtaEnv {
  srv: TestServer;
  fakes: FakeDevice[];
  api(p: string): string;
  send<T = unknown>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }>;
  addDevice(d: FakeDevice | { port: number }): Promise<DeviceSummary>;
  upload(buf: Buffer, filename?: string): Promise<{ status: number; body: FirmwareImage }>;
  waitJob(id: string, until?: (j: Job) => boolean, timeoutMs?: number): Promise<Job>;
  summary(id: string): Promise<DeviceSummary>;
  fake(extra?: Parameters<typeof startFakeDevice>[0]): Promise<FakeDevice>;
  close(): Promise<void>;
}

export async function startOtaEnv(opts: Partial<StartOptions> = {}): Promise<OtaEnv> {
  const fakes: FakeDevice[] = [];
  const srv = await startTestServer({
    pollIntervalMs: 60_000,
    pollTimeoutMs: 400,
    rebootWindowMs: 5000,
    registrySaveDebounceMs: 40,
    discovery: { mdns: false, interfaces: () => [] },
    jobs: { wsThrottleMs: 0 },
    ...opts,
    firmware: { ...OTA_TIMINGS, ...opts.firmware },
  });
  const api = (p: string): string => `${srv.base}${p}`;
  const send = async <T>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetchJson<T>(api(p), { method, headers: JSON_HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: r.body };
  };
  return {
    srv,
    fakes,
    api,
    send,
    async addDevice(d) {
      const r = await send<DeviceSummary>("POST", "/api/devices", { host: `127.0.0.1:${d.port}` });
      assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
      return r.body;
    },
    async upload(buf, filename = "fw.bin") {
      const r = await fetchJson<FirmwareImage>(api("/api/firmware"), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Filename": filename },
        body: buf,
      });
      return { status: r.status, body: r.body };
    },
    async waitJob(id, until = (j) => ["succeeded", "failed", "partial", "cancelled"].includes(j.state), timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs;
      let last: Job | undefined;
      while (Date.now() < end) {
        last = (await send<Job>("GET", `/api/jobs/${id}`)).body;
        if (until(last)) return last;
        await sleep(15);
      }
      throw new Error(`job ${id} did not reach the wanted state; last: ${JSON.stringify(last)}`);
    },
    async summary(id) {
      return (await send<DeviceSummary>("GET", `/api/devices/${id}`)).body;
    },
    async fake(extra) {
      const f = await startFake(extra);
      fakes.push(f);
      return f;
    },
    async close() {
      await srv.close();
      await Promise.all(fakes.map((f) => f.close()));
    },
  };
}

/**
 * TCP proxy in front of a fake that stops reading from the client once `gateAfterBytes` bytes passed (until `release()`),
 * so an upload stays "in flight" and can be cancelled.
 */
export async function startGateProxy(targetPort: number, gateAfterBytes: number): Promise<{ port: number; release(): void; bytes(): number; close(): Promise<void> }> {
  let passed = 0;
  let released = false;
  const paused = new Set<net.Socket>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const up = net.connect(targetPort, "127.0.0.1");
    sockets.add(client);
    sockets.add(up);
    client.on("data", (c) => {
      passed += c.length;
      up.write(c);
      if (!released && passed >= gateAfterBytes) {
        client.pause();
        paused.add(client);
      }
    });
    up.on("data", (c) => client.write(c));
    const end = (): void => {
      client.destroy();
      up.destroy();
    };
    client.on("close", end);
    up.on("close", end);
    client.on("error", end);
    up.on("error", end);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    release() {
      released = true;
      for (const s of paused) s.resume();
      paused.clear();
    },
    bytes: () => passed,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
