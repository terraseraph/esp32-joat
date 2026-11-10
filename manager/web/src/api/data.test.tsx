import type { DeviceSummary } from "@shared/api";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, mockFetch } from "../test/fakes";
import { CommandError, isExpectedRestart, sendCommand, useCommand } from "./commands";
import { devicesStore, forgetDevice, patchDevice, useDevice, useDevices } from "./devices";
import { liveStore, seedLiveIo, useDeviceEvent, useDeviceLive } from "./live";
import { resetApiForTests } from "./testing";
import { watchDevice } from "./watch";
import { getBrowserWs } from "./ws";

export function summary(id: string, over: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id, name: `Dev ${id}`, label: "", notes: "", hostname: `esp-${id}`, host: "10.0.0.1", addedAt: "2026-01-01T00:00:00Z",
    addedVia: "manual", health: "online", attention: [], lastSeen: null, fw: null, app_version: null, compile_date: null,
    fwMatchesTarget: null, uptime_s: null, boot_state: null, safe_mode: null, safe_reason: null, rssi: null, net_state: null,
    mqtt: { configured: null, connected: null }, memory: { pressure: null, free: null, total: null },
    ota: { running_partition: null, image_state: null, rollback_possible: null, busy: null },
    io_count: null, module_count: null, link: "closed", queue: 0, ...over,
  };
}

const tick = () => act(async () => { await Promise.resolve(); });

function connectWs(): FakeWebSocket {
  getBrowserWs().connect();
  const ws = FakeWebSocket.last();
  act(() => ws.open());
  return ws;
}
const emit = (ws: FakeWebSocket, msg: unknown) => act(() => ws.emit(msg));

beforeEach(() => {
  resetApiForTests();
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  resetApiForTests();
  vi.unstubAllGlobals();
});

describe("devices store", () => {
  it("fetches the list first, WS replaces/upserts/removes, and keeps the list sorted", async () => {
    mockFetch({ "/api/devices": { body: [summary("b", { name: "bravo" }), summary("a", { name: "Alpha" })] } });
    const { result } = renderHook(() => useDevices());
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.list.map((d) => d.id)).toEqual(["a", "b"]);

    const ws = connectWs();
    emit(ws, { t: "devices", list: [summary("c", { label: "Charlie" }), summary("b", { name: "bravo" })] });
    expect(result.current.list.map((d) => d.id)).toEqual(["b", "c"]);
    emit(ws, { t: "device", id: "a", summary: summary("a", { name: "aardvark" }) });
    expect(result.current.list.map((d) => d.id)).toEqual(["a", "b", "c"]);
    const before = result.current.list;
    emit(ws, { t: "device", id: "a", summary: summary("a", { name: "aardvark" }) });
    expect(result.current.list).toBe(before);
    emit(ws, { t: "deviceRemoved", id: "b" });
    expect(result.current.list.map((d) => d.id)).toEqual(["a", "c"]);
  });

  it("ignores a late REST list once the WS delivered one, and reports errors", async () => {
    let release: (v: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => (release = r))));
    const { result } = renderHook(() => useDevices());
    const ws = connectWs();
    emit(ws, { t: "devices", list: [summary("x")] });
    await act(async () => release(new Response(JSON.stringify([summary("y")]), { status: 200 })));
    expect(result.current.list.map((d) => d.id)).toEqual(["x"]);

    resetApiForTests();
    mockFetch({});
    const failed = renderHook(() => useDevices());
    await waitFor(() => expect(failed.result.current.error?.status).toBe(404));
    expect(failed.result.current.loaded).toBe(false);
  });

  it("useDevice: summary, notFound, stable reference", async () => {
    mockFetch({ "/api/devices": { body: [summary("a")] } });
    const found = renderHook(() => useDevice("a"));
    const missing = renderHook(() => useDevice("zz"));
    expect(found.result.current.notFound).toBe(false);
    await waitFor(() => expect(found.result.current.summary?.id).toBe("a"));
    expect(missing.result.current).toMatchObject({ summary: null, loaded: true, notFound: true });
    const ref = found.result.current.summary;
    found.rerender();
    expect(found.result.current.summary).toBe(ref);
  });

  it("REST helpers update the store from the response", async () => {
    const fn = mockFetch({
      "/api/devices/a": { body: summary("a", { label: "Door" }) },
    });
    devicesStore.set((p) => ({ ...p, byId: { a: summary("a") }, list: [summary("a")], loaded: true }));
    const s = await patchDevice("a", { label: "Door" });
    expect(s.label).toBe("Door");
    expect(devicesStore.get().byId.a?.label).toBe("Door");
    expect((fn.mock.calls[0] as unknown[])[1]).toMatchObject({ method: "PATCH" });

    mockFetch({ "/api/devices/a": { status: 204 } });
    await forgetDevice("a");
    expect(devicesStore.get().list).toEqual([]);
  });
});

