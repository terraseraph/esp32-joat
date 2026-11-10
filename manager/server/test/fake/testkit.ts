/** Helpers shared by the fake-device tests (and reusable by later milestones' tests). */
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { DeviceEnvelope, DeviceStatus, DeviceWsEvent } from "../../src/types/device-api";
import { fetchJson, type JsonResponse } from "../helpers";
import type { FakeDevice, FakeDeviceOptions } from "./fakeDevice";

/** Small delays so the whole suite stays fast. */
export const FAST: FakeDeviceOptions = {
  telemetryIntervalMs: 0,
  rebootMs: 150,
  scanDelayMs: 120,
  wifiSetDelayMs: 80,
  verifyMs: 120,
  otaRebootDelayMs: 40,
  otaApplyMs: 120,
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function get<T = unknown>(dev: FakeDevice, path: string): Promise<JsonResponse<T>> {
  return fetchJson<T>(`${dev.url}/api/v1${path}`);
}

export function post<T = unknown>(dev: FakeDevice, path: string, body: unknown): Promise<JsonResponse<T>> {
  return fetchJson<T>(`${dev.url}/api/v1${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** GET /pins with loosely typed values (tests poke at individual fields). */
export async function fetchPins(dev: FakeDevice): Promise<Record<string, Record<string, unknown>>> {
  return (await get<Record<string, Record<string, unknown>>>(dev, "/pins")).body;
}

export async function statusOf(dev: FakeDevice): Promise<DeviceStatus> {
  return (await get<DeviceStatus>(dev, "/status")).body;
}

/** Level of a `gpio_N` key from GET /pins. */
export async function level(dev: FakeDevice, key: string): Promise<number> {
  return (await fetchPins(dev))[key]?.level as number;
}

/** POST /command and return the envelope. */
export async function cmd<T = unknown>(dev: FakeDevice, body: Record<string, unknown>): Promise<DeviceEnvelope<T>> {
  const r = await post<DeviceEnvelope<T>>(dev, "/command", body);
  assert.equal(r.status, 200);
  return r.body;
}

/** Assert an envelope succeeded and return its result. */
export function result<T>(env: DeviceEnvelope<T>): T {
  assert.equal(env.ok, true, env.ok ? "" : `command failed: ${env.error}`);
  return (env as { result: T }).result;
}

/** Assert an envelope failed with exactly this error. */
export function failsWith(env: DeviceEnvelope<unknown>, error: string | RegExp): void {
  assert.equal(env.ok, false, "expected the command to fail");
  if (env.ok) return;
  assert.equal(env.v, 1);
  if (typeof error === "string") assert.equal(env.error, error);
  else assert.match(env.error, error);
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 3000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ok = await Promise.resolve(fn()).catch(() => false);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

type EventData<K extends DeviceWsEvent["topic"]> = Extract<DeviceWsEvent, { topic: K }>["data"];

export interface WsFrame {
  topic: string;
  data: unknown;
}

/** A device WebSocket client that records every frame (events and command replies). */
export class WsClient {
  readonly events: WsFrame[] = [];
  readonly replies: DeviceEnvelope<unknown>[] = [];
  closed = false;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof msg.topic === "string") this.events.push(msg as unknown as WsFrame);
      else this.replies.push(msg as unknown as DeviceEnvelope<unknown>);
    });
    ws.on("close", () => {
      this.closed = true;
    });
  }

  static connect(dev: FakeDevice): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${dev.host}:${dev.port}/api/v1/ws`);
      const c = new WsClient(ws);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }

  send(obj: unknown): void {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }

  /** Send a command and wait for its reply (matched by a unique `corr`). */
  async call<T = unknown>(body: Record<string, unknown>, timeoutMs = 3000): Promise<DeviceEnvelope<T>> {
    const corr = `c${Math.random().toString(36).slice(2)}`;
    this.send({ ...body, corr });
    await waitUntil(() => this.replies.some((r) => r.corr === corr), timeoutMs, `ws reply to ${String(body.cmd)}`);
    return this.replies.find((r) => r.corr === corr) as DeviceEnvelope<T>;
  }

  /** Frames of a topic received so far. */
  of<K extends DeviceWsEvent["topic"]>(topic: K): Array<EventData<K>> {
    return this.events.filter((e) => e.topic === topic).map((e) => e.data) as unknown as Array<EventData<K>>;
  }

  async waitFor(topic: string, pred: (data: unknown) => boolean = () => true, timeoutMs = 3000): Promise<unknown> {
    await waitUntil(() => this.events.some((e) => e.topic === topic && pred(e.data)), timeoutMs, `ws event ${topic}`);
    return this.events.find((e) => e.topic === topic && pred(e.data))?.data;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

/** Manual clock for the fake device's pending-firmware timers (`FakeDeviceOptions.clock`): time only moves in `advance`. */
export class ManualClock {
  private t = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  /** Move time forward, running due timers in order (timers scheduled by a callback run too when due). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = 0;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && tm.at < nextAt) {
          nextAt = tm.at;
          nextId = id;
        }
      }
      if (!nextId) break;
      const tm = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, tm.at);
      tm.fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.timers.size;
  }
}
