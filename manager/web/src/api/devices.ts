import type { DeviceSummary } from "@shared/api";
import { useEffect } from "react";
import { ApiError, apiFetch } from "./client";
import { createStore, useStore } from "./store";
import { getBrowserWs } from "./ws";

interface DevicesState {
  byId: Readonly<Record<string, DeviceSummary>>;
  /** Sorted like the server: label || name || hostname, case-insensitive. */
  list: readonly DeviceSummary[];
  /** True once the list is known (REST or WS). */
  loaded: boolean;
  /** True once the WS `devices` message arrived; a late REST list is then ignored. */
  fromWs: boolean;
  error: ApiError | null;
}

const EMPTY: DevicesState = { byId: {}, list: [], loaded: false, fromWs: false, error: null };
export const devicesStore = createStore<DevicesState>(EMPTY);

const sortKey = (d: DeviceSummary) => (d.label || d.name || d.hostname || d.id).toLowerCase();
function sortList(items: Iterable<DeviceSummary>): DeviceSummary[] {
  return [...items].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function build(items: DeviceSummary[], prev: DevicesState): DevicesState {
  const byId: Record<string, DeviceSummary> = {};
  for (const d of items) byId[d.id] = d;
  return { ...prev, byId, list: sortList(items), loaded: true, error: null };
}

/** Replace the whole list (what the WS `devices` message does). */
export function setDevices(list: DeviceSummary[]): void {
  devicesStore.set((p) => ({ ...build(list, p), fromWs: true }));
}

/** Insert or replace one summary (an identical summary changes nothing). */
export function upsertDevice(summary: DeviceSummary): void {
  devicesStore.set((p) => {
    if (JSON.stringify(p.byId[summary.id]) === JSON.stringify(summary)) return p;
    return build([...Object.values(p.byId).filter((d) => d.id !== summary.id), summary], p);
  });
}

export function removeDevice(id: string): void {
  devicesStore.set((p) => {
    if (!p.byId[id]) return p;
    return build(Object.values(p.byId).filter((d) => d.id !== id), p);
  });
}

let started = false;
let unsubs: Array<() => void> = [];
let fetchSeq = 0;

async function initialFetch(): Promise<void> {
  const mine = ++fetchSeq;
  try {
    const list = await apiFetch<DeviceSummary[]>("/api/devices");
    if (mine !== fetchSeq) return;
    devicesStore.set((p) => (p.fromWs ? p : build(list, p)));
  } catch (err) {
    if (mine !== fetchSeq) return;
    const error = err instanceof ApiError ? err : new ApiError(0, "unknown", String(err));
    devicesStore.set((p) => (p.fromWs ? p : { ...p, error }));
  }
}

/** Subscribe to the WS and fetch the list once. Idempotent; the hooks call it. */
export function startDevices(): void {
  if (started) return;
  started = true;
  const ws = getBrowserWs();
  unsubs = [
    ws.subscribe("devices", (m) => setDevices(m.list)),
    ws.subscribe("device", (m) => upsertDevice(m.summary)),
    ws.subscribe("deviceRemoved", (m) => removeDevice(m.id)),
  ];
  void initialFetch();
}

/** Tests only. */
export function resetDevices(): void {
  for (const u of unsubs) u();
  unsubs = [];
  started = false;
  fetchSeq++;
  devicesStore.set(EMPTY);
}

const dev = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

export function useDevices(): { list: DeviceSummary[]; loaded: boolean; error: ApiError | null } {
  useEffect(() => startDevices(), []);
  const list = useStore(devicesStore, (s) => s.list) as DeviceSummary[];
  const loaded = useStore(devicesStore, (s) => s.loaded);
  const error = useStore(devicesStore, (s) => s.error);
  return { list, loaded, error };
}

export function useDevice(id: string | undefined): { summary: DeviceSummary | null; loaded: boolean; notFound: boolean } {
  useEffect(() => startDevices(), []);
  const summary = useStore(devicesStore, (s) => (id ? (s.byId[id] ?? null) : null));
  const loaded = useStore(devicesStore, (s) => s.loaded);
  return { summary, loaded, notFound: loaded && summary === null };
}

/** DELETE /api/devices/:id; removes it from the store. Never touches the device. */
export async function forgetDevice(id: string): Promise<void> {
  await apiFetch<void>(dev(id), { method: "DELETE" });
  removeDevice(id);
}

/** POST /api/devices/:id/refresh: poll now, returns the fresh summary. */
export async function refreshDevice(id: string): Promise<DeviceSummary> {
  const s = await apiFetch<DeviceSummary>(`${dev(id)}/refresh`, { method: "POST" });
  upsertDevice(s);
  return s;
}

/** PATCH /api/devices/:id (Manager-only label/notes, stored host). */
export async function patchDevice(id: string, body: { label?: string; notes?: string; host?: string }): Promise<DeviceSummary> {
  const s = await apiFetch<DeviceSummary>(dev(id), { method: "PATCH", body });
  upsertDevice(s);
  return s;
}

/** POST /api/devices {host}: probe and register (201 new, 200 already known). */
export async function addDevice(host: string): Promise<DeviceSummary> {
  const s = await apiFetch<DeviceSummary>("/api/devices", { method: "POST", body: { host } });
  upsertDevice(s);
  return s;
}
