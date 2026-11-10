import { getBrowserWs, type WsState } from "./ws";

const refs = new Map<string, number>();
/** JSON of the last id list the current socket was told about; null = nothing sent on this socket. */
let lastSent: string | null = null;
let scheduled = false;
let unsubscribe: (() => void) | null = null;
let lastState: WsState = "closed";

function union(): string[] {
  return [...refs.keys()].sort();
}

function flush(): void {
  scheduled = false;
  const ids = union();
  const key = JSON.stringify(ids);
  // A fresh socket starts with an empty watch set, so "nothing watched" needs no message until something was sent.
  if (key === (lastSent ?? "[]")) return;
  if (getBrowserWs().send({ t: "watch", ids })) lastSent = key;
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

function ensureStarted(): void {
  if (unsubscribe) return;
  const ws = getBrowserWs();
  lastState = ws.store.get().state;
  unsubscribe = ws.store.subscribe(() => {
    const next = ws.store.get().state;
    if (next === lastState) return;
    lastState = next;
    lastSent = null; // a new socket starts with an empty watch set
    if (next === "open") schedule();
  });
}

/** Ids currently watched (sorted). */
export function watchedIds(): string[] {
  return union();
}

/**
 * Ask the server for live data (`link`/`live`/`io`/`event`) of a device. Reference counted: the returned
 * function releases this watch (idempotent). The union of ids is sent once per tick and again after every WS (re)open.
 */
export function watchDevice(id: string): () => void {
  ensureStarted();
  refs.set(id, (refs.get(id) ?? 0) + 1);
  schedule();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (refs.get(id) ?? 1) - 1;
    if (n <= 0) refs.delete(id);
    else refs.set(id, n);
    schedule();
  };
}

/** Tests only. */
export function resetWatch(): void {
  unsubscribe?.();
  unsubscribe = null;
  refs.clear();
  lastSent = null;
  scheduled = false;
  lastState = "closed";
}
