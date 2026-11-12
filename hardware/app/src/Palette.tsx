import { useEffect, useMemo, useRef, useState } from "react"
import { api, type PaletteItem, type PartHit, type PropSpec } from "./api"
import { useToast } from "./toast"

export const PALETTE_MIME = "application/x-joat-part"

type Values = Record<string, string>

function initialValues(item: PaletteItem): Values {
  const v: Values = {}
  for (const p of item.props) if (p.default !== undefined && p.name !== "pcbX" && p.name !== "pcbY") v[p.name] = String(p.default)
  return v
}

function Field({ spec, value, onChange, list }: { spec: PropSpec; value: string; onChange: (v: string) => void; list?: string }) {
  const label = (
    <span className="pf-label" title={spec.doc}>
      {spec.name}
      {spec.required && <span className="pf-req">*</span>}
    </span>
  )
  if (spec.type === "boolean")
    return (
      <label className="pf-row">
        {label}
        <input type="checkbox" checked={value === "true"} onChange={(e) => onChange(String(e.target.checked))} />
      </label>
    )
  if (spec.type === "select")
    return (
      <label className="pf-row">
        {label}
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {!spec.required && <option value="" />}
          {spec.options!.map((o) => <option key={o}>{o}</option>)}
        </select>
      </label>
    )
  return (
    <label className="pf-row">
      {label}
      <input
        value={value ?? ""}
        list={list}
        inputMode={spec.type === "number" ? "decimal" : undefined}
        placeholder={spec.name === "name" ? "auto" : spec.name.startsWith("pcb") ? "centre" : spec.type === "raw" ? "JS expression" : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function PartSearch({ onPick }: { onPick: (p: PartHit) => void }) {
  const [q, setQ] = useState("")
  const [hits, setHits] = useState<PartHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); setErr(null); return }
    const id = ++seq.current
    const t = setTimeout(() => {
      setBusy(true)
      api.searchParts(q.trim())
        .then((h) => { if (id === seq.current) { setHits(h); setErr(null) } })
        .catch((e) => { if (id === seq.current) setErr(e.message) })
        .finally(() => { if (id === seq.current) setBusy(false) })
    }, 450)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="psearch">
      <input className="pal-search" placeholder="Search JLC parts (e.g. 100nF 0603, ESP32, AO3400)" value={q} onChange={(e) => setQ(e.target.value)} />
      {busy && <div className="muted small pad-s">Searching…</div>}
      {err && <div className="pf-err">{err}</div>}
      {hits && !hits.length && !busy && <div className="muted small pad-s">No parts found.</div>}
      {hits && hits.length > 0 && (
        <ul className="hits">
          {hits.map((h) => (
            <li key={h.lcsc}>
              <button className="hit" onClick={() => onPick(h)} title={h.description}>
                <span className="hit-top">
                  <b>{h.lcsc}</b>
                  <span className={`tier ${h.tier}`}>{h.tier}</span>
                  <span className="grow" />
                  <span className="muted">{h.price !== null ? `$${h.price.toFixed(4)}` : "–"}</span>
                </span>
                <span className="hit-mid">{h.mfr}</span>
                <span className="hit-bot muted">{h.package} · {h.stock === null ? "stock ?" : `${h.stock.toLocaleString()} in stock`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function InsertForm({ item, name, getSource, knownNames, onInsert, onBack, initialPart }: {
  item: PaletteItem
  name: string
  getSource: () => string
  knownNames: string[]
  onInsert: (source: string, newName: string | null) => void
  onBack: () => void
  initialPart?: PartHit
}) {
  const toast = useToast()
  const [values, setValues] = useState<Values>(() => ({ ...initialValues(item) }))
  const [adv, setAdv] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }))
  const takesPart = item.props.some((p) => p.name === "lcsc")

  const applyPart = (p: PartHit) => {
    setValues((s) => {
      const n: Values = { ...s, lcsc: p.lcsc }
      if (item.props.some((x) => x.name === "footprint")) {
        // chips (and any part whose package is not a plain standard size) take the footprint JLCPCB has for that part
        n.footprint = item.tag !== "chip" && p.footprint ? p.footprint : `jlcpcb:${p.lcsc}`
      }
      if (item.props.some((x) => x.name === "manufacturerPartNumber")) n.manufacturerPartNumber = p.mfr
      return n
    })
  }
  const started = useRef(false)
  useEffect(() => {
    if (initialPart && !started.current) { started.current = true; applyPart(initialPart) }
  })

  const main = item.props.filter((p) => !p.advanced)
  const more = item.props.filter((p) => p.advanced)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const props: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) if (v !== "") props[k] = v
      // if the editor text changed while the request was in flight, redo the insert on the current text
      let src = getSource()
      let r = await api.insertComponent(name, item.id, props, src, knownNames)
      if (getSource() !== src) {
        src = getSource()
        r = await api.insertComponent(name, item.id, props, src, knownNames)
      }
      onInsert(r.source, r.name)
      toast("ok", r.name ? `Added ${r.name}` : `Added ${item.label}`)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="insert">
      <button className="link-btn" onClick={onBack}>← Palette</button>
      <h3>{item.label}</h3>
      {item.description && <p className="muted small desc">{item.description}</p>}
      {takesPart && <PartSearch onPick={applyPart} />}
      {item.tag === "chip" && !values.footprint && <div className="pf-err">Unknown package: pick a JLC part above (its LCSC number sets the footprint) or type a footprint.</div>}
      {values.lcsc && <div className="chosen">LCSC <b>{values.lcsc}</b> <button className="link-btn" onClick={() => set("lcsc", "")}>clear</button></div>}
      <div className="pf">
        {main.map((p) => (
          <Field key={p.name} spec={p} value={values[p.name] ?? ""} onChange={(v) => set(p.name, v)} list={p.options && p.type === "string" ? `dl-${p.name}` : undefined} />
        ))}
        {main.filter((p) => p.options && p.type === "string").map((p) => (
          <datalist key={p.name} id={`dl-${p.name}`}>{p.options!.map((o) => <option key={o} value={o} />)}</datalist>
        ))}
      </div>
      {(more.length > 0 || takesPart) && (
        <>
          <button className="link-btn" onClick={() => setAdv((a) => !a)}>{adv ? "▾" : "▸"} Advanced</button>
          {adv && (
            <div className="pf">
              {takesPart && <Field spec={{ name: "lcsc", type: "string", required: false, doc: "C-number" }} value={values.lcsc ?? ""} onChange={(v) => set("lcsc", v)} />}
              {more.map((p) => <Field key={p.name} spec={p} value={values[p.name] ?? ""} onChange={(v) => set(p.name, v)} />)}
            </div>
          )}
        </>
      )}
      <p className="muted small">Position left blank = near the board centre; set pcbX / pcbY (mm) to place it exactly.</p>
      {err && <div className="pf-err">{err}</div>}
      <div className="pf-actions">
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add to board"}</button>
        <button className="btn" onClick={onBack}>Cancel</button>
      </div>
    </div>
  )
}

/** Left sidebar: library blocks + primitives; click or drag an item to open its insert form. */
/** A searched part: choose how to use it (chip, resistor, capacitor, LED) from its description. */
function PartFirst({ all, open }: { all: PaletteItem[]; open: (i: PaletteItem, p?: PartHit) => void }) {
  return (
    <div className="pal-section">
      <PartSearch onPick={(p) => {
        const c = /\bcapacitors?\b/i.test(p.description) ? "prim:capacitor" : /\bresistors?\b/i.test(p.description) ? "prim:resistor" : /\bLEDs?\b|light emitting diode/i.test(p.description) ? "prim:led" : "prim:chip"
        const it = all.find((i) => i.id === c)
        if (it) open(it, p)
      }} />
      <p className="muted small pad-s">Pick a result to insert it as a chip, resistor, capacitor or LED with its LCSC number filled in.</p>
    </div>
  )
}

export default function Palette({ name, getSource, knownNames, onInsert, dropId }: {
  name: string
  getSource: () => string
  /** component names in the last build (covers generated and lib-internal names) */
  knownNames: string[]
  onInsert: (source: string) => void
  /** set by Workspace when an item is dropped on the preview */
  dropId: { id: string; n: number } | null
}) {
  const [palette, setPalette] = useState<{ lib: PaletteItem[]; primitives: PaletteItem[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [item, setItem] = useState<PaletteItem | null>(null)
  const [part, setPart] = useState<PartHit | undefined>()
  const [q, setQ] = useState("")
  const [mode, setMode] = useState<"items" | "parts">("items")

  useEffect(() => { api.palette().then(setPalette).catch((e) => setErr(e.message)) }, [])
  const all = useMemo(() => (palette ? [...palette.primitives, ...palette.lib] : []), [palette])
  useEffect(() => {
    if (dropId) { const it = all.find((i) => i.id === dropId.id); if (it) { setPart(undefined); setItem(it) } }
  }, [dropId, all])

  const filt = (xs: PaletteItem[]) => xs.filter((i) => !q || (i.label + " " + i.description).toLowerCase().includes(q.toLowerCase()))
  const open = (i: PaletteItem, p?: PartHit) => { setPart(p); setItem(i) }

  return (
    <aside className="palette" aria-label="Parts palette">
      {item ? (
        <InsertForm key={item.id + (part?.lcsc ?? "")} item={item} name={name} getSource={getSource} knownNames={knownNames} initialPart={part} onBack={() => setItem(null)} onInsert={(src) => { onInsert(src); setItem(null) }} />
      ) : (
        <>
          <div className="pal-head">
            <div className="pal-tabs">
              <button className={mode === "items" ? "on" : ""} onClick={() => setMode("items")}>Parts</button>
              <button className={mode === "parts" ? "on" : ""} onClick={() => setMode("parts")}>JLC search</button>
            </div>
            {mode === "items" && <input className="pal-search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}
          </div>
          {err && <div className="pf-err">{err}</div>}
          {!palette && !err && <div className="muted small pad-s">Loading…</div>}
          {mode === "parts" ? <PartFirst all={all} open={open} /> : palette && (
            <div className="pal-list">
              {([["Primitives", filt(palette.primitives)], ["Shared blocks (lib/)", filt(palette.lib)]] as const).map(([title, xs]) =>
                xs.length ? (
                  <div key={title} className="pal-section">
                    <div className="pal-title">{title}</div>
                    {xs.map((i) => (
                      <button
                        key={i.id}
                        className="pal-item"
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData(PALETTE_MIME, i.id); e.dataTransfer.effectAllowed = "copy" }}
                        onClick={() => open(i)}
                        title={i.description}
                      >
                        <span className="pal-name">{i.label}</span>
                        <span className="pal-desc">{i.description || i.tag}</span>
                      </button>
                    ))}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </>
      )}
    </aside>
  )
}
