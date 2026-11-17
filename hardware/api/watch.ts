import type { FastifyInstance } from "fastify"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import fs from "node:fs"
import path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import { ROOT } from "./build.js"
import type { ChangeEvent } from "../shared/changes.js"

// Same rule as the HTTP hook in server.ts: this is a local-only tool, so refuse cross-site pages and rebinding hosts.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
export const WS_PATH = "/api/ws"
const QUIET_MS = 250
const PING_MS = 30_000

/** Editor and tool temp files that are not changes to a design. */
const ignored = (file: string) => {
  const base = file.split(/[\\/]/).pop() ?? ""
  return !base || base.startsWith(".") || base.endsWith("~") || /\.(tmp|swp|swx)$/i.test(base) || file.split(/[\\/]/).includes("node_modules")
}

/** Turns raw file-system notifications into at most one event per design (or lib, or orders) per quiet period. */
export function createChangeBatcher(emit: (e: ChangeEvent) => void, quietMs = QUIET_MS) {
  const designs = new Map<string, Set<string>>()
  const lib = new Set<string>()
  let listChanged = false
  let orders = false
  let timer: NodeJS.Timeout | null = null
  const flush = () => {
    timer = null
    const at = Date.now()
    for (const [name, files] of designs) emit({ type: "design", name, files: [...files].sort(), at })
    if (lib.size) emit({ type: "lib", files: [...lib].sort(), at })
    if (listChanged) emit({ type: "designs", at })
    if (orders) emit({ type: "orders", at })
    designs.clear(); lib.clear(); listChanged = false; orders = false
  }
  const arm = () => { if (!timer) timer = setTimeout(flush, quietMs) }
  return {
    /** a path relative to hardware/designs */
    design(rel: string) {
      if (ignored(rel)) return
      const parts = rel.split(/[\\/]/)
      if (parts.length === 1) listChanged = true // a folder (or stray file) at the top level: the list may have changed
      else {
        const set = designs.get(parts[0]) ?? designs.set(parts[0], new Set()).get(parts[0])!
        set.add(parts.slice(1).join("/"))
        if (parts.length === 2 && !fs.existsSync(path.join(ROOT, "designs", parts[0], "index.tsx"))) listChanged = true
      }
      arm()
    },
    /** a path relative to hardware/lib */
    lib(rel: string) { if (!ignored(rel)) { lib.add(rel.replace(/\\/g, "/")); arm() } },
    /** a path relative to hardware/.cache/orders */
    order(rel: string) { if (!ignored(rel)) { orders = true; arm() } },
    stop() { if (timer) clearTimeout(timer); timer = null },
  }
}

/** Live change feed: `GET /api/ws` upgrades to a WebSocket that receives ChangeEvent JSON. Nothing is read from clients. */
export function registerChangeFeed(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true })
  const send = (ws: WebSocket, e: ChangeEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)) }
  const broadcast = (e: ChangeEvent) => { for (const ws of wss.clients) send(ws, e) }
  const batcher = createChangeBatcher(broadcast)

  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head) => {
    const url = (req.url ?? "").split("?")[0]
    if (url !== WS_PATH) return socket.destroy()
    const origin = req.headers.origin
    const originHost = origin ? origin.replace(/^https?:\/\//, "") : null
    if (!LOCAL.test(req.headers.host ?? "") || (originHost !== null && !LOCAL.test(originHost))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ;(ws as WebSocket & { alive?: boolean }).alive = true
      ws.on("pong", () => { (ws as WebSocket & { alive?: boolean }).alive = true })
      ws.on("error", () => {})
      send(ws, { type: "hello", at: Date.now() })
    })
  })

  // drop sockets that stopped answering pings
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (ws.alive === false) { ws.terminate(); continue }
      ws.alive = false
      ws.ping()
    }
  }, PING_MS)
  heartbeat.unref()

  const watchers: fs.FSWatcher[] = []
  const watch = (dir: string, onFile: (rel: string) => void, recursive = true) => {
    try {
      const w = fs.watch(dir, { recursive }, (_evt, file) => { if (file) onFile(file.toString()) })
      w.on("error", () => {})
      watchers.push(w)
    } catch { /* the folder does not exist (yet): that feed stays quiet */ }
  }
  watch(path.join(ROOT, "designs"), (rel) => batcher.design(rel))
  watch(path.join(ROOT, "lib"), (rel) => batcher.lib(rel))
  // .cache is written by every build, so only react to the orders folder inside it
  watch(path.join(ROOT, ".cache"), (rel) => { if (/^orders([\\/]|$)/.test(rel)) batcher.order(rel.replace(/^orders[\\/]?/, "")) })

  app.addHook("onClose", async () => {
    clearInterval(heartbeat)
    batcher.stop()
    for (const w of watchers) w.close()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
  })
}
