import { useCallback, useEffect, useRef, useState } from "react"
import * as Popover from "@radix-ui/react-popover"
import { aiApi, type AgentRun } from "./api"
import { useChangeFeed } from "./useChangeFeed"
import { useToast } from "./toast"

const STALE_MS = 60 * 60 * 1000

/**
 * The AI's open working draft, as a small chip in the toolbar: its edits are already in the design files, and this is where
 * you keep them or roll the whole run back to the snapshot taken before the first edit. Rolling back asks first.
 */
export default function DraftChip({ name, dirty, onRolledBack, onKept }: { name: string; dirty: boolean; onRolledBack: (files: Record<string, string>) => void; onKept: () => void }) {
  const toast = useToast()
  const [run, setRun] = useState<AgentRun | null>(null)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)

  const refresh = useCallback(() => { aiApi.run(name).then((r) => { if (alive.current) setRun(r) }).catch(() => {}) }, [name])
  useEffect(() => {
    alive.current = true
    setRun(null); setOpen(false); setConfirm(false)
    refresh()
    // an agent in chat (MCP) joins the same run, so poll as well as listening for the assistant finishing
    const t = setInterval(refresh, 5000)
    return () => { alive.current = false; clearInterval(t) }
  }, [name, refresh])
  useChangeFeed((e) => { if ((e.type === "ai" && e.design === name && e.phase === "done") || (e.type === "design" && e.name === name)) refresh() })

  if (!run || run.edits.length === 0) return null
  const n = run.edits.length
  const since = new Date(run.startedAt)
  const stale = Date.now() - since.getTime() > STALE_MS
  const when = since.toLocaleString(undefined, { dateStyle: stale ? "medium" : undefined, timeStyle: "short" })

  const keep = async () => {
    setBusy(true)
    try { await aiApi.acceptRun(name); setRun(null); setOpen(false); onKept() }
    catch (e: any) { toast("err", e.message) }
    finally { setBusy(false) }
  }
  const rollback = async () => {
    if (dirty) { setConfirm(false); toast("err", "Save or discard your editor changes first, then roll back."); return }
    setBusy(true)
    try {
      const r = await aiApi.rollbackRun(name)
      setRun(null); setOpen(false); setConfirm(false)
      onRolledBack(r.files)
      toast("ok", `Rolled back ${r.undone} edit${r.undone === 1 ? "" : "s"}`)
    } catch (e: any) { toast("err", e.message) }
    finally { setBusy(false) }
  }

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setConfirm(false) }}>
      <Popover.Trigger asChild>
        <button className={`draft-chip ${stale ? "stale" : ""}`} title={`AI working draft: ${n} edit${n === 1 ? "" : "s"} since ${when}${stale ? " (from an earlier session)" : ""}`} aria-label={`AI working draft, ${n} edits. Keep or roll back`}>
          <span className="dot" aria-hidden />
          <span className="draft-label">Draft</span>
          <b>{n}</b>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="draft-pop" align="start" sideOffset={8} collisionPadding={12}>
          <strong>AI working draft</strong>
          <p className="muted small">
            {n} edit{n === 1 ? "" : "s"} since {when}{stale ? ", from an earlier session" : ""}. They are already in the design files, so builds and checks include them.
          </p>
          <details>
            <summary>Edits in this run</summary>
            <ul className="draft-edits">{run.edits.map((e, i) => <li key={i} className="small"><code>{e.tool}</code> {e.summary}</li>)}</ul>
          </details>
          {confirm ? (
            <div className="draft-confirm" role="alertdialog">
              <p className="small"><b>Roll back all {n} edit{n === 1 ? "" : "s"}?</b> The design goes back to how it was before the first one ({when}). {dirty ? "You have unsaved editor changes; save or discard them first." : "Changes you made by hand since then are lost too."}</p>
              <div className="row">
                <button className="btn danger small-btn" disabled={busy || dirty} onClick={rollback}>Roll back</button>
                <button className="btn small-btn" onClick={() => setConfirm(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn primary small-btn" disabled={busy} onClick={keep}>Keep edits</button>
              <button className="btn small-btn" disabled={busy} onClick={() => setConfirm(true)}>Roll back…</button>
            </div>
          )}
          <Popover.Arrow className="draft-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
