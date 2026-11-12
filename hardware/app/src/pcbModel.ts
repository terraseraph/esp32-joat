/** Turns tscircuit circuit JSON into the small model the interactive PCB view and properties panel use. */

export type Pad = {
  id: string
  comp?: string // pcb_component_id
  key?: string // connectivity key (same key = same net)
  kind: "rect" | "circle" | "pill"
  x: number; y: number; w: number; h: number
  rot: number // degrees ccw
  hole?: number // drill diameter
  layer: "top" | "bottom" | "both"
  label?: string // port name, e.g. "SDA"
}
export type Comp = {
  id: string; srcId: string; name: string; ftype: string
  x: number; y: number // footprint origin
  cx: number; cy: number; w: number; h: number // bounding box centre/size
  rotation: number
  layer: string
}
export type Model = {
  board: { cx: number; cy: number; w: number; h: number }
  comps: Comp[]
  pads: Pad[]
  traces: { id: string; key?: string; layer: string; width: number; pts: { x: number; y: number }[] }[]
  vias: { id: string; key?: string; x: number; y: number; d: number; hole: number }[]
  holes: { x: number; y: number; d: number }[]
  silk: { id: string; comp?: string; x: number; y: number; size: number; text: string; rot: number }[]
  outlines: { comp?: string; pts: { x: number; y: number }[]; layer: string }[]
  netName: (key: string) => string | undefined
  /** "U1.SDA"-style list of pins on a net. */
  members: (key: string) => string[]
  schTraceIds: (key: string) => string[]
  compByName: Map<string, Comp>
  /** Names used by more than one source component; edits by name would be ambiguous. */
  dupNames: Set<string>
  compByPcbId: Map<string, Comp>
  compBySchId: Map<string, Comp>
}

const num = (v: any, d = 0) => (typeof v === "number" && isFinite(v) ? v : d)

