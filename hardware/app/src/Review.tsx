import { useEffect, useRef, useState } from "react"
import { api, type ChecklistItem, type Rules } from "./api"
import { useToast } from "./toast"

const STATUS: { id: ChecklistItem["status"]; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "ok", label: "OK" },
  { id: "wontfix", label: "Won't fix" },
]

const DEFAULT_RULES: Rules = { minTrace: 0.1, minClearance: 0.1, copperOz: 1, netCurrents: {}, decouplingMaxDistance: 10 }

function RulesForm({ name, initial, baseText, onSaved }: { name: string; initial: Partial<Rules> | undefined; baseText?: string; onSaved: (text: string) => void }) {
  const toast = useToast()
  const [r, setR] = useState<Rules>({ ...DEFAULT_RULES, ...initial, netCurrents: { ...(initial?.netCurrents ?? {}) } })
  const [rows, setRows] = useState<{ net: string; amps: string }[]>(() => Object.entries(initial?.netCurrents ?? {}).map(([net, a]) => ({ net, amps: String(a) })))
  const num = (k: keyof Omit<Rules, "netCurrents">, label: string, unit: string, step = 0.01) => (
    <label className="field">
      <span>{label}</span>
      <span className="field-in">
        <input className="input" type="number" min={0} step={step} value={r[k]} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} />
        <i className="muted">{unit}</i>
      </span>
    </label>
  )
  const save = async () => {
    const netCurrents: Record<string, number> = {}
    for (const row of rows) if (row.net.trim() && Number(row.amps) > 0) netCurrents[row.net.trim()] = Number(row.amps)
    try {
      const res = await api.patchMeta(name, { rules: { ...r, netCurrents }, base: baseText })
      onSaved(res.text)
      toast("ok", "Design rules saved; rebuild to re-check")
    } catch (e: any) { toast("err", e.message) }
  }
  return (
    <div className="rules">
      <div className="rules-grid">
        {num("minTrace", "Min trace width", "mm")}
        {num("minClearance", "Min clearance", "mm")}
        {num("copperOz", "Copper weight", "oz", 0.5)}
        {num("decouplingMaxDistance", "Max decoupling distance", "mm", 0.5)}
      </div>
      <div className="small muted rules-h">High-current nets (trace width is checked against the current: IPC-2221, 10 °C rise)</div>
      {rows.map((row, i) => (
        <div className="net-row" key={i}>
          <input className="input mono" placeholder="Net name, e.g. VLOAD" value={row.net} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, net: e.target.value } : x)))} />
          <input className="input" type="number" min={0} step={0.5} placeholder="A" value={row.amps} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amps: e.target.value } : x)))} />
          <span className="muted">A</span>
          <button className="btn ghost sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div className="rules-actions">
        <button className="btn sm" onClick={() => setRows([...rows, { net: "", amps: "" }])}>Add net</button>
        <button className="btn primary sm" onClick={save}>Save rules</button>
      </div>
    </div>
  )
}

/** Review checklist (board.json `checklist`) plus advanced design rules (board.json `rules`). */
export default function Review({ name, checklist, notes, rules, baseText, onMetaSaved }: {
  name: string
  checklist: ChecklistItem[]
  notes: string
  rules: Partial<Rules> | undefined
  /** the editor board.json text, so unsaved edits there are the patch base and not lost */
  baseText?: string
  onMetaSaved: (text: string) => void
}) {
  const toast = useToast()
  const [items, setItems] = useState<ChecklistItem[]>(checklist)
  const [advanced, setAdvanced] = useState(false)
  const [newText, setNewText] = useState("")
  const baseRef = useRef(baseText)
  baseRef.current = baseText
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => setItems(checklist), [checklist])

  const persist = (next: ChecklistItem[], now = false) => {
    setItems(next)
    clearTimeout(timer.current)
    const go = () => api.patchMeta(name, { checklist: next, base: baseRef.current }).then((r) => onMetaSaved(r.text)).catch((e) => toast("err", `Checklist not saved: ${e.message}`))
    if (now) go(); else timer.current = setTimeout(go, 500) // debounce note typing
  }
  const set = (id: string, p: Partial<ChecklistItem>, now = false) => persist(items.map((i) => (i.id === id ? { ...i, ...p } : i)), now)
  const split = async () => {
    try { const r = await api.patchMeta(name, { splitNotes: true, base: baseRef.current }); onMetaSaved(r.text); setItems(r.meta.checklist ?? []) } catch (e: any) { toast("err", e.message) }
  }
  const add = () => {
    const text = newText.trim()
    if (!text) return
    let n = items.length + 1
    while (items.some((i) => i.id === `c${n}`)) n++
    persist([...items, { id: `c${n}`, text, status: "open", note: "" }], true)
    setNewText("")
  }
  const done = items.filter((i) => i.status !== "open").length
  const canSplit = /\(\d+\)/.test(notes)

  return (
    <div className="review">
      <div className="review-head">
        <b>Review checklist</b>
        {items.length > 0 && <span className="chip">{done}/{items.length} resolved</span>}
        <div className="grow" />
        {canSplit && <button className="btn sm" onClick={split} title="Turn the numbered (1) … (2) … items in the board notes into checklist entries">Split notes into checklist</button>}
        <button className="btn ghost sm" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>{advanced ? "Hide" : "Advanced"}: design rules</button>
      </div>
      {advanced && <RulesForm key={JSON.stringify(rules)} name={name} initial={rules} baseText={baseText} onSaved={onMetaSaved} />}
      {items.length === 0 && <div className="muted small review-empty">No checklist yet. {canSplit ? "Use “Split notes into checklist” to build one from the board notes." : "Add the things to confirm before ordering."}</div>}
      <ul className="checklist">
        {items.map((it) => (
          <li key={it.id} className={`check ${it.status}`}>
            <div className="check-top">
              <span className="check-text">{it.text}</span>
              <span className="seg" role="group" aria-label="Status">
                {STATUS.map((s) => (
                  <button key={s.id} className={it.status === s.id ? "on" : ""} onClick={() => set(it.id, { status: s.id }, true)}>{s.label}</button>
                ))}
              </span>
            </div>
            <input className="input check-note" placeholder="Note (optional)" value={it.note} onChange={(e) => set(it.id, { note: e.target.value })} />
          </li>
        ))}
      </ul>
      <div className="check-add">
        <input className="input" placeholder="Add an item…" value={newText} onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn sm" onClick={add} disabled={!newText.trim()}>Add</button>
      </div>
    </div>
  )
}
