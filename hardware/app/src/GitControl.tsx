import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type GitStatus } from "./api"
import { useToast } from "./toast"

export default function GitControl({ git, design, onChange }: { git: GitStatus | null; design: string | null; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmPush, setConfirmPush] = useState(false)
  const toast = useToast()
  if (!git) return null

  const mine = design ? git.files.filter((f) => f.path.replace(/\\/g, "/").includes(`designs/${design}/`)) : []
  const label = git.dirty ? `${git.files.length} changed` : "clean"

  const run = async (fn: () => Promise<{ ok: boolean; output: string }>, okText: string) => {
    setBusy(true)
    try {
      const r = await fn()
      toast(r.ok ? "ok" : "err", r.ok ? okText : r.output.slice(0, 200) || "Failed")
      if (r.ok) { setMsg(""); setConfirmPush(false) }
    } catch (e: any) {
      toast("err", e.message)
    }
    setBusy(false)
    onChange()
  }

  return (
    <div className="git">
      <button className="btn ghost" onClick={() => { setOpen((o) => !o); setConfirmPush(false) }}>
        <span className={`dot ${git.dirty ? "warn" : "good"}`} />
        <span className="mono">{git.branch}</span>
        <span className="muted">{label}{git.ahead ? ` · ${git.ahead}↑` : ""}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="popover"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ type: "spring", visualDuration: 0.22, bounce: 0 }}
          >
            <div className="pop-title">Changes {design && <span className="muted">({mine.length} in {design})</span>}</div>
            <ul className="files mono">
              {git.files.length === 0 && <li className="muted">Working tree clean</li>}
              {git.files.slice(0, 12).map((f) => (
                <li key={f.path}><b>{f.status}</b> {f.path}</li>
              ))}
              {git.files.length > 12 && <li className="muted">+{git.files.length - 12} more</li>}
            </ul>
            <textarea className="input" rows={2} placeholder="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} />
            <div className="row end">
              <button className="btn primary" disabled={busy || !msg.trim() || !git.dirty} onClick={() => run(() => api.commit(msg.trim()), "Committed")}>Commit all</button>
            </div>
            <hr />
            {!confirmPush ? (
              <div className="row between">
                <span className="muted">{git.ahead} commit{git.ahead === 1 ? "" : "s"} ahead</span>
                <button className="btn" disabled={busy} onClick={() => setConfirmPush(true)}>Push…</button>
              </div>
            ) : (
              <div className="row between">
                <span>Push <b className="mono">{git.branch}</b> to remote?</span>
                <span className="row">
                  <button className="btn" onClick={() => setConfirmPush(false)}>Cancel</button>
                  <button className="btn danger" disabled={busy} onClick={() => run(api.push, "Pushed")}>Confirm push</button>
                </span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
