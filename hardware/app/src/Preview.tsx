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
import { SchematicViewer, PcbViewer, CadViewer, usePcbViewerController } from "@tscircuit/runframe/preview"
import type { Where } from "./api"

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

export type PreviewFocus = { where: Where; nonce: number }

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

/** Pan/zoom the pcb-viewer so `where` sits in the middle of the viewport. The viewer exposes no camera API, so we read its
 *  current transform from the focus-outline overlay of a known component, then drive it with synthetic drag + wheel events. */
async function zoomPcbTo(host: HTMLElement, where: Where, circuit: any[], focusPcb: (id: string) => void) {
  const comps = circuit.filter((e) => e.type === "pcb_component" && e.width > 0 && e.height > 0)
  const ref = comps.find((c) => c.pcb_component_id === where.pcbComponentId) ?? comps.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  if (!ref) return
  focusPcb(ref.pcb_component_id)
  // the viewer may animate/refit after a focus request, so wait until the outline holds still
  let rect: DOMRect | null = null
  let still = 0
  for (let i = 0; i < 90 && still < 5; i++) {
    await nextFrame()
    const r = host.querySelector("[data-focused-pcb-component-id]")?.getBoundingClientRect() ?? null
    still = r && rect && Math.abs(r.left - rect.left) < 0.5 && Math.abs(r.width - rect.width) < 0.5 && Math.abs(r.top - rect.top) < 0.5 ? still + 1 : 0
    rect = r
  }
  focusPcb("__none__") // drop the outline; the highlight is drawn separately
  await new Promise((r) => setTimeout(r, 250)) // the viewer ignores drags for ~100 ms after cancelling its focus animation
  const canvas = host.querySelector("canvas")
  if (!rect || !canvas) return
  const S = (rect.width - 8) / ref.width
  const hostBox = host.getBoundingClientRect()
  const sx = rect.left + rect.width / 2 + (where.x - ref.center.x) * S
  const sy = rect.top + rect.height / 2 - (where.y - ref.center.y) * S // pcb y is up
  const cx = hostBox.left + hostBox.width / 2, cy = hostBox.top + hostBox.height / 2
  const target = document.elementFromPoint(cx, cy) ?? canvas
  const ev = (type: string, x: number, y: number) => new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 })
  target.dispatchEvent(ev("mousedown", sx, sy))
  window.dispatchEvent(ev("mousemove", cx, cy))
  target.dispatchEvent(ev("mouseup", cx, cy))
  await nextFrame()
  const want = Math.min((hostBox.width * 0.4) / Math.max(where.w, 4), (hostBox.height * 0.4) / Math.max(where.h, 4))
  const f = Math.min(Math.max(want / S, 0.2), 30)
  target.dispatchEvent(new WheelEvent("wheel", { clientX: cx, clientY: cy, deltaY: (1 - f) * 1000, bubbles: true, cancelable: true }))
}

export default function Preview({ circuitJson, building, focus }: { circuitJson: any[] | null; building: boolean; focus?: PreviewFocus | null }) {
  const { controller, focusPcbComponent } = usePcbViewerController()
  const [highlight, setHighlight] = useState<Where | null>(null)
  const [tab, setTab] = useState<Tab>(() => {
    try { return (localStorage.getItem("previewTab") as Tab) || "pcb" } catch { return "pcb" }
  })
  const { ref, w, h } = useSize()
  const handled = useRef(0)
  useEffect(() => {
    if (!focus || focus.nonce === handled.current || !circuitJson) return
    handled.current = focus.nonce
    const want: Tab = focus.where.view
    setTab(want)
    setHighlight(focus.where)
    if (want !== "pcb") return
    const run = async () => {
      for (let i = 0; i < 30 && !ref.current?.querySelector("canvas"); i++) await nextFrame() // viewer may be mounting after a tab switch
      await new Promise((r) => setTimeout(r, 150))
      if (ref.current) await zoomPcbTo(ref.current, focus.where, circuitJson, focusPcbComponent)
    }
    run().catch(() => {})
  }, [focus, circuitJson, focusPcbComponent, ref])
  useEffect(() => setHighlight(null), [circuitJson]) // a rebuild moves things; drop the stale marker
  // marker for the offending spot: an extra silkscreen rectangle in the circuit handed to the viewer
  const pcbCircuit = useMemo(() => {
    if (!circuitJson || !highlight || highlight.view !== "pcb") return circuitJson
    const w = Math.max(highlight.w, 1.5) + 0.8, h = Math.max(highlight.h, 1.5) + 0.8
    return [...circuitJson, { type: "pcb_silkscreen_rect", pcb_silkscreen_rect_id: "hw_issue_marker", pcb_component_id: "hw_issue_marker", layer: "top", center: { x: highlight.x, y: highlight.y }, width: w, height: h, stroke_width: Math.max(0.2, Math.min(w, h) * 0.08), is_filled: false, has_stroke: true }]
  }, [circuitJson, highlight])
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
                {w > 0 && h > 0 && tab === "schematic" && <SchematicViewer circuitJson={circuitJson as any} containerStyle={{ width: w, height: h }} />}
                {w > 0 && h > 0 && tab === "pcb" && <PcbViewer circuitJson={pcbCircuit as any} height={h} controller={controller as any} />}
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