describe("watch", () => {
  const watchMsgs = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s) as { t: string; ids: string[] });

  it("ref counts, sends the sorted union once per tick and resends after a reconnect", async () => {
    const ws = connectWs();
    const r1 = watchDevice("b");
    const r2 = watchDevice("a");
    const r3 = watchDevice("a");
    await tick();
    expect(watchMsgs(ws)).toEqual([{ t: "watch", ids: ["a", "b"] }]);

    r2();
    r2(); // idempotent
    await tick();
    expect(watchMsgs(ws)).toHaveLength(1); // "a" still held by r3
    r3();
    await tick();
    expect(watchMsgs(ws).at(-1)).toEqual({ t: "watch", ids: ["b"] });

    act(() => ws.serverClose());
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    const ws2 = FakeWebSocket.last();
    expect(ws2).not.toBe(ws);
    act(() => ws2.open());
    await tick();
    expect(watchMsgs(ws2)).toEqual([{ t: "watch", ids: ["b"] }]);

    r1();
    await tick();
    expect(watchMsgs(ws2).at(-1)).toEqual({ t: "watch", ids: [] });
  });

  it("sends nothing while the socket is closed, then everything on open", async () => {
    getBrowserWs().connect();
    const ws = FakeWebSocket.last();
    watchDevice("a");
    await tick();
    expect(ws.sent).toEqual([]);
    act(() => ws.open());
    await tick();
    expect(watchMsgs(ws)).toEqual([{ t: "watch", ids: ["a"] }]);
  });
});

describe("live store", () => {
  it("applies link/live/io/event, tracks changedAt and hydrated, and handles WS close", async () => {
    const ws = connectWs();
    const { result } = renderHook(() => useDeviceLive("a"));
    await tick();
    expect(result.current).toMatchObject({ link: "closed", io: {}, hydrated: false, telemetry: null });
    expect(watchMsgs(ws)).toEqual([{ t: "watch", ids: ["a"] }]);

    emit(ws, { t: "link", id: "a", ws: "open" });
    expect(result.current.link).toBe("open");
    emit(ws, { t: "live", id: "a", io: { gpio_4: { id: "gpio_4", value: 0 } }, telemetry: null });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.io).toEqual({ gpio_4: { id: "gpio_4", value: 0 } });

    emit(ws, { t: "io", id: "a", topic: "io/gpio", data: { id: "gpio_5", value: 1 } });
    expect(Object.keys(result.current.io)).toEqual(["gpio_4", "gpio_5"]);
    expect(result.current.changedAt.gpio_5).toBeTypeOf("number");
    expect(result.current.changedAt.gpio_4).toBeUndefined();

    const tel = { id: "a", uptime_s: 5 };
    emit(ws, { t: "event", id: "a", topic: "telemetry", data: tel });
    expect(result.current.telemetry).toEqual(tel);
    expect(result.current.lastEventAt).toBeTypeOf("number");

    emit(ws, { t: "live", id: "a", io: { gpio_9: { id: "gpio_9", value: 1 } }, telemetry: null });
    expect(Object.keys(result.current.io)).toEqual(["gpio_9"]); // replace
    expect(result.current.telemetry).toEqual(tel); // null telemetry keeps the last one

    act(() => ws.serverClose());
    expect(result.current.link).toBe("connecting");
    // unrelated ids are untouched
    expect(liveStore.get().zz).toBeUndefined();
  });

  const watchMsgs = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s) as { t: string; ids: string[] });

  it("seedLiveIo only applies before hydration; returns stable references", async () => {
    const ws = connectWs();
    const { result, rerender } = renderHook(() => useDeviceLive("a"));
    act(() => seedLiveIo("a", { gpio_1: { id: "gpio_1" } as never }));
    expect(result.current.hydrated).toBe(true);
    expect(Object.keys(result.current.io)).toEqual(["gpio_1"]);
    act(() => seedLiveIo("a", { gpio_2: { id: "gpio_2" } as never }));
    expect(Object.keys(result.current.io)).toEqual(["gpio_1"]);
    const ref = result.current;
    rerender();
    expect(result.current).toBe(ref);
    emit(ws, { t: "live", id: "a", io: {}, telemetry: null });
    expect(result.current.io).toEqual({});
  });

  it("useDeviceEvent delivers matching topics only and releases the watch", async () => {
    const ws = connectWs();
    const got: unknown[] = [];
    const { unmount } = renderHook(() => useDeviceEvent("a", "ota/progress", (d) => got.push(d)));
    await tick();
    emit(ws, { t: "event", id: "a", topic: "net", data: { state: "x" } });
    emit(ws, { t: "event", id: "a", topic: "ota/progress", data: { pct: 5 } });
    emit(ws, { t: "event", id: "b", topic: "ota/progress", data: { pct: 9 } });
    expect(got).toEqual([{ pct: 5 }]);
    unmount();
    await tick();
    expect(watchMsgs(ws).at(-1)).toEqual({ t: "watch", ids: [] });
  });
});