export function buildModel(cj: any[]): Model {
  const srcComp = new Map<string, any>()
  const srcPort = new Map<string, any>()
  const pcbPort = new Map<string, any>()
  const keyNames = new Map<string, string>()
  for (const e of cj) {
    if (e.type === "source_component") srcComp.set(e.source_component_id, e)
    else if (e.type === "source_port") srcPort.set(e.source_port_id, e)
    else if (e.type === "pcb_port") pcbPort.set(e.pcb_port_id, e)
    else if (e.type === "source_net" && e.subcircuit_connectivity_map_key && !keyNames.has(e.subcircuit_connectivity_map_key)) keyNames.set(e.subcircuit_connectivity_map_key, e.name)
  }
  const keyOfPort = (pcbPortId?: string): { key?: string; label?: string } => {
    const pp = pcbPort.get(pcbPortId ?? "")
    const sp = pp && srcPort.get(pp.source_port_id)
    return { key: sp?.subcircuit_connectivity_map_key, label: sp?.name }
  }

  const comps: Comp[] = []
  const compByName = new Map<string, Comp>()
  const compByPcbId = new Map<string, Comp>()
  const compBySchId = new Map<string, Comp>()
  const dupNames = new Set<string>()
  for (const e of cj) {
    if (e.type !== "pcb_component") continue
    const sc = srcComp.get(e.source_component_id)
    const c: Comp = {
      id: e.pcb_component_id, srcId: e.source_component_id, name: sc?.name ?? e.pcb_component_id, ftype: sc?.ftype ?? "",
      x: num(e.footprint_origin?.x, num(e.center?.x)), y: num(e.footprint_origin?.y, num(e.center?.y)),
      cx: num(e.center?.x), cy: num(e.center?.y), w: num(e.width), h: num(e.height),
      rotation: num(e.rotation), layer: e.layer ?? "top",
    }
    comps.push(c)
    if (compByName.has(c.name)) dupNames.add(c.name)
    compByName.set(c.name, c)
    compByPcbId.set(c.id, c)
  }
  for (const e of cj) if (e.type === "schematic_component") {
    const c = comps.find((k) => k.srcId === e.source_component_id)
    if (c) compBySchId.set(e.schematic_component_id, c)
  }

  const pads: Pad[] = []
  for (const e of cj) {
    if (e.type === "pcb_smtpad") {
      const { key, label } = keyOfPort(e.pcb_port_id)
      const layer = e.layer === "bottom" ? "bottom" : "top"
      if (e.shape === "circle") pads.push({ id: e.pcb_smtpad_id, comp: e.pcb_component_id, key, label, kind: "circle", x: e.x, y: e.y, w: e.radius * 2, h: e.radius * 2, rot: 0, layer })
      else pads.push({ id: e.pcb_smtpad_id, comp: e.pcb_component_id, key, label, kind: e.shape === "pill" || e.shape === "rotated_pill" ? "pill" : "rect", x: e.x, y: e.y, w: num(e.width), h: num(e.height), rot: num(e.ccw_rotation), layer })
    } else if (e.type === "pcb_plated_hole") {
      const { key, label } = keyOfPort(e.pcb_port_id)
      const hole = num(e.hole_diameter, num(e.hole_width, 0.8))
      const base = { id: e.pcb_plated_hole_id, comp: e.pcb_component_id, key, label, x: e.x, y: e.y, hole, layer: "both" as const }
      if (e.shape === "circle") pads.push({ ...base, kind: "circle", w: num(e.outer_diameter), h: num(e.outer_diameter), rot: 0 })
      else if (e.shape === "circular_hole_with_rect_pad") pads.push({ ...base, kind: "rect", w: num(e.rect_pad_width), h: num(e.rect_pad_height), rot: num(e.rect_ccw_rotation) })
      else if (e.shape === "pill" || e.shape === "oval") pads.push({ ...base, kind: "pill", w: num(e.outer_width), h: num(e.outer_height), rot: num(e.ccw_rotation) })
      else pads.push({ ...base, kind: "circle", w: num(e.outer_diameter, hole * 1.8), h: num(e.outer_diameter, hole * 1.8), rot: 0 })
    }
  }

  const traces: Model["traces"] = []
  const vias: Model["vias"] = []
  for (const e of cj) {
    if (e.type === "pcb_trace") {
      // a trace's net is the net of any pad it connects to
      const key = (e.connectsTo as string[] | undefined)?.map((p) => keyOfPort(p).key).find(Boolean)
      let seg: any = null
      for (const p of e.route ?? []) {
        if (p.route_type === "wire") {
          if (!seg || seg.layer !== p.layer) {
            seg = { id: `${e.pcb_trace_id}:${traces.length}`, key, layer: p.layer, width: num(p.width, 0.15), pts: [] }
            traces.push(seg)
          }
          seg.pts.push({ x: p.x, y: p.y })
        } else seg = null
      }
    } else if (e.type === "pcb_via") {
      vias.push({ id: e.pcb_via_id, key: undefined, x: e.x, y: e.y, d: num(e.outer_diameter, 0.6), hole: num(e.hole_diameter, 0.3) })
    }
  }
  // vias get their net from the trace they sit on
  for (const v of vias) {
    const tr = cj.find((e) => e.type === "pcb_via" && e.pcb_via_id === v.id)?.pcb_trace_id
    v.key = traces.find((t) => t.id.startsWith(`${tr}:`))?.key
  }

  const holes = cj.filter((e) => e.type === "pcb_hole").map((e) => ({ x: e.x, y: e.y, d: num(e.hole_diameter, num(e.hole_width, 1)) }))
  const silk = cj
    .filter((e) => e.type === "pcb_silkscreen_text" && e.layer !== "bottom")
    .map((e) => ({ id: e.pcb_silkscreen_text_id, comp: e.pcb_component_id, x: e.anchor_position.x, y: e.anchor_position.y, size: num(e.font_size, 0.5), text: String(e.text), rot: num(e.ccw_rotation) }))
  const outlines = cj
    .filter((e) => e.type === "pcb_silkscreen_path" && Array.isArray(e.route) && e.layer !== "bottom")
    .map((e) => ({ comp: e.pcb_component_id, layer: e.layer, pts: e.route.map((p: any) => ({ x: p.x, y: p.y })) }))

  const b = cj.find((e) => e.type === "pcb_board")
  const board = b
    ? { cx: num(b.center?.x), cy: num(b.center?.y), w: num(b.width, 50), h: num(b.height, 40) }
    : { cx: 0, cy: 0, w: 50, h: 40 }

  const membersByKey = new Map<string, string[]>()
  for (const sp of srcPort.values()) {
    const k = sp.subcircuit_connectivity_map_key
    if (!k) continue
    const cname = srcComp.get(sp.source_component_id)?.name ?? "?"
    ;(membersByKey.get(k) ?? membersByKey.set(k, []).get(k)!).push(`${cname}.${sp.name ?? sp.pin_number}`)
  }
  const sch = new Map<string, string[]>()
  for (const e of cj) if (e.type === "schematic_trace" && e.subcircuit_connectivity_map_key) (sch.get(e.subcircuit_connectivity_map_key) ?? sch.set(e.subcircuit_connectivity_map_key, []).get(e.subcircuit_connectivity_map_key)!).push(e.schematic_trace_id)

  return {
    board, comps, pads, traces, vias, holes, silk, outlines, compByName, dupNames, compByPcbId, compBySchId,
    netName: (k) => keyNames.get(k),
    members: (k) => membersByKey.get(k) ?? [],
    schTraceIds: (k) => sch.get(k) ?? [],
  }
}
