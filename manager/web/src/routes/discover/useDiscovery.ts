import type { AdoptResponse, DiscoveryState, ScanRequest } from "@shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import { useStore } from "../../api/store";
import { getBrowserWs } from "../../api/ws";
import { deviceTitle } from "./display";
import { isRunningPhase } from "./grouping";

const EMPTY: DiscoveryState = {
  running: false,
  phase: "idle",
  probed: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  warnings: [],
  subnets: [],
  results: [],
  ignored: [],
  networkScan: true,
};

function asApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, "unknown", e instanceof Error ? e.message : String(e));
}

export interface Notice {
  tone: "ok" | "warn";
  text: string;
}

export interface DiscoveryApi {
  /** null until the first answer. */
  state: DiscoveryState | null;
  loadError: ApiError | null;
  starting: boolean;
  /** Error of the last scan start (`invalid_body` carries per-field details). */
  startError: ApiError | null;
  /** Error of the last adopt / ignore / un-ignore / cancel. */
  actionError: ApiError | null;
  notice: Notice | null;
  /** Ids with a request in flight (their buttons are disabled). */
  busy: ReadonlySet<string>;
  reload(): void;
  scan(request: ScanRequest): Promise<void>;
  cancel(): Promise<void>;
  adopt(ids: string[]): Promise<void>;
  ignore(id: string): Promise<void>;
  unignore(id: string): Promise<void>;
  dismissNotice(): void;
}

/**
 * State of the discovery screen: `GET /api/discovery` for the initial/authoritative state, WS `scan` messages for
 * live progress (polling stands in while the socket is down), and the action endpoints.
 */
export function useDiscovery(): DiscoveryApi {
  const [state, setState] = useState<DiscoveryState | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const getSeq = useRef(0); // newest GET wins
  const wsSeq = useRef(0); // counts WS messages: a GET that started before one must not overwrite its progress
  const lastPhase = useRef<DiscoveryState["phase"] | null>(null);

  const refresh = useCallback(() => {
    const mine = ++getSeq.current;
    const wsAtStart = wsSeq.current;
    apiFetch<DiscoveryState>("/api/discovery")
      .then((s) => {
        if (mine !== getSeq.current) return;
        setLoadError(null);
        if (wsSeq.current !== wsAtStart) {
          // live progress arrived meanwhile: keep it, take only what the WS message does not carry
          setState((prev) => ({
            ...(prev ?? s),
            warnings: s.warnings,
            subnets: s.subnets,
            ignored: s.ignored,
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
          }));
        } else {
          lastPhase.current = s.phase;
          setState(s);
        }
      })
      .catch((e: unknown) => {
        if (mine === getSeq.current) setLoadError(asApiError(e));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () =>
      getBrowserWs().subscribe("scan", (msg) => {
        wsSeq.current++;
        const changed = lastPhase.current !== msg.phase;
        lastPhase.current = msg.phase;
        setState((prev) => ({
          ...(prev ?? EMPTY),
          running: isRunningPhase(msg.phase),
          phase: msg.phase,
          probed: msg.probed,
          total: msg.total,
          results: msg.found,
        }));
        // subnets, warnings, the ignore list and timestamps only come with the full state
        if (changed) refresh();
      }),
    [refresh],
  );

  const wsState = useStore(getBrowserWs().store, (s) => s.state);
  const running = state?.running ?? false;
  useEffect(() => {
    if (!running || wsState === "open") return;
    const t = setInterval(() => refresh(), 1500);
    return () => clearInterval(t);
  }, [running, wsState, refresh]);

  const apply = useCallback((s: DiscoveryState) => {
    getSeq.current++; // drop GETs that started before this newer answer
    lastPhase.current = s.phase;
    setState(s);
  }, []);

  const withBusy = useCallback(async (ids: string[], fn: () => Promise<void>) => {
    setBusy((p) => new Set([...p, ...ids]));
    try {
      await fn();
    } finally {
      setBusy((p) => {
        const next = new Set(p);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  }, []);

  const scan = useCallback(
    async (request: ScanRequest) => {
      setStartError(null);
      setActionError(null);
      setNotice(null);
      setStarting(true);
      try {
        apply(await apiFetch<DiscoveryState>("/api/discovery/scan", { method: "POST", body: request }));
      } catch (e) {
        const err = asApiError(e);
        if (err.status === 409 && err.code === "scan_running") refresh(); // attach to the running scan
        else setStartError(err);
      } finally {
        setStarting(false);
      }
    },
    [apply, refresh],
  );

  const cancel = useCallback(async () => {
    setActionError(null);
    try {
      apply(await apiFetch<DiscoveryState>("/api/discovery/cancel", { method: "POST" }));
    } catch (e) {
      setActionError(asApiError(e));
    }
  }, [apply]);

  const adopt = useCallback(
    async (ids: string[]) => {
      setActionError(null);
      setNotice(null);
      await withBusy(ids, async () => {
        try {
          const res = await apiFetch<AdoptResponse>("/api/discovery/adopt", { method: "POST", body: { ids } });
          const names = res.added.map(deviceTitle);
          const skipped = res.skipped.length;
          if (names.length) {
            const extra = skipped ? ` ${skipped} skipped (already in the fleet or no longer found).` : "";
            setNotice({ tone: "ok", text: `Added ${names.join(", ")}.${extra}` });
          } else if (skipped) {
            setNotice({ tone: "warn", text: "Nothing was added: the board is already in the fleet or was not found in this scan." });
          }
        } catch (e) {
          setActionError(asApiError(e));
        }
        refresh(); // the server reclassifies the results
      });
    },
    [refresh, withBusy],
  );

  const ignore = useCallback(
    async (id: string) => {
      setActionError(null);
      setNotice(null);
      await withBusy([id], async () => {
        try {
          apply(await apiFetch<DiscoveryState>("/api/discovery/ignore", { method: "POST", body: { id } }));
        } catch (e) {
          setActionError(asApiError(e));
        }
      });
    },
    [apply, withBusy],
  );

  const unignore = useCallback(
    async (id: string) => {
      setActionError(null);
      setNotice(null);
      await withBusy([id], async () => {
        try {
          apply(await apiFetch<DiscoveryState>(`/api/discovery/ignore/${encodeURIComponent(id)}`, { method: "DELETE" }));
        } catch (e) {
          setActionError(asApiError(e));
        }
      });
    },
    [apply, withBusy],
  );

  return {
    state,
    loadError,
    starting,
    startError,
    actionError,
    notice,
    busy,
    reload: refresh,
    scan,
    cancel,
    adopt,
    ignore,
    unignore,
    dismissNotice: () => setNotice(null),
  };
}