describe("commands", () => {
  it("resolves the result and detects expected restarts", async () => {
    const fn = mockFetch({ "/api/devices/a/command": { body: { v: 1, ok: true, result: { gpio: 4, value: 1 } } } });
    await expect(sendCommand("a", { cmd: "pin.set", gpio: 4, value: 1 })).resolves.toEqual({ gpio: 4, value: 1 });
    expect(JSON.parse(String(((fn.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ cmd: "pin.set", gpio: 4, value: 1 });
    expect(isExpectedRestart({ expectedRestart: true })).toBe(true);
    expect(isExpectedRestart({})).toBe(false);
    expect(isExpectedRestart(null)).toBe(false);
  });

  it("device error keeps the device's message verbatim", async () => {
    mockFetch({ "/api/devices/a/command": { body: { v: 1, ok: false, error: "gpio 6 is reserved" } } });
    const err = await sendCommand("a", { cmd: "pin.set" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ kind: "device", message: "gpio 6 is reserved" });
  });

  it("transport and api errors", async () => {
    mockFetch({ "/api/devices/a/command": { status: 502, body: { ok: false, error: "No answer from the device", code: "device_timeout", transport: true } } });
    await expect(sendCommand("a", { cmd: "x" })).rejects.toMatchObject({ kind: "transport", message: "No answer from the device", code: "device_timeout" });
    mockFetch({ "/api/devices/a/command": { status: 404, body: { error: "Unknown device", code: "unknown_device" } } });
    await expect(sendCommand("a", { cmd: "x" })).rejects.toMatchObject({ kind: "api", code: "unknown_device" });
  });

  it("useCommand tracks pending and the latest error", async () => {
    let n = 0;
    mockFetch({
      "/api/devices/a/command": () => (++n === 1 ? { body: { v: 1, ok: false, error: "nope" } } : { body: { v: 1, ok: true, result: 7 } }),
    });
    const { result } = renderHook(() => useCommand("a"));
    await act(async () => { await result.current.run({ cmd: "x" }).catch(() => undefined); });
    expect(result.current.error?.message).toBe("nope");
    expect(result.current.pending).toBe(false);
    let value: unknown;
    await act(async () => { value = await result.current.run({ cmd: "x" }); });
    expect(value).toBe(7);
    expect(result.current.error).toBeNull();
  });
});

describe("ioKey", () => {
  it("prefixes add-on instance ids with mod_ and keeps pin keys", async () => {
    const { ioKey } = await import("./live");
    expect(ioKey({ id: "gpio_4", mode: "out" })).toBe("gpio_4");
    expect(ioKey({ id: "env0", type: "bme280" })).toBe("mod_env0");
    expect(ioKey({ id: "mod_env0", type: "bme280" })).toBe("mod_env0");
    expect(ioKey({})).toBeNull();
  });
});

describe("config version", () => {
  it("bumps after a successful config-changing command only", async () => {
    const { sendCommand, configVersionStore } = await import("./commands");
    const { mockFetch } = await import("../test/fakes");
    mockFetch({ "/api/devices/aa/command": { body: { v: 1, ok: true, result: {} } } });
    await sendCommand("aa", { cmd: "rule.list" });
    expect(configVersionStore.get()["aa"] ?? 0).toBe(0);
    await sendCommand("aa", { cmd: "pin.configure", pin: { gpio: 4, mode: "out" } });
    expect(configVersionStore.get()["aa"]).toBe(1);
  });
});
