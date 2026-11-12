import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

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
import PcbEdit, { type PcbPick } from "./PcbEdit"
import type { Model } from "./pcbModel"

// The WebGPU PCB renderer throws on element types it cannot draw; they still show in Problems.
const PCB_UNDRAWABLE = new Set(["pcb_courtyard_overlap_error"])
const pcbSafe = (cj: any[]) => (cj.some((e) => PCB_UNDRAWABLE.has(e?.type)) ? cj.filter((e) => !PCB_UNDRAWABLE.has(e?.type)) : cj)

/** Selection/editing bridge from Workspace: the interactive PCB view and schematic highlighting use it. */
export type Canvas = {
  model: Model; fitKey: string; selected: string | null; netKey: string | null
  editable: (name: string) => boolean; snap: number; setSnap: (s: number) => void
  onPick: (p: PcbPick) => void; onMove: (n: string, dx: number, dy: number) => void; onRotate: (n: string, d: number) => void
}

type Tab = "schematic" | "pcb" | "pcbview" | "3d"
import type { Where } from "./api"

const TABS: { id: Tab; label: string }[] = [
  { id: "schematic", label: "Schematic" },
  { id: "pcb", label: "PCB" },
  { id: "pcbview", label: "PCB (viewer)" },
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
/** A spot to show: from clicking a Problems entry. */
export type PreviewFocus = { where: Where; nonce: number }

export default function Preview({ circuitJson, building, canvas, overlay, connect, focus, highlight }: { circuitJson: any[] | null; building: boolean; canvas?: Canvas; overlay?: ReactNode; connect?: PreviewConnect; focus?: PreviewFocus | null; highlight?: { x: number; y: number; w: number; h: number }[] | null }) {
  const [tab, setTab] = useState<Tab>(() => {
    try { return (localStorage.getItem("previewTab") as Tab) || "pcb" } catch { return "pcb" }
  })
  const { ref, w, h } = useSize()
  const pcbJson = useMemo(() => (circuitJson ? pcbSafe(circuitJson) : null), [circuitJson])
  // a Problems click switches to the view the issue lives in; the interactive PCB view pans/zooms to it
  const handled = useRef(0)
  useEffect(() => {
    if (!focus || focus.nonce === handled.current) return
    handled.current = focus.nonce
    setTab(focus.where.view === "pcb" ? "pcb" : "schematic")
  }, [focus])
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
        {connect?.on && <span className="small pad-r connect-banner">Connect mode: click pin A, then pin B (PCB pads, or schematic pins after a Route build)</span>}
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
                {w > 0 && h > 0 && tab === "schematic" && (
                  <div style={{ width: w, height: h }} onClickCapture={(e) => {
                    if (connect?.on) return
                    const t = (e.target as Element).closest?.("[data-schematic-trace-id]")
                    const tr = t && circuitJson.find((x) => x.type === "schematic_trace" && x.schematic_trace_id === t.getAttribute("data-schematic-trace-id"))
                    if (tr?.subcircuit_connectivity_map_key) canvas?.onPick({ key: tr.subcircuit_connectivity_map_key })
                  }}>
                    <SchematicViewer circuitJson={circuitJson as any} containerStyle={{ width: w, height: h }}
                      {...(connect?.on ? { showSchematicPorts: true, onSchematicPortClicked: ({ schematicPortId }: { schematicPortId: string }) => connect.onPort(schematicPortId) } : {})}
                      css={canvas?.netKey ? `${canvas.model.schTraceIds(canvas.netKey).map((id) => `[data-schematic-trace-id="${id}"]`).join(",")}{stroke:#ffb400 !important;stroke-width:3px !important}` : undefined}
                      highlightedSchematicComponentIds={connect?.highlightIds?.length ? connect.highlightIds : canvas?.selected ? [...canvas.model.compBySchId].filter(([, c]) => c.name === canvas.selected).map(([id]) => id) : undefined}
                      onSchematicComponentClicked={canvas && !connect?.on ? ({ schematicComponentId }) => canvas.onPick({ comp: canvas.model.compBySchId.get(schematicComponentId)?.name ?? null }) : undefined} />
                  </div>
                )}
                {w > 0 && h > 0 && tab === "pcb" && (canvas ? <PcbEdit {...canvas} stale={building} focus={focus?.where.view === "pcb" ? { ...focus.where, nonce: focus.nonce } : null} marks={highlight ?? null} /> : <PcbViewer circuitJson={pcbJson as any} height={h} />)}
                {w > 0 && h > 0 && tab === "pcbview" && <PcbViewer circuitJson={pcbJson as any} height={h} />}
                {w > 0 && h > 0 && tab === "3d" && (
                  <div style={{ width: w, height: h }}>
                    <CadViewer circuitJson={circuitJson as any} />
                  </div>
                )}
              </ViewerBoundary>
            </motion.div>
          </AnimatePresence>
        )}
        {overlay}
      </div>
    </div>
  )
}
