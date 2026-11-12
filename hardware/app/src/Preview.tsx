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

export type PreviewConnect = { on: boolean; onPort: (schematicPortId: string) => void; highlightIds: string[] }

export default function Preview({ circuitJson, building, connect }: { circuitJson: any[] | null; building: boolean; connect?: PreviewConnect }) {
  const [tab0, setTab] = useState<Tab>(() => {
    try { return (localStorage.getItem("previewTab") as Tab) || "pcb" } catch { return "pcb" }
  })
  const tab: Tab = connect?.on ? "schematic" : tab0 // Connect mode picks pins on the schematic
  const { ref, w, h } = useSize()
  const pick = (t: Tab) => {
    setTab(t)
    try { localStorage.setItem("previewTab", t) } catch {}
  }

  return (
    <div className="preview">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => pick(t.id)}>
            {tab === t.id && <motion.span layoutId="prevtab" className="tab-bg" transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }} />}
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
        <div className="grow" />
        {connect?.on && <span className="small pad-r connect-banner">Connect mode: click pin A, then pin B</span>}
        {building && <span className="muted small pad-r">updating…</span>}
      </div>
      <div className="viewport" ref={ref}>
        {!circuitJson ? (
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
              <ViewerBoundary resetKey={circuitJson}>
                {w > 0 && h > 0 && tab === "schematic" && <SchematicViewer circuitJson={circuitJson as any} containerStyle={{ width: w, height: h }}
                  {...(connect?.on ? { showSchematicPorts: true, onSchematicPortClicked: ({ schematicPortId }: { schematicPortId: string }) => connect.onPort(schematicPortId) } : {})}
                  highlightedSchematicComponentIds={connect?.highlightIds} />}
                {w > 0 && h > 0 && tab === "pcb" && <PcbViewer circuitJson={circuitJson as any} height={h} />}
                {w > 0 && h > 0 && tab === "3d" && (
                  <div style={{ width: w, height: h }}>
                    <CadViewer circuitJson={circuitJson as any} />
                  </div>
                )}
              </ViewerBoundary>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
