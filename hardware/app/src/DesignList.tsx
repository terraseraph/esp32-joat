import { useState } from "react"
import { motion } from "motion/react"
import * as AlertDialog from "@radix-ui/react-alert-dialog"
import { api, iterApi, type DesignSummary, type GitStatus } from "./api"
import { useToast } from "./toast"
import NewDesignWizard from "./NewDesignWizard"
import { ago, link, needs, STAGES, type Board } from "./boards"
import { StageStrip, StatusChip } from "./ui"

export { ago }

export function Thumb({ d, large }: { d: DesignSummary; large?: boolean }) {
  const [bad, setBad] = useState(!d.hasThumb)
  if (bad)
    return (
      <div className={`thumb ph ${large ? "lg" : ""}`} aria-hidden>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="7" cy="9" r="1" /><circle cx="17" cy="15" r="1" /><path d="M7 9h5l2 6h3" /></svg>
      </div>
    )
  return <div className={`thumb ${large ? "lg" : ""}`}><img src={api.thumbUrl(d.name, d.modified)} alt="" onError={() => setBad(true)} loading="lazy" /></div>
}

/** The primary action on a card: the next thing that moves this board forward. */
function primary(b: Board): { label: string; href: string } {
  switch (b.status) {
    case "failing": return { label: `Fix ${b.errors} error${b.errors === 1 ? "" : "s"}`, href: link.design(b.name, "problems") }
    case "review": return { label: `Review ${b.open} item${b.open === 1 ? "" : "s"}`, href: link.design(b.name, "review") }
    case "ready": return { label: b.active ? "Continue order" : "Order boards", href: link.order(b.name) }
    case "ordered": return { label: "Track order", href: link.order(b.name) }
    case "delivered": return { label: "View order", href: link.order(b.name) }
    default: return { label: "Open workspace", href: link.design(b.name) }
  }
}

export default function DesignList({ boards, err, reload, git }: { boards: Board[] | null; err: string | null; reload: () => void; git: GitStatus | null }) {
  const [wizard, setWizard] = useState(false)
  const [del, setDel] = useState<string | null>(null)
  const toast = useToast()

  const dup = async (n: string) => {
    try { const r = await api.duplicate(n); toast("ok", `Duplicated as ${r.name}`); reload() } catch (e: any) { toast("err", e.message) }
  }
  const trash = async () => {
    if (!del) return
    try { const r = await api.trash(del); toast("ok", `Moved to ${r.trashedTo}`); reload() } catch (e: any) { toast("err", e.message) }
    setDel(null)
  }
  const variant = async (n: string) => {
    try {
      const v = await iterApi.variant(n)
      toast("ok", `Created ${v.name} (rev ${v.revision})`)
      location.hash = link.design(v.name)
    } catch (e: any) { toast("err", e.message) }
  }

  const list = boards ?? []
  const todo = needs(list)
  const inFab = list.filter((b) => b.status === "ordered").length
  const summary = boards ? `${list.length} board${list.length === 1 ? "" : "s"} · ${todo.filter((n) => n.tone !== "info").length} need${todo.filter((n) => n.tone !== "info").length === 1 ? "s" : ""} you · ${inFab} on order` : ""

  return (
    <div className="page-wrap">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">{summary || " "}</p>
        </div>
        <button className="btn primary" onClick={() => setWizard(true)}>+ New board</button>
      </div>
      <NewDesignWizard open={wizard} onOpenChange={setWizard} existing={list.map((b) => b.name)} />
      {err && <div className="empty err">Could not reach the API: {err}</div>}
      {!boards && !err && <div className="empty">Loading…</div>}
      {boards && boards.length === 0 && <div className="empty">No boards yet. Create one to get started.</div>}

      {todo.length > 0 && (
        <section className="needs" aria-label="Needs you">
          <h2>Needs you <span className="chip">{todo.length}</span></h2>
          <ul>
            {todo.map((n) => (
              <li key={n.id}>
                <span className={`dot ${n.tone === "bad" ? "bad" : n.tone === "warn" ? "warn" : ""}`} aria-hidden />
                <span className="need-text"><b className="mono">{n.board}</b> {n.text}</span>
                <a className="btn small-btn" href={n.href}>{n.action}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="cards">
        {list.map((b, i) => {
          const d = b.d
          const dirty = git?.files.some((f) => f.path.replace(/\\/g, "/").includes(`designs/${d.name}/`))
          const act = primary(b)
          return (
            <motion.article
              key={d.name}
              className="pcard"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.03, ease: "easeOut" }}
            >
              <a className="pcard-main" href={link.board(d.name)} aria-label={`${d.meta?.name || d.name}: overview`}>
                <Thumb d={d} />
                <div className="pcard-top">
                  <h3>{d.meta?.name || d.name}</h3>
                  <StatusChip status={b.status} />
                </div>
                <p className="pcard-desc">{d.meta?.description || <span className="muted">No description</span>}</p>
                <dl className="facts">
                  <div><dt>Rev</dt><dd className="mono">{d.meta?.revision ?? "-"}</dd></div>
                  <div><dt>Checks</dt><dd className="mono">{b.errors === null ? "not built" : `${b.errors} err · ${b.warnings} warn`}</dd></div>
                  <div><dt>Review</dt><dd className="mono">{b.total === 0 ? "none" : `${b.open} open / ${b.total}`}</dd></div>
                  <div><dt>Edited</dt><dd className="mono">{ago(d.modified) || "-"}{dirty && <span className="dirty-tag"> · uncommitted</span>}</dd></div>
                </dl>
                <StageStrip board={b} />
                <div className="strip-label small muted">{b.stage >= STAGES.length ? "All stages done" : `Next: ${STAGES[b.stage]}`}</div>
              </a>
              <div className="pcard-foot">
                <a className={`btn ${b.status === "ready" ? "primary" : ""}`} href={act.href}>{act.label}</a>
                <span className="grow" />
                <button className="icon-btn" title="New variant (copy to the next revision)" aria-label={`New variant of ${d.name}`} onClick={() => variant(d.name)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-11.2 5.6" /></svg>
                </button>
                <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${d.name}`} onClick={() => dup(d.name)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
                </button>
                <button className="icon-btn" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => setDel(d.name)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                </button>
              </div>
            </motion.article>
          )
        })}
      </div>

      <AlertDialog.Root open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="modal-overlay" />
          <AlertDialog.Content className="modal">
            <AlertDialog.Title className="modal-title">Delete "{del}"?</AlertDialog.Title>
            <AlertDialog.Description className="muted">The folder is moved to <span className="mono">hardware/.trash/</span>, so it can be restored by moving it back.</AlertDialog.Description>
            <div className="modal-actions">
              <AlertDialog.Cancel className="btn">Cancel</AlertDialog.Cancel>
              <AlertDialog.Action className="btn danger" onClick={trash}>Move to trash</AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}
