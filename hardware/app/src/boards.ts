import { useCallback, useEffect, useRef, useState } from "react"
import { api, orderApi, type DesignSummary, type OrderSummary } from "./api"

// ---- routes (hash based, so the old #/design/<name> links keep working) ----
export type Route =
  | { page: "projects" }
  | { page: "orders" }
  | { page: "settings" }
  | { page: "board" | "design" | "order"; name: string; panel?: string | null }

export function parseRoute(hash = location.hash): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?")
  const [a, b] = path.split("/")
  const name = b ? decodeURIComponent(b) : ""
  const panel = new URLSearchParams(query).get("panel")
  if ((a === "board" || a === "design" || a === "order") && name) return { page: a, name, panel }
  if (a === "orders") return { page: "orders" }
  if (a === "settings") return { page: "settings" }
  return { page: "projects" }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute())
  useEffect(() => {
    const on = () => setRoute(parseRoute())
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])
  return route
}

const enc = encodeURIComponent
export const link = {
  projects: () => "#/",
  orders: () => "#/orders",
  settings: () => "#/settings",
  board: (n: string) => `#/board/${enc(n)}`,
  design: (n: string, panel?: string) => `#/design/${enc(n)}${panel ? `?panel=${panel}` : ""}`,
  order: (n: string) => `#/order/${enc(n)}`,
}

// ---- board status: derived from the last build, the review checklist and the orders; never stored ----
export type Status = "draft" | "failing" | "review" | "ready" | "ordered" | "delivered"
export const STATUS_LABEL: Record<Status, string> = {
  draft: "Draft", failing: "Checks failing", review: "In review", ready: "Ready to order", ordered: "Ordered", delivered: "Delivered",
}
/** The pipeline every board moves through; the order steps follow the order status the ordering API records. */
export const STAGES = ["Design", "Pre-flight", "BOM & stock", "Quote", "Ordered", "Delivered"] as const

export type Board = {
  d: DesignSummary
  name: string
  status: Status
  /** index of the first unfinished stage (STAGES.length = all done) */
  stage: number
  errors: number | null
  warnings: number | null
  open: number
  total: number
  /** the review items are still free text in board.json "notes", not a structured checklist */
  fromNotes: boolean
  orders: OrderSummary[]
  active?: OrderSummary
}

function derive(d: DesignSummary, built: Awaited<ReturnType<typeof api.cachedBuild>>, all: OrderSummary[]): Board {
  const items = d.meta?.checklist ?? []
  // Boards that predate the checklist keep numbered doubts "(1) ... (2) ..." in the notes string; count those as open.
  const notes = d.meta?.notes ?? ""
  const noted = items.length === 0 ? new Set([...notes.matchAll(/\((\d{1,2})\)/g)].map((m) => m[1])).size || (/not reviewed/i.test(notes) ? 1 : 0) : 0
  const open = items.length ? items.filter((i) => i.status === "open").length : noted
  const errors = built ? Math.max(built.errors.length, built.checks?.counts.error ?? 0) : null
  const warnings = built ? Math.max(built.warnings.length, built.checks?.counts.warning ?? 0) : null
  const orders = all.filter((o) => o.design === d.name).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const active = orders.find((o) => o.status !== "cancelled")
  let status: Status
  let stage: number
  if (active?.status === "delivered") { status = "delivered"; stage = STAGES.length }
  else if (active && ["submitted", "in_fab", "shipped"].includes(active.status)) { status = "ordered"; stage = 5 }
  else if (!built) { status = "draft"; stage = 0 }
  else if ((errors ?? 0) > 0) { status = "failing"; stage = 0 }
  else if (open > 0) { status = "review"; stage = 1 }
  else { status = "ready"; stage = active?.status === "quoted" ? 4 : active ? 3 : 2 }
  return { d, name: d.name, status, stage, errors, warnings, open, total: items.length || noted, fromNotes: items.length === 0 && noted > 0, orders, active }
}

export function useBoards() {
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const id = ++seq.current
    try {
      const [list, orders] = await Promise.all([api.designs(), orderApi.all().catch(() => [] as OrderSummary[])])
      const built = await Promise.all(list.map((d) => api.cachedBuild(d.name)))
      if (id !== seq.current) return
      setBoards(list.map((d, i) => derive(d, built[i], orders)).sort((a, b) => (b.d.modified ?? 0) - (a.d.modified ?? 0)))
      setErr(null)
    } catch (e: any) { if (id === seq.current) setErr(e.message) }
  }, [])
  useEffect(() => { reload() }, [reload])
  return { boards, err, reload }
}

/** One line per thing that needs the user, across every board (the "Needs you" strip). */
export type Need = { id: string; tone: "bad" | "warn" | "info"; board: string; text: string; action: string; href: string }
export function needs(boards: Board[]): Need[] {
  const out: Need[] = []
  for (const b of boards) {
    if (b.status === "failing") out.push({ id: `${b.name}:err`, tone: "bad", board: b.name, text: `has ${b.errors} design-rule error${b.errors === 1 ? "" : "s"}`, action: "Open", href: link.design(b.name, "problems") })
    else if (b.status === "review") out.push({ id: `${b.name}:doubts`, tone: "warn", board: b.name, text: `has ${b.open} open review item${b.open === 1 ? "" : "s"} before it can be ordered`, action: "Review", href: link.design(b.name, "review") })
    if (b.active && ["submitted", "in_fab", "shipped"].includes(b.active.status)) out.push({ id: `${b.name}:order`, tone: "info", board: b.name, text: `order ${b.active.status === "shipped" ? "has shipped" : b.active.status === "in_fab" ? "is in fabrication" : "is placed"}`, action: "Track", href: link.order(b.name) })
  }
  return out
}

export const ago = (ms?: number) => {
  if (!ms) return ""
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(ms).toLocaleDateString()
}
