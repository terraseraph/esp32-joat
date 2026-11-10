import type { PinConfigResponse } from "@shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "./client";
import { createStore, useStore } from "./store";
import { useApi, type ApiResource } from "./useApi";

export type CommandBody = { cmd: string; [key: string]: unknown };

export type CommandErrorKind = "device" | "transport" | "api";

/**
 * `device`: the device answered `ok:false` (message = its error string, verbatim).
 * `transport`: the Manager could not reach the device (HTTP 502). `api`: any other Manager error.
 */
export class CommandError extends Error {
  readonly kind: CommandErrorKind;
  readonly code: string | null;
  constructor(kind: CommandErrorKind, message: string, code: string | null = null) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
    this.code = code;
  }
}

interface Envelope {
  v: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const dev = (id: string) => `/api/devices/${encodeURIComponent(id)}`;

/** Commands that change pins, add-ons or rules: every screen showing those must re-read after one succeeds. */
const CONFIG_CMDS = new Set(["pin.configure", "module.add", "module.configure", "module.remove", "rule.set", "rule.remove"]);

/** Per-device counter bumped after every successful config-changing command (from any screen). */
export const configVersionStore = createStore<Record<string, number>>({});

export function bumpConfigVersion(id: string): void {
  configVersionStore.set((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));
}

/** Config version of one device (0 until something changed). */
export function useConfigVersion(id: string): number {
  return useStore(configVersionStore, (s) => s[id] ?? 0);
}

/** Calls `reload` whenever the device configuration changed (not on mount). */
function useReloadOnConfigChange(id: string, enabled: boolean, reload: () => void): void {
  const version = useConfigVersion(id);
  const seen = useRef(version);
  useEffect(() => {
    if (!enabled || seen.current === version) return;
    seen.current = version;
    reload();
  }, [enabled, version, reload]);
}

/** Passthrough paths and read commands whose answer depends on the pin / add-on / rule configuration. */
const CONFIG_PATHS = new Set(["hardware", "pins", "status"]);
const CONFIG_READS = new Set(["module.list", "rule.list"]);

/** POST /api/devices/:id/command. Resolves the device's `result`; rejects with `CommandError`. */
export async function sendCommand<T = unknown>(id: string, body: CommandBody): Promise<T> {
  let env: Envelope;
  try {
    env = await apiFetch<Envelope>(`${dev(id)}/command`, { method: "POST", body });
  } catch (err) {
    if (err instanceof ApiError) throw new CommandError(err.status === 502 ? "transport" : "api", err.message, err.code);
    throw err;
  }
  if (!env.ok) throw new CommandError("device", env.error ?? "The device rejected the command.");
  if (CONFIG_CMDS.has(body.cmd)) bumpConfigVersion(id);
  return env.result as T;
}

/** True for the `{expectedRestart:true}` result of reboot / factory reset / rollback. */
export function isExpectedRestart(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { expectedRestart?: unknown }).expectedRestart === true;
}

export function asCommandError(err: unknown): CommandError {
  return err instanceof CommandError ? err : new CommandError("api", err instanceof Error ? err.message : String(err));
}

export interface UseCommand {
  /** Rejects with `CommandError` (also recorded in `error`). */
  run<T = unknown>(body: CommandBody): Promise<T>;
  /** True while any call is in flight. */
  pending: boolean;
  /** Error of the latest call (cleared when a new call starts). */
  error: CommandError | null;
  reset(): void;
}

/** Run commands against one device with pending/error state. */
export function useCommand(id: string): UseCommand {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<CommandError | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async <T = unknown,>(body: CommandBody): Promise<T> => {
      const mine = ++seq.current;
      setError(null);
      setPending((n) => n + 1);
      try {
        return await sendCommand<T>(id, body);
      } catch (err) {
        const ce = asCommandError(err);
        if (mounted.current && mine === seq.current) setError(ce);
        throw ce;
      } finally {
        if (mounted.current) setPending((n) => n - 1);
      }
    },
    [id],
  );
  const reset = useCallback(() => {
    seq.current++;
    setError(null);
  }, []);
  return { run, pending: pending > 0, error, reset };
}

/** GET /api/devices/:id/v1/<path> (device passthrough, e.g. "status", "network/scan"). */
export function deviceGet<T>(id: string, path: string): Promise<T> {
  return apiFetch<T>(`${dev(id)}/v1/${path.replace(/^\/+/, "")}`);
}

/** `useApi` on the passthrough URL; pass `null` as path to skip. */
export function useDeviceResource<T>(id: string, path: string | null): ApiResource<T> {
  const clean = path === null ? null : path.replace(/^\/+/, "");
  const res = useApi<T>(clean === null ? null : `${dev(id)}/v1/${clean}`);
  useReloadOnConfigChange(id, clean !== null && CONFIG_PATHS.has(clean), res.reload);
  return res;
}

export interface CommandResource<T> {
  data: T | null;
  error: CommandError | null;
  loading: boolean;
  reload(): void;
}

/** Run a read-only command (`module.list`, `rule.list`, `module.catalog`) on mount and on `reload()`. `null` skips. */
export function useDeviceCommandResult<T>(id: string, body: CommandBody | null): CommandResource<T> {
  const key = body ? JSON.stringify(body) : null;
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ req: string; data: T | null; error: CommandError | null } | null>(null);
  const req = `${id}|${key ?? ""}|${nonce}`;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    sendCommand<T>(id, JSON.parse(key) as CommandBody)
      .then((data) => live && setState({ req, data, error: null }))
      .catch((err: unknown) => live && setState({ req, data: null, error: asCommandError(err) }));
    return () => {
      live = false;
    };
  }, [id, key, req]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useReloadOnConfigChange(id, body !== null && CONFIG_READS.has(body.cmd), reload);
  const current = state?.req === req ? state : null;
  return {
    data: current ? current.data : (state?.data ?? null),
    error: current?.error ?? null,
    loading: key !== null && current === null,
    reload,
  };
}

/** GET /api/devices/:id/pin-config. */
export function getPinConfig(id: string): Promise<PinConfigResponse> {
  return apiFetch<PinConfigResponse>(`${dev(id)}/pin-config`);
}

export function usePinConfig(id: string): ApiResource<PinConfigResponse> {
  const res = useApi<PinConfigResponse>(`${dev(id)}/pin-config`);
  useReloadOnConfigChange(id, true, res.reload);
  return res;
}
