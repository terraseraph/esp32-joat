/** Shared rig for the SoftAP setup tests: a Manager with the simulated Wi-Fi plus one fake device in setup mode. Nothing real is touched. */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { StartOptions } from "../src/app";
import type { SetupTimings } from "../src/setup/job";
import type { Job } from "../src/types/api-jobs";
import { createFakeWifiAdapter, type FakeApSpec, type FakeWifiAdapter, type FakeWifiOptions } from "../src/wifi";
import { startFakeDevice, type FakeDevice, type FakeDeviceOptions } from "./fake/fakeDevice";
import { FAST, sleep, waitUntil } from "./fake/testkit";
import { fetchJson, startTestServer, tmpDataDir, type JsonResponse, type TestServer } from "./helpers";

export const DEVICE_ID = "a4cf12b3c4d5";
export const AP_SSID = "esp32-b3c4d5";
export const HOME = "HomeNet";

export const FAST_TIMINGS: Partial<SetupTimings> = {
  joinMs: 600,
  apReachMs: 500,
  wifiResultMs: 800,
  lanWaitMs: 600,
  chooseTimeoutMs: 1500,
  factoryResetWaitMs: 1500,
  pollMs: 20,
  rejoinMs: 600,
  probeMs: 300,
};

export interface RigOptions {
  /** Options of the fake device (spread over `FAST` + setup mode). */
  device?: FakeDeviceOptions;
  /** Overrides of the access point (secured, password, lanHost ...). The device's address is filled in. */
  ap?: Partial<FakeApSpec>;
  /** No `lanHost`: the device never shows up on the LAN. */
  noLan?: boolean;
  wifi?: Omit<FakeWifiOptions, "aps">;
  timings?: Partial<SetupTimings>;
  server?: Partial<StartOptions>;
  dataDir?: string;
}

export interface Rig {
  srv: TestServer;
  dev: FakeDevice;
  wifi: FakeWifiAdapter;
  /** Every log line of the Manager. */
  logs: string[];
  dataDir: string;
  close(): Promise<void>;
}

export async function startRig(o: RigOptions = {}): Promise<Rig> {
  const dev = await startFakeDevice({ ...FAST, id: DEVICE_ID, apMode: true, ...(o.device ?? {}) });
  const host = `127.0.0.1:${dev.port}`;
  const ap: FakeApSpec = { ssid: AP_SSID, host, ...(o.noLan ? {} : { lanHost: host }), ...(o.ap ?? {}) };
  const wifi = createFakeWifiAdapter({ aps: [ap], ...(o.wifi ?? {}) });
  const logs: string[] = [];
  const dataDir = o.dataDir ?? tmpDataDir();
  const srv = await startTestServer({
    dataDir,
    pollIntervalMs: 60_000,
    pollTimeoutMs: 400,
    registrySaveDebounceMs: 40,
    jobs: { wsThrottleMs: 0 },
    discovery: { mdns: false, interfaces: () => [], probeTimeoutMs: 300 },
    wifiAdapter: "fake",
    log: (m) => logs.push(m),
    setup: { adapter: wifi, timings: { ...FAST_TIMINGS, ...(o.timings ?? {}) } },
    ...(o.server ?? {}),
  });
  let closed = false;
  return {
    srv,
    dev,
    wifi,
    logs,
    dataDir,
    async close() {
      if (closed) return;
      closed = true;
      await srv.close();
      await dev.close();
    },
  };
}

export const apiGet = <T = unknown>(rig: Rig, p: string): Promise<JsonResponse<T>> => fetchJson<T>(`${rig.srv.base}${p}`);
export const apiPost = <T = unknown>(rig: Rig, p: string, body?: unknown): Promise<JsonResponse<T>> =>
  fetchJson<T>(`${rig.srv.base}${p}`, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });

export const TERMINAL = ["succeeded", "failed", "partial", "cancelled"];

export async function startJob(rig: Rig, body: Record<string, unknown>): Promise<Job> {
  const r = await apiPost<Job>(rig, "/api/setup/jobs", body);
  if (r.status !== 201) throw new Error(`POST /api/setup/jobs answered ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function getJob(rig: Rig, id: string): Promise<Job> {
  return (await apiGet<Job>(rig, `/api/jobs/${id}`)).body;
}

export async function finish(rig: Rig, id: string, timeoutMs = 8000): Promise<Job> {
  let job = await getJob(rig, id);
  await waitUntil(async () => {
    job = await getJob(rig, id);
    return TERMINAL.includes(job.state);
  }, timeoutMs, `job ${id} to finish`);
  return job;
}

/** Wait until the job's step is running (or the job waits in it), then return the job. */
export async function waitForStep(rig: Rig, id: string, step: string, timeoutMs = 4000): Promise<Job> {
  let job = await getJob(rig, id);
  await waitUntil(async () => {
    job = await getJob(rig, id);
    return job.steps.find((s) => s.id === step)?.status === "running";
  }, timeoutMs, `step ${step}`);
  return job;
}

export const stepStatuses = (job: Job): Record<string, string> => Object.fromEntries(job.steps.map((s) => [s.id, s.status]));

/** Start a job, cancel it once `step` is running, and return the final job. */
export async function cancelAt(rig: Rig, body: Record<string, unknown>, step: string): Promise<Job> {
  const job = await startJob(rig, body);
  await waitForStep(rig, job.id, step);
  await apiPost(rig, `/api/jobs/${job.id}/cancel`);
  return finish(rig, job.id);
}

/** Everything text-like a run left behind: every file under the data dir. */
export function readAllFiles(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p}\n${readFileSync(p, "utf8")}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.join("\n");
}

/** A browser WebSocket that keeps every raw frame. */
export class FrameRecorder {
  readonly frames: string[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => this.frames.push(raw.toString()));
  }
  static connect(rig: Rig): Promise<FrameRecorder> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${rig.srv.port}/api/ws`);
      const rec = new FrameRecorder(ws);
      ws.once("open", () => resolve(rec));
      ws.once("error", reject);
    });
  }
  close(): void {
    this.ws.close();
  }
}

/** The network is the way it was before the job: home network joined, no temporary profile left, no marker. */
export function networkIsBack(rig: Rig): { ok: boolean; why: string } {
  if (rig.wifi.connection.ssid !== HOME) return { ok: false, why: `connected to ${String(rig.wifi.connection.ssid)}` };
  const left = rig.wifi.profileNames().filter((n) => n !== HOME);
  if (left.length > 0) return { ok: false, why: `profiles left: ${left.join(", ")}` };
  if (existsSync(path.join(rig.dataDir, "setup-recovery.json"))) return { ok: false, why: "marker still there" };
  return { ok: true, why: "" };
}

export { sleep, waitUntil };
