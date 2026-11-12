import { Component, useEffect, useRef, useState, type ReactNode } from "react"

/** Keeps a crashing tscircuit viewer from unmounting the whole app; resets when a new circuit arrives. */
class ViewerBoundary extends Component<{ resetKey: unknown; children: ReactNode }, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  static getDerivedStateFromProps(p: { resetKey: unknown }, s: { key: unknown }) {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null
  }
  render() {
    if (this.state.error) return <div className="empty">Viewer crashed: {this.state.error.message}</div>
    return this.props.children
  }
}
import { AnimatePresence, motion } from "motion/react"
import { SchematicViewer, PcbViewer, CadViewer } from "@tscircuit/runframe/preview"

type Tab = "schematic" | "pcb" | "3d"
const TABS: { id: Tab; label: string }[] = [
  { id: "schematic", label: "Schematic" },
  { id: "pcb", label: "PCB" },
  { id: "3d", label: "3D" },
]

function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, ...size }
}

type Layer = { id: number; cj: any[] }
let layerSeq = 0

export default function Preview({ circuitJson, building }: { circuitJson: any[] | null; building: boolean }) {
  const [tab, setTab] = useState<Tab>(() => {
    try { return (localStorage.getItem("previewTab") as Tab) || "pcb" } catch { return "pcb" }
  })
  const { ref, w, h } = useSize()
  const pick = (t: Tab) => {
    setTab(t)
    try { localStorage.setItem("previewTab", t) } catch {}
  }
  useEffect(() => {
    const on = (e: Event) => pick((e as CustomEvent<Tab>).detail)
    addEventListener("hw-preview-tab", on)
    return () => removeEventListener("hw-preview-tab", on)
  }, [])

  // Rebuilds mount the new viewer underneath/over the old one and fade it in once it has had
  // time to render; the previous layer stays visible until then, so the preview never blanks.
  const [layers, setLayers] = useState<Layer[]>([])
  const [ready, setReady] = useState<number | null>(null)
  useEffect(() => {
    if (!circuitJson) return
    const id = ++layerSeq
    setLayers((l) => (l.length && l[l.length - 1].cj === circuitJson ? l : [...l, { id, cj: circuitJson }]))
    const first = layers.length === 0
    const t = setTimeout(() => setReady(id), first ? 0 : 450)
    return () => clearTimeout(t)
  }, [circuitJson])
  const done = (id: number) => setLayers((l) => (l.length > 1 && l[l.length - 1].id === id ? [l[l.length - 1]] : l))

  const viewer = (cj: any[]) => (
    <ViewerBoundary resetKey={cj}>
      {w > 0 && h > 0 && tab === "schematic" && <SchematicViewer circuitJson={cj as any} containerStyle={{ width: w, height: h }} />}
      {w > 0 && h > 0 && tab === "pcb" && <PcbViewer circuitJson={cj as any} height={h} />}
      {w > 0 && h > 0 && tab === "3d" && (
        <div style={{ width: w, height: h }}>
          <CadViewer circuitJson={cj as any} />
        </div>
      )}
    </ViewerBoundary>
  )

  return (
    <div className="preview">
      <div className="tabs">
        {TABS.map((t, i) => (
          <button key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => pick(t.id)} title={`${t.label} (${i + 1})`}>
            {tab === t.id && <motion.span layoutId="prevtab" className="tab-bg" transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }} />}
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
        <div className="grow" />
        {building && <span className="muted small pad-r">updating…</span>}
      </div>
      <div className="viewport" ref={ref}>
        {!layers.length ? (
          <div className="empty">{building ? "Building first preview…" : "No successful build yet"}</div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={tab}
              className="viewer"
              style={{ width: w, height: h }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              transition={{ duration: 0.15 }}
            >
              {layers.map((l, i) => {
                const top = i === layers.length - 1
                const show = !top || layers.length === 1 || ready === l.id
                return (
                  <motion.div
                    key={l.id}
                    className="viewer-layer"
                    initial={false}
                    animate={{ opacity: show ? 1 : 0 }}
                    transition={{ duration: 0.25 }}
                    onAnimationComplete={() => show && done(l.id)}
                  >
                    {viewer(l.cj)}
                  </motion.div>
                )
              })}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
