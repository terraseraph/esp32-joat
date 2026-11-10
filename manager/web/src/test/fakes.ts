import { vi } from "vitest";

/** Minimal WebSocket double: tests drive it with open(), serverClose() and emit(). */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static last(): FakeWebSocket {
    const s = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!s) throw new Error("no FakeWebSocket created yet");
    return s;
  }

  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.serverClose();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  serverClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }
  emit(msg: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}

export type FetchRoutes = Record<string, { status?: number; body?: unknown } | (() => { status?: number; body?: unknown })>;

/** Stub global fetch with fixed JSON answers per path (unknown paths answer 404 with the error envelope). */
export function mockFetch(routes: FetchRoutes) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0] ?? "";
    const r = routes[path];
    if (!r) return new Response(JSON.stringify({ error: "Not found", code: "not_found" }), { status: 404 });
    const { status = 200, body } = typeof r === "function" ? r() : r;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export const HEALTH = { version: "0.1.0", lan: false, dataDir: "C:\\data", uptime: 12, startedAt: 1_700_000_000_000, networkScan: true, wifiAdapter: "system" as const };
