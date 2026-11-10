import type { HealthResponse } from "@shared/api";
import { useEffect } from "react";
import { apiFetch } from "./client";
import { createStore, useStore } from "./store";
import { getBrowserWs, type WsState } from "./ws";

export type ServerConnection = "connected" | "connecting" | "disconnected";

interface HealthSnapshot {
  health: HealthResponse | null;
  /** null = not answered yet. */
  ok: boolean | null;
}

export const healthStore = createStore<HealthSnapshot>({ health: null, ok: null });

const POLL_MS = 15_000;
let seq = 0;

/** Fetch `/api/health` now (the newest answer wins when calls overlap). */
export async function refreshHealth(): Promise<void> {
  const mine = ++seq;
  try {
    const health = await apiFetch<HealthResponse>("/api/health");
    if (mine === seq) healthStore.set({ health, ok: true });
  } catch {
    if (mine === seq) healthStore.set((p) => ({ ...p, ok: false }));
  }
}

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeWs: (() => void) | null = null;

/** Reference-counted: connects the WS, polls health every 15 s and refreshes it whenever the WS opens or closes. */
export function startServerStatus(): () => void {
  if (users++ === 0) {
    const ws = getBrowserWs();
    let last: WsState = ws.store.get().state;
    unsubscribeWs = ws.store.subscribe(() => {
      const next = ws.store.get().state;
      if (next !== last && (next === "open" || next === "closed")) void refreshHealth();
      last = next;
    });
    ws.connect();
    void refreshHealth();
    timer = setInterval(() => void refreshHealth(), POLL_MS);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--users === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribeWs?.();
      unsubscribeWs = null;
    }
  };
}

/** Tests only. */
export function resetServerStatus(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribeWs?.();
  unsubscribeWs = null;
  users = 0;
  seq++;
  healthStore.set({ health: null, ok: null });
}

export function deriveConnection(ok: boolean | null, ws: WsState): ServerConnection {
  if (ok === false) return "disconnected";
  if (ok === true && ws === "open") return "connected";
  if (ws === "closed") return "disconnected";
  return "connecting";
}

export interface ServerStatus {
  connection: ServerConnection;
  ws: WsState;
  /** True when the WS was open before and we are trying again. */
  reconnecting: boolean;
  version: string | null;
  lan: boolean;
  dataDir: string | null;
  /** Server uptime in seconds at the last successful health check. */
  uptime: number | null;
}

/** Server connection state (health polling + browser WS). Mount it once, near the root of the shell. */
export function useServerStatus(): ServerStatus {
  useEffect(() => startServerStatus(), []);
  const { health, ok } = useStore(healthStore);
  const { state, everOpened } = useStore(getBrowserWs().store);
  const connection = deriveConnection(ok, state);
  return {
    connection,
    ws: state,
    reconnecting: connection === "connecting" && everOpened,
    version: health?.version ?? null,
    lan: health?.lan ?? false,
    dataDir: health?.dataDir ?? null,
    uptime: health?.uptime ?? null,
  };
}
