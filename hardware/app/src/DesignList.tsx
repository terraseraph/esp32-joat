import { useCallback, useEffect, useState } from "react"
import { motion } from "motion/react"
import * as AlertDialog from "@radix-ui/react-alert-dialog"
import { api, type DesignSummary, type GitStatus } from "./api"
import { useToast } from "./toast"
import NewDesignWizard from "./NewDesignWizard"

export const ago = (ms?: number) => {
  if (!ms) return ""
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(ms).toLocaleDateString()
}

function Thumb({ d }: { d: DesignSummary }) {
  const [bad, setBad] = useState(!d.hasThumb)
  if (bad)
    return (
      <div className="thumb ph" aria-hidden>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="7" cy="9" r="1" /><circle cx="17" cy="15" r="1" /><path d="M7 9h5l2 6h3" /></svg>
      </div>
    )
  return <div className="thumb"><img src={api.thumbUrl(d.name, d.modified)} alt="" onError={() => setBad(true)} loading="lazy" /></div>
}

export default function DesignList({ git }: { git: GitStatus | null }) {
  const [list, setList] = useState<DesignSummary[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [wizard, setWizard] = useState(false)
  const [del, setDel] = useState<string | null>(null)
  const toast = useToast()

  const load = useCallback(() => { api.designs().then(setList).catch((e) => setErr(e.message)) }, [])
  useEffect(load, [load])

  const dup = async (n: string) => {
    try {
      const r = await api.duplicate(n)
      toast("ok", `Duplicated as ${r.name}`)
      load()
    } catch (e: any) { toast("err", e.message) }
  }
  const trash = async () => {
    if (!del) return
    try {
      const r = await api.trash(del)
      toast("ok", `Moved to ${r.trashedTo}`)
      load()
    } catch (e: any) { toast("err", e.message) }
    setDel(null)
  }

  const sorted = list ? [...list].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)) : null

  return (
    <div className="list-page">
      <div className="list-head">
        <h1>Designs</h1>
        <button className="btn primary" onClick={() => setWizard(true)}>+ New design</button>
      </div>
      <NewDesignWizard open={wizard} onOpenChange={setWizard} existing={list?.map((d) => d.name) ?? []} />
      {err && <div className="empty err">Could not reach the API: {err}</div>}
      {!list && !err && <div className="empty">Loading…</div>}
      {list && list.length === 0 && <div className="empty">No designs yet. Create one to get started.</div>}
      <div className="cards">
        {sorted?.map((d, i) => {
          const dirty = git?.files.some((f) => f.path.replace(/\\/g, "/").includes(`designs/${d.name}/`))
          return (
            <motion.div
              key={d.name}
              className="card-wrap"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.03, ease: "easeOut" }}
              whileHover={{ y: -2 }}
            >
              <a href={`#/design/${encodeURIComponent(d.name)}`} className="card">
                <Thumb d={d} />
                <div className="card-top">
                  <h3>{d.meta?.name || d.name}</h3>
                  {d.meta?.revision && <span className="chip">rev {d.meta.revision}</span>}
                </div>
                <p>{d.meta?.description || <span className="muted">No description</span>}</p>
                <div className="card-foot mono">
                  <span>{d.name}{d.modified ? ` · ${ago(d.modified)}` : ""}</span>
                  {dirty && <span className="dirty-tag">uncommitted</span>}
                </div>
              </a>
              <div className="card-actions">
                <button className="icon-btn" title="Duplicate" aria-label={`Duplicate ${d.name}`} onClick={() => dup(d.name)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
                </button>
                <button className="icon-btn" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => setDel(d.name)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                </button>
              </div>
            </motion.div>
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
