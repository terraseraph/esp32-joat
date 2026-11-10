import type { BrowserWsClientMessage, BrowserWsMessage } from "@shared/api";
import { createStore, type Store } from "./store";

export type WsState = "connecting" | "open" | "closed";
export interface WsSnapshot {
  state: WsState;
  /** True once the socket has been open at least once (distinguishes "Connecting" from "Reconnecting"). */
  everOpened: boolean;
}

type MessageOf<K extends BrowserWsMessage["t"]> = Extract<BrowserWsMessage, { t: K }>;
type AnyHandler = (msg: BrowserWsMessage) => void;

export interface BrowserWsClient {
  /** Connection state; read with `useStore(client.store)`. */
  readonly store: Store<WsSnapshot>;
  /** Start connecting (idempotent). Reconnects forever with backoff 1 s to 15 s until `close()`. */
  connect(): void;
  /** Stop and do not reconnect. */
  close(): void;
  /** Returns false when the socket is not open (nothing is queued). */
  send(msg: BrowserWsClientMessage): boolean;
  /** Subscribe to server messages by their `t` field; `"*"` receives everything. Returns an unsubscribe function. */
  subscribe<K extends BrowserWsMessage["t"]>(type: K, handler: (msg: MessageOf<K>) => void): () => void;
  subscribe(type: "*", handler: AnyHandler): () => void;
}

export interface WsOptions {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export function defaultWsUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`;
}

export function createBrowserWsClient(opts: WsOptions = {}): BrowserWsClient {
  const minDelay = opts.minDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 15000;
  const store = createStore<WsSnapshot>({ state: "closed", everOpened: false });
  const handlers = new Map<string, Set<AnyHandler>>();
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = minDelay;
  let wanted = false;

  const setState = (state: WsState) => store.set((p) => ({ state, everOpened: p.everOpened || state === "open" }));

  function dispatch(msg: BrowserWsMessage) {
    for (const key of [msg.t, "*"]) {
      for (const h of [...(handlers.get(key) ?? [])]) {
        try {
          h(msg);
        } catch (err) {
          console.error("ws handler failed", err);
        }
      }
    }
  }

  function scheduleReconnect() {
    if (!wanted || timer) return;
    const wait = delay;
    delay = Math.min(delay * 2, maxDelay);
    timer = setTimeout(() => {
      timer = null;
      open();
    }, wait);
  }

  function open() {
    if (!wanted || socket) return;
    setState("connecting");
    let sock: WebSocket;
    try {
      const Impl = opts.WebSocketImpl ?? WebSocket;
      sock = new Impl(opts.url ?? defaultWsUrl());
    } catch {
      setState("closed");
      scheduleReconnect();
      return;
    }
    socket = sock;
    sock.onopen = () => {
      if (socket !== sock) return;
      delay = minDelay;
      setState("open");
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (socket !== sock || typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as BrowserWsMessage;
        if (msg && typeof msg.t === "string") dispatch(msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    sock.onclose = () => {
      if (socket !== sock) return;
      socket = null;
      setState("closed");
      scheduleReconnect();
    };
    sock.onerror = () => {
      /* a close event always follows */
    };
  }

  function subscribe(type: string, handler: AnyHandler): () => void {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    const bucket = set;
    bucket.add(handler);
    return () => {
      bucket.delete(handler);
    };
  }

  return {
    store,
    connect() {
      wanted = true;
      open();
    },
    close() {
      wanted = false;
      if (timer) clearTimeout(timer);
      timer = null;
      const sock = socket;
      socket = null;
      sock?.close();
      setState("closed");
    },
    send(msg) {
      if (!socket || store.get().state !== "open") return false;
      socket.send(JSON.stringify(msg));
      return true;
    },
    subscribe: subscribe as BrowserWsClient["subscribe"],
  };
}

let instance: BrowserWsClient | null = null;

/** The single browser WebSocket client for the whole app (created lazily, started by `connect()`). */
export function getBrowserWs(): BrowserWsClient {
  return (instance ??= createBrowserWsClient());
}

/** Tests only: drop the singleton so the next `getBrowserWs()` builds a fresh client. */
export function resetBrowserWs(): void {
  instance?.close();
  instance = null;
}
