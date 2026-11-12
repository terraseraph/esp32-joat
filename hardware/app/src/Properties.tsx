import type { PropValue, SrcComponent } from "./api"
import type { Comp, Model } from "./pcbModel"

const FOOTPRINTS = ["0402", "0603", "0805", "1206", "sot23", "sot23_5", "sot223", "soic8", "soic16", "tssop16", "qfp32", "pinrow2", "pinrow4", "pinrow6", "pinrow8"]
const VALUE_PROP: Record<string, string> = { resistor: "resistance", capacitor: "capacitance", inductor: "inductance", crystal: "frequency" }
const round = (v: number) => Math.round(v * 1000) / 1000

/** Text/number field that commits on blur or Enter, only when the value actually changed. */
function Field({ label, value, onCommit, list, type = "text", step, readOnly, hint }: {
  label: string; value: string | number | undefined; onCommit: (v: string) => void
  list?: string; type?: "text" | "number"; step?: number; readOnly?: boolean; hint?: string
}) {
  const v = value === undefined ? "" : String(value)
  return (
    <label className="pf">
      <span className="small muted">{label}</span>
      <input key={v} className="input" type={type} step={step} defaultValue={v} list={list} readOnly={readOnly} title={hint}
        onBlur={(e) => e.target.value !== v && onCommit(e.target.value)}
        onKeyDown={(e) => {
          const el = e.target as HTMLInputElement
          if (e.key === "Enter") el.blur()
          if (e.key === "Escape") { el.value = v; el.blur() }
        }} />
    </label>
  )
}

export default function Properties({ comp, src, model, netKey, onChange, onClose, onClearNet, onOpenCode }: {
  comp: Comp
  src: SrcComponent | undefined
  model: Model
  netKey: string | null
  onChange: (props: Record<string, PropValue>) => void
  onClose: () => void
  onClearNet: () => void
  onOpenCode: () => void
}) {
  const editable = !!src && !src.inLoop
  const p = src?.props ?? {}
  const valueProp = VALUE_PROP[comp.ftype.replace("simple_", "")] ?? Object.keys(p).find((k) => ["resistance", "capacitance", "inductance", "frequency", "value"].includes(k))
  const dynamic = (k: string) => !!src?.dynamic.includes(k)
  const ro = (k: string) => !editable || dynamic(k)
  const num = (k: string, v: string) => {
    if (v.trim() === "") return onChange({ [k]: null })
    const n = Number(v)
    if (Number.isFinite(n)) onChange({ [k]: n })
  }
  const rotRaw = p.pcbRotation
  const rotation = typeof rotRaw === "number" ? rotRaw : typeof rotRaw === "string" ? parseFloat(rotRaw) || 0 : 0
  const rotNorm = ((rotation % 360) + 360) % 360

  const where = !src
    ? "This part is created by a shared block in lib/ or a loop, so it has no line of its own in the design."
    : src.inLoop ? `This part is created inside a loop (line ${src.line}); edit the loop in the code.` : ""

  return (
    <aside className="props" onPointerDown={(e) => e.stopPropagation()}>
      <div className="row between">
        <strong className="mono">{comp.name}</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
      </div>
      <div className="small muted">{comp.ftype || src?.tag}{src ? ` · line ${src.line}` : ""}</div>
      {where && <div className="note small">{where} <button className="link" onClick={onOpenCode}>Open code</button></div>}

      <Field label="Name" value={comp.name} readOnly={!editable} onCommit={(v) => v.trim() && onChange({ name: v.trim() })} hint="Renaming also updates .NAME selectors in the file" />
      {valueProp && <Field label={valueProp[0].toUpperCase() + valueProp.slice(1)} value={p[valueProp] as any} readOnly={ro(valueProp)} onCommit={(v) => onChange({ [valueProp]: v.trim() === "" ? null : v.trim() })} />}
      <Field label="Footprint" value={p.footprint as any} list="fp-list" readOnly={ro("footprint")} onCommit={(v) => onChange({ footprint: v.trim() === "" ? null : v.trim() })} />
      <datalist id="fp-list">{FOOTPRINTS.map((f) => <option key={f} value={f} />)}</datalist>
      <Field label="LCSC part" value={(p.lcsc as any) ?? ""} readOnly={!editable || dynamic("supplierPartNumbers")} onCommit={(v) => onChange({ lcsc: v.trim() === "" ? null : v.trim() })} />
      <div className="pf2">
        <Field label="X mm" type="number" step={0.5} value={editable ? (p.pcbX as any) : round(comp.x)} readOnly={ro("pcbX")} onCommit={(v) => num("pcbX", v)} />
        <Field label="Y mm" type="number" step={0.5} value={editable ? (p.pcbY as any) : round(comp.y)} readOnly={ro("pcbY")} onCommit={(v) => num("pcbY", v)} />
      </div>
      <div className="pf">
        <span className="small muted">Rotation</span>
        <div className="row">
          <select className="input" disabled={ro("pcbRotation")} value={[0, 90, 180, 270].includes(rotNorm) ? rotNorm : "other"}
            onChange={(e) => onChange({ pcbRotation: Number(e.target.value) })}>
            {[0, 90, 180, 270].map((d) => <option key={d} value={d}>{d}°</option>)}
            <option value="other" disabled>{rotation}°</option>
          </select>
          <button className="btn" disabled={ro("pcbRotation")} onClick={() => onChange({ pcbRotation: (rotNorm + 90) % 360 })} title="Rotate 90° (R)">↻ 90°</button>
        </div>
      </div>
      {!editable && <div className="small muted">On board: {round(comp.x)}, {round(comp.y)} mm · rotation {comp.rotation}°</div>}
      {src && src.dynamic.length > 0 && <div className="small muted">From code (read-only): <span className="mono">{src.dynamic.join(", ")}</span></div>}

      {netKey && (
        <div className="netbox">
          <div className="row between"><strong className="small">Net {model.netName(netKey) ?? ""}</strong><button className="link small" onClick={onClearNet}>clear</button></div>
          <div className="small muted">{model.members(netKey).length} pins</div>
          <div className="chips">{model.members(netKey).slice(0, 40).map((m) => <span key={m} className="chip mono">{m}</span>)}</div>
        </div>
      )}
    </aside>
  )
}
