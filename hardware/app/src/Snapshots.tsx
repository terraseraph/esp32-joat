import { useCallback, useEffect, useState } from "react"
import { iterApi, type DiffResult, type SnapshotInfo } from "./api"
import { KIND_COLOR } from "./DiffView"
import { useToast } from "./toast"

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })

export type ActiveDiff = { result: DiffResult; label: string }

export default function Snapshots({ name, files, version, diff, focus, onFocus, onDiff, onRestore }: {
  name: string
  files: Record<string, string>
  version: number
  diff: ActiveDiff | null
  focus: string | null
  onFocus: (n: string | null) => void
  onDiff: (d: ActiveDiff | null) => void
  onRestore: (files: Record<string, string>) => void
}) {
  const toast = useToast()
  const [list, setList] = useState<SnapshotInfo[]>([])
  const [label, setLabel] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("current")

  const refresh = useCallback(() => iterApi.snapshots(name).then(setList).catch(() => setList([])), [name])
  useEffect(() => { refresh() }, [refresh, version])

  const title = (s: SnapshotInfo) => s.label || fmt(s.createdAt)
  const nameOf = (id: string) => {
    const s = list.find((x) => x.id === id)
    return s ? title(s) : "current"
  }

  const save = async () => {
    setBusy("save")
    try { await iterApi.snapshot(name, label, files); setLabel(""); toast("ok", "Snapshot saved"); await refresh() }
    catch (e: any) { toast("err", e.message) } finally { setBusy(null) }
  }
  const restore = async (s: SnapshotInfo) => {
    setBusy(s.id)
    try {
      const r = await iterApi.restore(name, s.id)
      onRestore(r.files)
      toast("ok", "Restored. The previous state was kept as a snapshot, and Ctrl+Z undoes it")
      await refresh()
    } catch (e: any) { toast("err", e.message) } finally { setBusy(null) }
  }
  const remove = async (s: SnapshotInfo) => {
    if (!confirm(`Delete snapshot "${s.label || fmt(s.createdAt)}"? This cannot be undone.`)) return
    try { await iterApi.deleteSnapshot(name, s.id); await refresh() } catch (e: any) { toast("err", e.message) }
  }
  const compare = async (a: string, b: string) => {
    setBusy("diff")
    try {
      const result = await iterApi.diff(name, a, b, a === "current" || b === "current" ? files : undefined)
      onDiff({ result, label: `${nameOf(a)} to ${nameOf(b)}` })
    } catch (e: any) { toast("err", `Diff failed: ${e.message}`) } finally { setBusy(null) }
  }

  return (
    <div className="snaps">
      <div className="snap-col">
        <form className="row" onSubmit={(e) => { e.preventDefault(); save() }}>
          <input className="input" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn primary" type="submit" disabled={busy === "save"}>Save snapshot</button>
        </form>
        {list.length === 0 && <p className="muted small">No snapshots yet. They are stored outside git, in hardware/.cache/snapshots.</p>}
        <ul className="snap-list">
          {list.map((s) => (
            <li key={s.id} className={s.auto ? "auto" : ""}>
              <div className="snap-main">
                <b>{s.label || "Snapshot"}</b>
                <span className="muted small">{fmt(s.createdAt)}{s.auto ? " · automatic" : ""}</span>
              </div>
              <button className="btn ghost" disabled={!!busy} onClick={() => compare(s.id, "current")} title="Show what changed since this snapshot">Diff vs now</button>
              <button className="btn ghost" disabled={!!busy} onClick={() => restore(s)}>Restore</button>
              <button className="icon-btn" aria-label="Delete snapshot" title="Delete" onClick={() => remove(s)}>×</button>
            </li>
          ))}
        </ul>
        {list.length > 0 && (
          <div className="row small">
            <span className="muted">Compare</span>
            <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">pick…</option>
              {list.map((s) => <option key={s.id} value={s.id}>{title(s)}</option>)}
            </select>
            <span className="muted">to</span>
            <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="current">current</option>
              {list.map((s) => <option key={s.id} value={s.id}>{title(s)}</option>)}
            </select>
            <button className="btn" disabled={!from || from === to || !!busy} onClick={() => compare(from, to)}>Compare</button>
          </div>
        )}
        {busy === "diff" && <p className="muted small">Building both revisions. This can take a while on large boards.</p>}
      </div>
      <div className="snap-col diff-list">
        {!diff ? <p className="muted small">Pick two revisions to see added, removed, moved and changed parts.</p> : (
          <>
            <div className="small">
              <b>{diff.label}</b>
              {diff.result.boardChange && <span className="muted"> · {diff.result.boardChange}</span>}
              {(diff.result.errors.from > 0 || diff.result.errors.to > 0) && <span className="muted"> · build errors: {diff.result.errors.from} to {diff.result.errors.to}</span>}
            </div>
            {diff.result.items.length === 0 && <p className="muted small">No part differences.</p>}
            <ul className="snap-list">
              {diff.result.items.map((it) => (
                <li key={it.name} className={focus === it.name ? "sel" : ""} onClick={() => onFocus(it.name)}>
                  <span className="kind" style={{ background: KIND_COLOR[it.kind] }}>{it.kind}</span>
                  <b className="mono">{it.name}</b>
                  <span className="muted small grow">{it.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
