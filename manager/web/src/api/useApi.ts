import { useCallback, useEffect, useState } from "react";
import { ApiError, apiFetch } from "./client";

export interface ApiResource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload(): void;
}

const REVALIDATE = "de-esp32:revalidate";

/** Ask every mounted `useApi` whose path mentions this device to read again (data stays on screen while it does). */
export function revalidateDevice(id: string): void {
  window.dispatchEvent(new CustomEvent<string>(REVALIDATE, { detail: id }));
}

interface Result<T> {
  req: string;
  data: T | null;
  error: ApiError | null;
}

/** GET a JSON resource once (and again on `reload()`). Pass `null` to skip. */
export function useApi<T>(path: string | null): ApiResource<T> {
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Result<T> | null>(null);
  const req = `${path ?? ""}#${nonce}`;

  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    apiFetch<T>(path, { signal: ctl.signal })
      .then((data) => setResult({ req, data, error: null }))
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setResult({ req, data: null, error: err instanceof ApiError ? err : new ApiError(0, "unknown", String(err)) });
      });
    return () => ctl.abort();
  }, [path, req]);

  useEffect(() => {
    if (path === null) return;
    const on = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail;
      if (typeof id === "string" && path.includes(id)) setNonce((n) => n + 1);
    };
    window.addEventListener(REVALIDATE, on);
    return () => window.removeEventListener(REVALIDATE, on);
  }, [path]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = result?.req === req ? result : null;
  return {
    // keep showing the previous data while a reload is in flight
    data: current ? current.data : (result?.data ?? null),
    error: current?.error ?? null,
    loading: path !== null && current === null,
    reload,
  };
}
