import { useEffect, useState } from "react"
import { api, iterApi, type Cost, type SnapshotInfo } from "./api"
import { ago, link, type Board } from "./boards"
import { StageStrip, StatusChip } from "./ui"
import { Thumb } from "./DesignList"

type Tone = "ok" | "warn" | "bad" | "wait"
type Ready = { id: string; tone: Tone; title: string; detail: string; href?: string }
const MARK: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✕", wait: "–" }
const usd = (n: number) => `$${n.toFixed(2)}`
const QTY = 10

/** A board's front page: where it stands in plain sentences, what is left, and where to go next. */
export default function Overview({ board }: { board: Board }) {
  const { name, d } = board
  const [cost, setCost] = useState<Cost | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([])
  useEffect(() => {
    let live = true
    api.cost(name, QTY).then((c) => live && setCost(c)).catch(() => {})
    api.parts(name).then((p) => live && setCount(p.length)).catch(() => {})
    iterApi.snapshots(name).then((s) => live && setSnaps([...s].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))).catch(() => {})
    return () => { live = false }
  }, [name])

  const items = d.meta?.checklist ?? []
  const open = items.filter((i) => i.status === "open")

  const ready: Ready[] = [
    board.errors === null
      ? { id: "build", tone: "wait", title: "Build", detail: "Not built yet. Build it once in the workspace to check it.", href: link.design(name) }
      : { id: "build", tone: "ok", title: "Build", detail: "Builds and has a saved result." },
    board.errors === null
      ? { id: "checks", tone: "wait", title: "Design checks", detail: "Run after the first build." }
      : board.errors > 0
        ? { id: "checks", tone: "bad", title: "Design checks", detail: `${board.errors} error${board.errors === 1 ? "" : "s"} and ${board.warnings} warning${board.warnings === 1 ? "" : "s"} to fix.`, href: link.design(name, "problems") }
        : { id: "checks", tone: board.warnings ? "warn" : "ok", title: "Design checks", detail: board.warnings ? `No errors, ${board.warnings} warning${board.warnings === 1 ? "" : "s"}.` : "No errors or warnings." },
    board.total === 0
      ? { id: "review", tone: "wait", title: "Review checklist", detail: "No review items recorded for this board.", href: link.design(name, "review") }
      : board.open > 0
        ? { id: "review", tone: "warn", title: "Review checklist", detail: `${board.open} of ${board.total} items still open${board.fromNotes ? " (in the board notes)" : ""}.`, href: link.design(name, "review") }
        : { id: "review", tone: "ok", title: "Review checklist", detail: `All ${board.total} items resolved.` },
    !cost
      ? { id: "parts", tone: "wait", title: "Parts", detail: "Pricing the parts…" }
      : cost.missingCount > 0
        ? { id: "parts", tone: "warn", title: "Parts", detail: `${cost.missingCount}${count ? ` of ${count}` : ""} parts could not be priced (no LCSC number or no stock data).`, href: link.design(name, "bom") }
        : { id: "parts", tone: "ok", title: "Parts", detail: count ? `All ${count} parts priced.` : "All parts priced." },
  ]
  const nextHref = board.status === "failing" ? link.design(name, "problems") : board.status === "review" ? link.design(name, "review") : board.status === "ready" || board.status === "ordered" || board.status === "delivered" ? link.order(name) : link.design(name)
  const nextLabel = board.status === "failing" ? "Fix the errors" : board.status === "review" ? "Work through the review" : board.status === "ready" ? "Order boards" : board.status === "draft" ? "Open the workspace" : "Open the order"

  return (
    <div className="page-wrap">
      <div className="page-head">
        <div>
          <h1>{d.meta?.name || name} <span className="chip">rev {d.meta?.revision ?? "-"}</span></h1>
          <p className="muted">{d.meta?.description || "No description"}</p>
        </div>
        <div className="row">
          <a className="btn" href={link.design(name)}>Open workspace</a>
          <a className="btn primary" href={nextHref}>{nextLabel}</a>
        </div>
      </div>

      <div className="ov-grid">
        <div className="ov-main">
          <section className="panel-card hero">
            <Thumb d={d} large />
            <div className="hero-body">
              <div className="row"><StatusChip status={board.status} /><span className="muted small">{board.errors === null ? "Not built" : `${board.errors} errors · ${board.warnings} warnings`}</span></div>
              <StageStrip board={board} />
              <ul className="ready">
                {ready.map((r) => (
                  <li key={r.id} className={`t-${r.tone}`}>
                    <span className="mark" aria-hidden>{MARK[r.tone]}</span>
                    <div><b>{r.title}</b><span className="muted"> {r.detail}</span></div>
                    {r.href && <a className="link small" href={r.href}>Open</a>}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <div className="tiles">
            <div className="tile"><span className="muted small">Per board at {QTY}</span><b className="mono">{cost ? usd(cost.estimatedPerBoard) : "…"}</b><span className="small muted">{cost ? (cost.missingCount ? `${cost.missingCount} unpriced part${cost.missingCount === 1 ? "" : "s"}` : "estimate") : ""}</span></div>
            <div className="tile"><span className="muted small">Parts</span><b className="mono">{count ?? "…"}</b><span className="small muted">{cost ? `${cost.extendedTypes} extended type${cost.extendedTypes === 1 ? "" : "s"}` : ""}</span></div>
            <div className="tile"><span className="muted small">Board</span><b className="mono">{cost ? `${cost.fab.widthMm}×${cost.fab.heightMm}` : "…"}</b><span className="small muted">{cost ? `mm · ${cost.fab.layers} layers` : ""}</span></div>
            <div className="tile"><span className="muted small">Last edit</span><b className="mono">{ago(d.modified) || "-"}</b><span className="small muted">{snaps.length} snapshot{snaps.length === 1 ? "" : "s"}</span></div>
          </div>

          <section className="panel-card">
            <div className="row between"><h2>Review items</h2><a className="link small" href={link.design(name, "review")}>Open checklist</a></div>
            {items.length === 0 && board.fromNotes ? (
              <>
                <p className="muted small">{board.open} numbered items are still free text in the board notes. Open the checklist to split them into trackable items.</p>
                <p className="doubt-notes">{d.meta?.notes}</p>
              </>
            ) : items.length === 0 ? <p className="muted">No review items. Add some from the workspace's Review checklist.</p> : (
              <ul className="doubts">
                {items.map((i) => (
                  <li key={i.id} className={i.status}>
                    <span className={`dot ${i.status === "open" ? "warn" : i.status === "ok" ? "good" : ""}`} aria-hidden />
                    <span className="doubt-text">{i.text}</span>
                    <span className="chip">{i.status === "wontfix" ? "won't fix" : i.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="ov-side">
          <section className="panel-card">
            <h2>Ask the builder</h2>
            <p className="muted small">Describe a change and the AI builder works on a draft you can accept or roll back.</p>
            <a className="btn primary" href={link.design(name, "changes")}>Open the AI builder</a>
          </section>
          <section className="panel-card">
            <div className="row between"><h2>Orders</h2><a className="link small" href={link.order(name)}>Open</a></div>
            {board.orders.length === 0 ? <p className="muted small">No orders yet.</p> : (
              <ul className="mini-list">
                {board.orders.slice(0, 4).map((o) => (
                  <li key={o.id}><span className="chip">{o.status.replace("_", " ")}</span><span className="mono small">{o.qty} boards · ${o.total.toFixed(2)}{o.estimate ? " est." : ""}</span><span className="muted small">{ago(Date.parse(o.updatedAt))}</span></li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel-card">
            <div className="row between"><h2>Activity</h2><a className="link small" href={link.design(name, "history")}>History</a></div>
            {snaps.length === 0 ? <p className="muted small">No snapshots yet.</p> : (
              <ul className="mini-list">
                {snaps.slice(0, 5).map((s) => (
                  <li key={s.id}><span className="small">{s.label || (s.auto ? "Auto snapshot" : "Snapshot")}</span><span className="muted small">{ago(Date.parse(s.createdAt))}</span></li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
