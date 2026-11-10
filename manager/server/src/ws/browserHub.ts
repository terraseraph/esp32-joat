import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserWsClientMessage, BrowserWsMessage, DeviceSummary } from "../types/api";

export interface BrowserHubOptions {
  version: string;
  /** LAN mode (a function follows runtime changes; it is read for every `hello`). */
  lan: boolean | (() => boolean);
  /** Ping interval; dead sockets (no pong since the previous ping) are terminated. Default 30 s. */
  pingIntervalMs?: number;
  /** Full device list for the `devices` message sent on connect. */
  getDevices?: () => DeviceSummary[];
  /** Current summary of one device (undefined once it is gone); used when flushing `device` pushes. */
  getDevice?: (id: string) => DeviceSummary | undefined;
  /** Coalescing window for `device` pushes (default 100 ms). */
  deviceCoalesceMs?: number;
  log?: (msg: string) => void;
}

export interface BrowserHub {
  /**
   * Complete a WebSocket upgrade (call only AFTER the security checks passed).
   * `local` tags the connection as the local user (loopback socket and loopback Host); untagged sockets count as remote.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, meta?: { local?: boolean }): void;
  /** Close every browser socket that was not tagged local (LAN access switched off, token regenerated). Returns how many. */
  closeRemote(code: number, reason: string): number;
  /** Send to every connected browser. */
  broadcast(msg: BrowserWsMessage): void;
  /** Send to one browser. */
  send(ws: WebSocket, msg: BrowserWsMessage): void;
  /** Register a handler for messages from browsers (unknown `t` values simply have no handler). */
  onMessage(handler: (msg: BrowserWsClientMessage, ws: WebSocket) => void): void;
  /** Register a handler called once when a browser socket closes (watch sets are dropped there). */
  onClose(handler: (ws: WebSocket) => void): void;
  /** A device summary may have changed: pushes `{t:"device"}` after the coalescing window, only if it really differs from what was sent last. */
  deviceChanged(id: string): void;
  /** The device was forgotten: pushes `{t:"deviceRemoved"}` now. */
  deviceRemoved(id: string): void;
  clientCount(): number;
  close(): Promise<void>;
}

export function createBrowserHub(opts: BrowserHubOptions): BrowserHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  const local = new WeakMap<WebSocket, boolean>();
  const pendingLocal = new WeakMap<IncomingMessage, boolean>();
  const handlers: ((msg: BrowserWsClientMessage, ws: WebSocket) => void)[] = [];
  const closeHandlers: ((ws: WebSocket) => void)[] = [];
  const dirty = new Set<string>();
  const lastSent = new Map<string, string>();
  let flushTimer: NodeJS.Timeout | null = null;
  const coalesceMs = opts.deviceCoalesceMs ?? 100;

  const flush = (): void => {
    flushTimer = null;
    const ids = [...dirty];
    dirty.clear();
    for (const id of ids) {
      const summary = opts.getDevice?.(id);
      if (!summary) continue;
      const json = JSON.stringify(summary);
      if (lastSent.get(id) === json) continue;
      lastSent.set(id, json);
      for (const ws of wss.clients) send(ws, { t: "device", id, summary });
    }
  };

  const send = (ws: WebSocket, msg: BrowserWsMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws, req) => {
    alive.set(ws, true);
    local.set(ws, pendingLocal.get(req) === true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", (err) => opts.log?.(`browser ws error: ${err.message}`));
    ws.on("close", () => {
      for (const h of closeHandlers) h(ws);
    });
    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null || typeof (msg as { t?: unknown }).t !== "string") return;
      for (const h of handlers) h(msg as BrowserWsClientMessage, ws);
    });
    send(ws, { t: "hello", server: { version: opts.version, lan: typeof opts.lan === "function" ? opts.lan() : opts.lan } });
    if (opts.getDevices) {
      const list = opts.getDevices();
      for (const d of list) lastSent.set(d.id, JSON.stringify(d));
      send(ws, { t: "devices", list });
    }
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.pingIntervalMs ?? 30_000);
  timer.unref();

  return {
    handleUpgrade(req, socket, head, meta) {
      pendingLocal.set(req, meta?.local === true);
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    closeRemote(code, reason) {
      let n = 0;
      for (const ws of wss.clients) {
        if (local.get(ws) === true) continue;
        n++;
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
        // A peer that never answers the close frame must not linger.
        setTimeout(() => ws.terminate(), 1000).unref();
      }
      return n;
    },
    broadcast(msg) {
      for (const ws of wss.clients) send(ws, msg);
    },
    send,
    onMessage(handler) {
      handlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    deviceChanged(id) {
      dirty.add(id);
      if (flushTimer) return;
      flushTimer = setTimeout(flush, coalesceMs);
      flushTimer.unref();
    },
    deviceRemoved(id) {
      dirty.delete(id);
      lastSent.delete(id);
      for (const ws of wss.clients) send(ws, { t: "deviceRemoved", id });
    },
    clientCount: () => wss.clients.size,
    close() {
      clearInterval(timer);
      if (flushTimer) clearTimeout(flushTimer);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
