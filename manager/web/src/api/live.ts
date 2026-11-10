import type { LinkState, LiveIoMap } from "@shared/api";
import type { TelemetrySnapshot } from "@shared/device-api";
import { useEffect, useRef } from "react";
import { createStore, useStore } from "./store";
import { watchDevice, watchedIds } from "./watch";
import { getBrowserWs } from "./ws";

export interface DeviceLive {
  link: LinkState;
  /** Live I/O keyed by state key (`gpio_4`, `adc_34`, ...). `{}` until `hydrated`. */
  io: LiveIoMap;
  /** True once a `live` snapshot (or `seedLiveIo`) provided `io`. */
  hydrated: boolean;
  telemetry: TelemetrySnapshot | null;
  /** Date.now() of the last `event`/`io`/`live` message. */
  lastEventAt: number | null;
  /** Date.now() of the last change of each io key (for flash animations). */
  changedAt: Readonly<Record<string, number>>;
}

export const EMPTY_LIVE: DeviceLive = Object.freeze({
  link: "closed",
  io: Object.freeze({}) as LiveIoMap,
  hydrated: false,
  telemetry: null,
  lastEventAt: null,
  changedAt: Object.freeze({}),
});

export const liveStore = createStore<Readonly<Record<string, DeviceLive>>>({});

function patch(id: string, fn: (cur: DeviceLive) => DeviceLive): void {
  liveStore.set((all) => {
    const cur = all[id] ?? EMPTY_LIVE;
    const next = fn(cur);
    return next === cur && id in all ? all : { ...all, [id]: next };
  });
}

type EventHandler = (topic: string, data: unknown) => void;
const emitters = new Map<string, Set<EventHandler>>();

function emit(id: string, topic: string, data: unknown): void {
  for (const h of [...(emitters.get(id) ?? [])]) {
    try {
      h(topic, data);
    } catch (err) {
      console.error("device event handler failed", err);
    }
  }
}

let started = false;
let unsubs: Array<() => void> = [];

/** Subscribe to the live WS messages. Idempotent; the hooks call it. */
export function startLive(): void {
  if (started) return;
  started = true;
  const ws = getBrowserWs();
  let lastState = ws.store.get().state;
  unsubs = [
    ws.subscribe("link", (m) => patch(m.id, (c) => (c.link === m.ws ? c : { ...c, link: m.ws }))),
    ws.subscribe("live", (m) =>
      patch(m.id, (c) => ({ ...c, io: m.io, hydrated: true, telemetry: m.telemetry ?? c.telemetry, lastEventAt: Date.now() })),
    ),
    ws.subscribe("io", (m) => {
      const key = ioKey(m.data);
      if (!key) return;
      const now = Date.now();
      patch(m.id, (c) => ({ ...c, io: { ...c.io, [key]: m.data }, changedAt: { ...c.changedAt, [key]: now }, lastEventAt: now }));
      emit(m.id, m.topic, m.data);
    }),
    ws.subscribe("event", (m) => {
      patch(m.id, (c) =>
        m.topic === "telemetry"
          ? { ...c, telemetry: m.data as TelemetrySnapshot, lastEventAt: Date.now() }
          : { ...c, lastEventAt: Date.now() },
      );
      emit(m.id, m.topic, m.data);
    }),
    ws.store.subscribe(() => {
      const next = ws.store.get().state;
      if (next === lastState) return;
      lastState = next;
      if (next === "open") return; // the server resends link/live for watched devices
      for (const id of watchedIds()) patch(id, (c) => (c.link === "connecting" ? c : { ...c, link: "connecting" }));
    }),
  ];
}

/** Set `io` from REST, only when no `live` snapshot arrived yet. */
export function seedLiveIo(id: string, io: LiveIoMap): void {
  patch(id, (c) => (c.hydrated ? c : { ...c, io, hydrated: true }));
}

/** Subscribe to device events outside React; returns the unsubscribe function. Does not watch. */
export function onDeviceEvent(id: string, handler: EventHandler): () => void {
  startLive();
  let set = emitters.get(id);
  if (!set) emitters.set(id, (set = new Set()));
  const bucket = set;
  bucket.add(handler);
  return () => {
    bucket.delete(handler);
  };
}

/** Live state of one device (link, io, telemetry). Watches the device while mounted. */
export function useDeviceLive(id: string | undefined): DeviceLive {
  useEffect(() => {
    if (!id) return;
    startLive();
    return watchDevice(id);
  }, [id]);
  return useStore(liveStore, (all) => (id ? (all[id] ?? EMPTY_LIVE) : EMPTY_LIVE));
}

/** Call `handler(data, topic)` for device events on `topic` (`ota/progress`, `net`, `identity/rename`, `io/gpio`, ...). Watches while mounted. */
export function useDeviceEvent(id: string | undefined, topic: string, handler: (data: unknown, topic: string) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!id) return;
    const release = watchDevice(id);
    const off = onDeviceEvent(id, (t, data) => {
      if (t === topic) ref.current(data, t);
    });
    return () => {
      off();
      release();
    };
  }, [id, topic]);
}

/** Tests only. */
export function resetLive(): void {
  for (const u of unsubs) u();
  unsubs = [];
  started = false;
  emitters.clear();
  liveStore.set({});
}

/**
 * State key of an `io` frame: `data.id` for pins (`gpio_4`), but add-on frames carry the bare instance id
 * (`env0`) while `live.io` / `GET /pins` key them as `mod_env0`; add-on states are the ones with a `type`.
 */
export function ioKey(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as { id?: unknown; type?: unknown };
  if (typeof d.id !== "string" || d.id === "") return null;
  if (typeof d.type === "string" && !d.id.startsWith("mod_")) return `mod_${d.id}`;
  return d.id;
}
