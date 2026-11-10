import type { AccessResponse, SettingsResponse, SettingsUpdate } from "@shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "./client";
import { refreshHealth } from "./serverStatus";

export type { AccessResponse, SettingsResponse, SettingsUpdate };

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", err instanceof Error ? err.message : String(err)));

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload(): void;
}

function useLoaded<T>(path: string): Loaded<T> & { set(next: T): void } {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch<T>(path);
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (err) {
      if (alive.current) setState((s) => ({ data: s.data, error: asApiError(err), loading: false }));
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  const set = useCallback((data: T) => setState({ data, error: null, loading: false }), []);
  const reload = useCallback(() => void load(), [load]);
  return { ...state, reload, set };
}

export interface SettingsApi extends Loaded<SettingsResponse> {
  /** `PUT /api/settings`: rejects with the server's `ApiError` (message and `details` shown verbatim by the caller). */
  save(patch: SettingsUpdate): Promise<SettingsResponse>;
}

/** App settings (`GET/PUT /api/settings`). */
export function useSettings(): SettingsApi {
  const { set, ...loaded } = useLoaded<SettingsResponse>("/api/settings");
  const save = useCallback(
    async (patch: SettingsUpdate) => {
      const next = await apiFetch<SettingsResponse>("/api/settings", { method: "PUT", body: patch });
      set(next);
      return next;
    },
    [set],
  );
  return { ...loaded, save };
}

export interface AccessApi extends Loaded<AccessResponse> {
  /** `PUT /api/access`. Rejects with `ApiError` (`lan_unavailable`, `rebind_failed`). Refreshes the nav's LAN badge. */
  setLan(enabled: boolean): Promise<AccessResponse>;
  /** `POST /api/access/token`. */
  regenerateToken(): Promise<AccessResponse>;
}

/** LAN access (`GET/PUT /api/access`, `POST /api/access/token`). */
export function useAccess(): AccessApi {
  const { set, ...loaded } = useLoaded<AccessResponse>("/api/access");
  const setLan = useCallback(
    async (enabled: boolean) => {
      const next = await apiFetch<AccessResponse>("/api/access", { method: "PUT", body: { enabled } });
      set(next);
      void refreshHealth(); // the nav badge follows the live state
      return next;
    },
    [set],
  );
  const regenerateToken = useCallback(async () => {
    const next = await apiFetch<AccessResponse>("/api/access/token", { method: "POST" });
    set(next);
    return next;
  }, [set]);
  return { ...loaded, setLan, regenerateToken };
}

/** The server's per-entry validation messages (`details: [{ path, message }]`), keyed by JSON pointer. */
export function fieldErrors(err: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (err instanceof ApiError && Array.isArray(err.details)) {
    for (const d of err.details as unknown[]) {
      if (typeof d === "object" && d !== null && typeof (d as { path?: unknown }).path === "string" && typeof (d as { message?: unknown }).message === "string") {
        const { path, message } = d as { path: string; message: string };
        if (!(path in out)) out[path] = message;
      }
    }
  }
  return out;
}

export const DEFAULT_FIRMWARE_URL = "https://terraseraph.github.io/esp32-joat/";
export const INSTALLER_URL = "https://terraseraph.github.io/esp32-joat/";
