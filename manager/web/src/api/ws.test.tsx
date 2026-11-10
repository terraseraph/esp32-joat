import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test/fakes";
import { createBrowserWsClient } from "./ws";

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => vi.useRealTimers());

function make() {
  return createBrowserWsClient({ url: "ws://test/api/ws", WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
}

describe("browser ws client", () => {
  it("tracks state and dispatches messages by type", () => {
    const c = make();
    const hello = vi.fn();
    const all = vi.fn();
    c.subscribe("hello", hello);
    c.subscribe("*", all);
    expect(c.store.get().state).toBe("closed");
    c.connect();
    expect(c.store.get().state).toBe("connecting");
    FakeWebSocket.last().open();
    expect(c.store.get()).toEqual({ state: "open", everOpened: true });
    FakeWebSocket.last().emit({ t: "hello", server: { version: "1", lan: false } });
    FakeWebSocket.last().emit({ t: "other" });
    expect(hello).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(2);
  });

  it("sends only while open", () => {
    const c = make();
    c.connect();
    expect(c.send({ t: "watch", ids: [] })).toBe(false);
    FakeWebSocket.last().open();
    expect(c.send({ t: "watch", ids: ["a"] })).toBe(true);
    expect(FakeWebSocket.last().sent).toEqual(['{"t":"watch","ids":["a"]}']);
  });

  it("reconnects with backoff 1 s, 2 s, 4 s ... capped at 15 s, and resets after an open", () => {
    const c = make();
    c.connect();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.last().serverClose();
      let t = 0;
      while (FakeWebSocket.instances.length === before && t < 20000) {
        vi.advanceTimersByTime(500);
        t += 500;
      }
      waits.push(t);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);

    FakeWebSocket.last().open();
    FakeWebSocket.last().serverClose();
    vi.advanceTimersByTime(999);
    const n = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(n + 1);
  });

  it("close() stops reconnecting", () => {
    const c = make();
    c.connect();
    FakeWebSocket.last().open();
    c.close();
    vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(c.store.get().state).toBe("closed");
  });
});
