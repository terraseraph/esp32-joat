import { useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { api, type NewDesignOptions } from "./api"
import { useToast } from "./toast"

const TEMPLATES = [
  { id: "blank", label: "Blank", blurb: "Empty board, one resistor.", size: [50, 40], layers: 2 },
  { id: "expansion", label: "Expansion card", blurb: "1×6 header + ID EEPROM (like relay-8).", size: [60, 40], layers: 2 },
  { id: "base", label: "Base controller", blurb: "ESP32-S3 module + 3.3 V power.", size: [80, 60], layers: 4 },
] as const
const SIZES = [[50, 40], [60, 40], [80, 60], [100, 84], [120, 90]] as const

export const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "")

export default function NewDesignWizard({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (o: boolean) => void; existing: string[] }) {
  const toast = useToast()
  const [name, setName] = useState("")
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"]>("blank")
  const [size, setSize] = useState<[number, number]>([50, 40])
  const [custom, setCustom] = useState(false)
  const [layers, setLayers] = useState<2 | 4>(2)
  const [holes, setHoles] = useState<"none" | "m3-corners">("none")
  const [desc, setDesc] = useState("")
  const [busy, setBusy] = useState(false)
  const slug = slugify(name)
  const clash = !!slug && existing.includes(slug)
  const sizeOk = size[0] >= 10 && size[0] <= 400 && size[1] >= 10 && size[1] <= 400

  const pickTemplate = (t: (typeof TEMPLATES)[number]) => {
    setTemplate(t.id)
    setSize([t.size[0], t.size[1]])
    setCustom(false)
    setLayers(t.layers)
  }

  const create = async () => {
    if (!slug || clash || !sizeOk || busy) return
    setBusy(true)
    const o: NewDesignOptions = { name: slug, template, width: size[0], height: size[1], layers, holes, description: desc }
    try {
      await api.createDesign(o)
      onOpenChange(false)
      location.hash = `#/design/${encodeURIComponent(slug)}`
    } catch (e: any) {
      toast("err", e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal wizard" aria-describedby={undefined}>
          <Dialog.Title className="modal-title">New design</Dialog.Title>
          <form onSubmit={(e) => { e.preventDefault(); create() }}>
            <label className="field-label">Name</label>
            <input autoFocus className="input wide" placeholder="my-board" value={name} onChange={(e) => setName(e.target.value)} />
            {clash && <div className="small bad-text">"{slug}" already exists</div>}
            {name && slug !== name && !clash && <div className="small muted">Will be saved as <span className="mono">{slug}</span></div>}

            <label className="field-label">Template</label>
            <div className="choice-grid">
              {TEMPLATES.map((t) => (
                <button type="button" key={t.id} className={`choice ${template === t.id ? "on" : ""}`} onClick={() => pickTemplate(t)}>
                  <b>{t.label}</b><span>{t.blurb}</span>
                </button>
              ))}
            </div>

            <label className="field-label">Board size (mm)</label>
            <div className="seg">
              {SIZES.map(([w, h]) => (
                <button type="button" key={w + "x" + h} className={!custom && size[0] === w && size[1] === h ? "on" : ""} onClick={() => { setSize([w, h]); setCustom(false) }}>{w}×{h}</button>
              ))}
              <button type="button" className={custom ? "on" : ""} onClick={() => setCustom(true)}>Custom</button>
            </div>
            {custom && (
              <div className="row" style={{ marginTop: 8 }}>
                <input className="input" type="number" min={10} max={400} style={{ width: 80 }} value={size[0]} onChange={(e) => setSize([+e.target.value, size[1]])} aria-label="Width mm" />
                <span className="muted">×</span>
                <input className="input" type="number" min={10} max={400} style={{ width: 80 }} value={size[1]} onChange={(e) => setSize([size[0], +e.target.value])} aria-label="Height mm" />
                <span className="muted small">mm</span>
              </div>
            )}

            <div className="two-col">
              <div>
                <label className="field-label">Layers</label>
                <div className="seg">
                  {([2, 4] as const).map((n) => <button type="button" key={n} className={layers === n ? "on" : ""} onClick={() => setLayers(n)}>{n}</button>)}
                </div>
              </div>
              <div>
                <label className="field-label">Mounting holes</label>
                <div className="seg">
                  <button type="button" className={holes === "none" ? "on" : ""} onClick={() => setHoles("none")}>None</button>
                  <button type="button" className={holes === "m3-corners" ? "on" : ""} onClick={() => setHoles("m3-corners")}>4× M3 corners</button>
                </div>
              </div>
            </div>

            <label className="field-label">Description <span className="muted">(optional)</span></label>
            <input className="input wide" value={desc} onChange={(e) => setDesc(e.target.value)} />

            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => onOpenChange(false)}>Cancel</button>
              <button type="submit" className="btn primary" disabled={!slug || clash || !sizeOk || busy}>{busy ? "Creating…" : "Create"}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
