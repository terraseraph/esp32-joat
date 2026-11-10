import type { Job, SetupAdapterStatus, SetupApList, SetupRecoveryMarker, SetupRecoveryState, SetupRestoreResult, SetupStartBody, SetupWifiBody } from "@shared/api";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "./client";
import { createStore, useStore } from "./store";

/**
 * SoftAP setup and recovery (batch 3, track 1). Typed calls for `/api/setup/*`; the job itself is a generic `Job`
 * (kind "setup") that the web app follows with `useJob`. Contract: `API.md` "SoftAP setup".
 */

export type { SetupAdapterStatus, SetupAp, SetupApList, SetupChooseResult, SetupJobResult, SetupRecoveryMarker, SetupRecoveryState, SetupRestoreResult, SetupStartBody, SetupWifiBody } from "@shared/api";

export const getSetupAdapter = () => apiFetch<SetupAdapterStatus>("/api/setup/adapter");
export const getSetupAps = (refresh = false) => apiFetch<SetupApList>(refresh ? "/api/setup/aps?refresh=true" : "/api/setup/aps");
export const startSetupJob = (body: SetupStartBody) => apiFetch<Job>("/api/setup/jobs", { method: "POST", body });
export const sendSetupWifi = (jobId: string, body: SetupWifiBody) =>
  apiFetch<Job>(`/api/setup/jobs/${encodeURIComponent(jobId)}/wifi`, { method: "POST", body });
export const getSetupRecovery = () => apiFetch<SetupRecoveryState>("/api/setup/recovery");
export const restoreSetupNetwork = () => apiFetch<SetupRestoreResult>("/api/setup/recovery/restore", { method: "POST" });
export const dismissSetupRecovery = () => apiFetch<void>("/api/setup/recovery/dismiss", { method: "POST" });

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError(0, "unknown", e instanceof Error ? e.message : String(e)));

/* ---------------------------------------------------------------- adapter */

export interface UseSetupAdapter {
  /** null until answered (or when the server does not know the route). */
  adapter: SetupAdapterStatus | null;
  loading: boolean;
}

/** Whether this PC can join a device's Setup AP. */
export function useSetupAdapter(): UseSetupAdapter {
  const [state, setState] = useState<{ adapter: SetupAdapterStatus | null; done: boolean }>({ adapter: null, done: false });
  useEffect(() => {
    let live = true;
    getSetupAdapter()
      .then((adapter) => live && setState({ adapter, done: true }))
      .catch(() => live && setState({ adapter: null, done: true }));
    return () => {
      live = false;
    };
  }, []);
  return { adapter: state.adapter, loading: !state.done };
}

/* ------------------------------------------------------------- nearby APs */

export interface UseSetupAps {
  data: SetupApList | null;
  loading: boolean;
  /** A rescan is running (the list stays visible). */
  refreshing: boolean;
  error: ApiError | null;
  refresh(): Promise<void>;
}

/** Setup APs (`esp32-xxxxxx`) this PC can see. The first load uses the server's cached scan; `refresh()` asks for a new one. */
export function useSetupAps(): UseSetupAps {
  const [data, setData] = useState<SetupApList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let live = true;
    getSetupAps()
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(asApiError(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await getSetupAps(true));
      setError(null);
    } catch (e) {
      setError(asApiError(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { data, loading, refreshing, error, refresh };
}

/* --------------------------------------------------------- crash recovery */

interface RecoveryState {
  state: SetupRecoveryState | null;
  error: ApiError | null;
}
export const recoveryStore = createStore<RecoveryState>({ state: null, error: null });

/** Ask the server whether a previous setup run left this PC on the device's Wi-Fi. */
export async function loadSetupRecovery(): Promise<void> {
  try {
    recoveryStore.set({ state: await getSetupRecovery(), error: null });
  } catch (e) {
    recoveryStore.set({ state: null, error: asApiError(e) });
  }
}

/** Tests only. */
export function resetSetupRecovery(): void {
  recoveryStore.set({ state: null, error: null });
}

export interface UseSetupRecovery {
  /** True when a marker from an interrupted run exists. */
  pending: boolean;
  marker: SetupRecoveryMarker | null;
  busy: "restore" | "dismiss" | null;
  /** Plain-words result of the last restore (success or not) or the request error. */
  message: { tone: "ok" | "bad"; text: string } | null;
  restore(): Promise<void>;
  dismiss(): Promise<void>;
  reload(): Promise<void>;
}

/** Shared by the Discover banner and the setup flow, so both react to one restore. */
export function useSetupRecovery(): UseSetupRecovery {
  useEffect(() => {
    void loadSetupRecovery();
  }, []);
  const state = useStore(recoveryStore, (s) => s.state);
  const [busy, setBusy] = useState<"restore" | "dismiss" | null>(null);
  const [message, setMessage] = useState<UseSetupRecovery["message"]>(null);

  const restore = useCallback(async () => {
    setBusy("restore");
    setMessage(null);
    try {
      const res = await restoreSetupNetwork();
      setMessage({ tone: res.restored ? "ok" : "bad", text: res.message });
      await loadSetupRecovery();
    } catch (e) {
      setMessage({ tone: "bad", text: asApiError(e).message });
    } finally {
      setBusy(null);
    }
  }, []);

  const dismiss = useCallback(async () => {
    setBusy("dismiss");
    setMessage(null);
    try {
      await dismissSetupRecovery();
      await loadSetupRecovery();
    } catch (e) {
      setMessage({ tone: "bad", text: asApiError(e).message });
    } finally {
      setBusy(null);
    }
  }, []);

  return { pending: state?.pending ?? false, marker: state?.marker ?? null, busy, message, restore, dismiss, reload: loadSetupRecovery };
}
