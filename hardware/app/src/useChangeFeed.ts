import { useEffect, useRef, useSyncExternalStore } from "react"
import type { ChangeEvent } from "../../shared/changes"

/** `resync`: the socket reconnected after a gap, so anything may have changed while it was away. */
export type FeedEvent = ChangeEvent | { type: "resync"; at: number }
type Status = "connecting" | "live" | "offline"

// One socket for the whole page, shared by every subscriber. It opens with the first subscriber,
// closes shortly after the last one leaves, and reconnects with a growing delay while the API is away.
const listeners = new Set<(e: FeedEvent) => void>()
const statusListeners = new Set<() => void>()
let socket: WebSocket | null = null
let status: Status = "offline"
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null
let hadConnection = false

const setStatus = (s: Status) => { if (s !== status) { status = s; statusListeners.forEach((f) => f()) } }
const emit = (e: FeedEvent) => listeners.forEach((f) => { try { f(e) } catch { /* one bad subscriber must not stop the rest */ } })

function connect() {
  if (socket || listeners.size === 0) return
  setStatus("connecting")
  let ws: WebSocket
  try { ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`) } catch { return schedule() }
  socket = ws
  ws.onopen = () => { retry = 0; setStatus("live") }
  ws.onmessage = (m) => {
    let e: ChangeEvent
    try { e = JSON.parse(String(m.data)) } catch { return }
    if (e.type === "hello") {
      // the first hello is just "connected"; a later one means we were away and may have missed changes
      if (hadConnection) emit({ type: "resync", at: e.at })
      hadConnection = true
      return
    }
    emit(e)
  }
  ws.onclose = () => { if (socket === ws) { socket = null; setStatus("offline"); schedule() } }
  ws.onerror = () => { try { ws.close() } catch { /* already closed */ } }
}
function schedule() {
  if (retryTimer || listeners.size === 0) return
  const wait = Math.min(15000, 1000 * 2 ** retry++)
  retryTimer = setTimeout(() => { retryTimer = null; connect() }, wait)
}
function release() {
  if (listeners.size > 0 || closeTimer) return
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (listeners.size > 0) return
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    const s = socket; socket = null; hadConnection = false; retry = 0
    try { s?.close() } catch { /* already closed */ }
    setStatus("offline")
  }, 3000)
}

/** Call `on` for every change the API reports (files changed on disk, designs added or removed, orders). */
export function useChangeFeed(on: (e: FeedEvent) => void) {
  const ref = useRef(on)
  ref.current = on
  useEffect(() => {
    const fn = (e: FeedEvent) => ref.current(e)
    listeners.add(fn)
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    connect()
    return () => { listeners.delete(fn); release() }
  }, [])
}

/** "live" while the socket is connected, so the UI can show whether it is hearing about changes. */
export function useFeedStatus(): Status {
  return useSyncExternalStore((cb) => { statusListeners.add(cb); return () => { statusListeners.delete(cb) } }, () => status)
}
