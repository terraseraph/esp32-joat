import fs from "node:fs"
import path from "node:path"
import { runAllChecks } from "@tscircuit/checks"
import { ROOT } from "./build.js"

// ---- types -----------------------------------------------------------------

export type Rules = {
  minTrace: number // mm
  minClearance: number // mm
  copperOz: number
  netCurrents: Record<string, number> // net name -> amps
  decouplingMaxDistance: number // mm, IC supply pin to nearest decoupling cap
}
export const DEFAULT_RULES: Rules = { minTrace: 0.1, minClearance: 0.1, copperOz: 1, netCurrents: {}, decouplingMaxDistance: 10 }

export type Where = { view: "pcb" | "schematic"; x: number; y: number; w: number; h: number; layer?: string; pcbComponentId?: string }
export type CheckIssue = {
  id: string
  severity: "error" | "warning" | "info"
  source: "build" | "tscircuit-checks" | "custom"
  rule: string // machine id, e.g. "trace-current"
  title: string
  message: string
  why: string // why it matters
  fix?: string
  refs?: string[] // component names / nets involved
  where?: Where
  /** raw circuit-json element id that produced it, if any */
  elementId?: string
}
export type ChecksResult = {
  ok: boolean
  counts: { error: number; warning: number; info: number }
  rules: Rules
  issues: CheckIssue[]
}

export const normalizeRules = (r: any): Rules => {
  const num = (v: any, d: number, min = 0) => (typeof v === "number" && isFinite(v) && v >= min ? v : d)
  const nc: Record<string, number> = {}
  if (r?.netCurrents && typeof r.netCurrents === "object")
    for (const [k, v] of Object.entries(r.netCurrents)) if (typeof v === "number" && isFinite(v) && v > 0) nc[k] = v
  return {
    minTrace: num(r?.minTrace, DEFAULT_RULES.minTrace, 0.01),
    minClearance: num(r?.minClearance, DEFAULT_RULES.minClearance, 0.01),
    copperOz: num(r?.copperOz, DEFAULT_RULES.copperOz, 0.1),
    netCurrents: nc,
    decouplingMaxDistance: num(r?.decouplingMaxDistance, DEFAULT_RULES.decouplingMaxDistance, 0.5),
  }
}

// ---- explanations for the stock tscircuit errors/warnings ---------------------

type Explain = { title: string; why: string; fix?: string }
const EXPLAIN: [RegExp, Explain][] = [
  [/pcb_pad_pad_clearance|pcb_pad_trace_clearance|pcb_via_trace_clearance|pcb_via_clearance|pad_clearance/, {
    title: "Copper too close together",
    why: "Copper from different nets closer than the fab's minimum can short during etching or soldering, and fails the manufacturer's DRC.",
    fix: "Move the parts or traces apart, or reduce the trace width. The clearance limit comes from Design rules.",
  }],
  [/pcb_footprint_overlap|pcb_component_overlap|courtyard_overlap/, {
    title: "Parts overlap",
    why: "Overlapping footprints cannot be assembled: pads will bridge or the parts will not physically fit.",
    fix: "Move one of the components so their outlines no longer overlap.",
  }],
  [/pcb_component_outside_board|out_of_board|off_board|pcb_placement_error/, {
    title: "Something is outside or off the board",
    why: "Copper or parts hanging past the board edge will be cut off or cannot be mounted.",
    fix: "Move it inside the board outline, or enlarge the board.",
  }],
  [/pcb_trace_missing|pcb_port_not_connected|source_trace_not_connected|pcb_trace_error/, {
    title: "Connection is not routed",
    why: "A net that is wired in the schematic has no copper path on the PCB, so the circuit will not work as designed.",
    fix: "Give the autorouter more room, route it by hand, or check that the pins really need joining.",
  }],
  [/pcb_trace_too_long/, {
    title: "Trace is very long",
    why: "Long traces add resistance, inductance and noise pickup, which matters on fast or sensitive signals.",
    fix: "Place the connected parts closer together.",
  }],
  [/pcb_copper_pour_isolated|copper_pour/, {
    title: "Copper pour has an isolated island",
    why: "A pour region not connected to its net floats and can act as an antenna while doing no good.",
    fix: "Stitch it with vias, remove the island, or reshape the pour.",
  }],
  [/pcb_keepout_overlap|keepout/, {
    title: "Copper inside a keep-out",
    why: "Keep-out areas protect antennas, mounting hardware or mains clearance; copper there defeats their purpose.",
    fix: "Move the copper out of the keep-out area.",
  }],
  [/source_no_power_pin_defined|source_no_ground_pin_defined|source_component_pins_underspecified/, {
    title: "Pin roles not declared",
    why: "Without pinAttributes (requiresPower/requiresGround) the tool cannot check that supply pins are connected. This is a tooling hint, not an electrical fault.",
    fix: "Add pinAttributes to the chip, or ignore for connectors, relays and other passives.",
  }],
  [/pcb_component_missing_courtyard/, {
    title: "Part has no courtyard",
    why: "Without a courtyard the tool cannot detect overlaps with neighbouring parts, so placement is only checked by pad geometry.",
    fix: "Usually fine for stock footprints; add a courtyard on custom footprints.",
  }],
  [/supplier_footprint_mismatch/, {
    title: "Footprint may not match the LCSC part",
    why: "The footprint on the board might not match the part JLCPCB will place, which gives wrong or non-fitting assembly.",
    fix: "Compare the footprint against the LCSC datasheet before ordering.",
  }],
  [/schematic_missing_sheet|schematic_component_styling|schematic_/, {
    title: "Schematic tidiness",
    why: "Cosmetic: the schematic is harder to read, but the board is not affected.",
  }],
]
const explain = (type: string): Explain =>
  EXPLAIN.find(([re]) => re.test(type))?.[1] ?? {
    title: type.replace(/_/g, " "),
    why: "Reported by the circuit checker; read the message for the specifics.",
  }

// ---- circuit-json helpers --------------------------------------------------------

type Ctx = {
  byId: Map<string, any>
  pcbComponentOf: Map<string, any> // source_component_id -> pcb_component
  refName: (sourceComponentId: string) => string
  schComponentOf: Map<string, any>
  pcbPortToSource: Map<string, string>
  board: any
}

function buildCtx(cj: any[]): Ctx {
  const byId = new Map<string, any>()
  const pcbComponentOf = new Map<string, any>()
  const schComponentOf = new Map<string, any>()
  const pcbPortToSource = new Map<string, string>()
  for (const e of cj) {
    for (const k of Object.keys(e)) if (k.endsWith("_id") && k === `${e.type}_id` && typeof e[k] === "string") byId.set(e[k], e)
    if (e.type === "pcb_component") pcbComponentOf.set(e.source_component_id, e)
    if (e.type === "schematic_component") schComponentOf.set(e.source_component_id, e)
    if (e.type === "pcb_port") pcbPortToSource.set(e.pcb_port_id, e.source_port_id)
  }
  return {
    byId, pcbComponentOf, schComponentOf, pcbPortToSource,
    refName: (id) => byId.get(id)?.name ?? id,
    board: cj.find((e) => e.type === "pcb_board"),
  }
}

const box = (cx: number, cy: number, w: number, h: number) => ({ x: cx, y: cy, w, h })

function compWhere(ctx: Ctx, pc: any): Where {
  return { view: "pcb", ...box(pc.center.x, pc.center.y, pc.width ?? 1, pc.height ?? 1), pcbComponentId: pc.pcb_component_id, layer: pc.layer }
}

function routeBox(route: any[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of route) {
    if (typeof p.x !== "number") continue
    const hw = (p.width ?? 0.2) / 2
    x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw)
    y0 = Math.min(y0, p.y - hw); y1 = Math.max(y1, p.y + hw)
  }
  return x0 === Infinity ? null : box((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0)
}

/** Best-effort position for any circuit-json error/warning. */
function locate(e: any, ctx: Ctx): { where?: Where; refs: string[] } {
  const refs = new Set<string>()
  const comps: any[] = []
  const addSrc = (id?: string) => {
    if (!id) return
    const pc = ctx.pcbComponentOf.get(id)
    if (pc) comps.push(pc)
    refs.add(ctx.refName(id))
  }
  const addPcbComp = (id?: string) => {
    const pc = id && ctx.byId.get(id)
    if (pc) { comps.push(pc); refs.add(ctx.byId.get(pc.source_component_id)?.name ?? id) }
  }
  addSrc(e.source_component_id)
  for (const id of e.source_component_ids ?? []) addSrc(id)
  addPcbComp(e.pcb_component_id)
  for (const id of e.pcb_component_ids ?? []) addPcbComp(id)

  const schematic = /^schematic_/.test(e.type)
  if (schematic) {
    const sc = ctx.schComponentOf.get(e.source_component_id) ?? ctx.byId.get(e.schematic_component_id)
    if (sc?.center) return { refs: [...refs], where: { view: "schematic", ...box(sc.center.x, sc.center.y, sc.size?.width ?? 2, sc.size?.height ?? 2) } }
    return { refs: [...refs] }
  }

  const pos = e.center ?? e.position ?? (typeof e.x === "number" && typeof e.y === "number" ? e : null)
  if (pos && typeof pos.x === "number") {
    const first = comps[0]
    return { refs: [...refs], where: { view: "pcb", ...box(pos.x, pos.y, Math.max(2, e.width ?? 0), Math.max(2, e.height ?? 0)), layer: e.layer, pcbComponentId: first?.pcb_component_id } }
  }
  for (const id of [e.pcb_trace_id, ...(e.pcb_trace_ids ?? [])]) {
    const t = id && ctx.byId.get(id)
    const b = t && routeBox(t.route)
    if (b) return { refs: [...refs], where: { view: "pcb", ...b } }
  }
  for (const id of [e.pcb_port_id, ...(e.pcb_port_ids ?? [])]) {
    const p = id && ctx.byId.get(id)
    if (p && typeof p.x === "number") return { refs: [...refs], where: { view: "pcb", ...box(p.x, p.y, 2, 2), pcbComponentId: p.pcb_component_id } }
  }
  for (const id of [e.pcb_smtpad_id, e.pcb_via_id, e.pcb_plated_hole_id]) {
    const p = id && ctx.byId.get(id)
    if (p && typeof p.x === "number") return { refs: [...refs], where: { view: "pcb", ...box(p.x, p.y, 2, 2) } }
  }
  if (comps.length) {
    // enclosing box of every component named
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const c of comps) {
      x0 = Math.min(x0, c.center.x - c.width / 2); x1 = Math.max(x1, c.center.x + c.width / 2)
      y0 = Math.min(y0, c.center.y - c.height / 2); y1 = Math.max(y1, c.center.y + c.height / 2)
    }
    return { refs: [...refs], where: { ...compWhere(ctx, comps[0]), ...box((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0) } }
  }
  return { refs: [...refs] }
}

function fromElement(e: any, source: CheckIssue["source"], ctx: Ctx, severity: "error" | "warning", n: number): CheckIssue {
  const ex = explain(e.type)
  const { where, refs } = locate(e, ctx)
  return {
    id: `${source}-${n}-${e.type}`,
    severity,
    source,
    rule: e.type,
    title: ex.title,
    message: e.message ?? e.type,
    why: ex.why,
    fix: ex.fix,
    refs: refs.length ? refs : undefined,
    where,
    elementId: e[`${e.type}_id`],
  }
}

// ---- custom rules -----------------------------------------------------------------

/** IPC-2221 external-layer minimum trace width (mm) for `amps` at a 10 C rise. */
export function widthForCurrent(amps: number, oz: number, layer = "top", riseC = 10): number {
  const k = /^(top|bottom)$/.test(layer) ? 0.048 : 0.024 // IPC-2221: inner layers dissipate heat worse
  const areaMil2 = Math.pow(amps / (k * Math.pow(riseC, 0.44)), 1 / 0.725)
  const thicknessMil = 1.378 * oz
  return (areaMil2 / thicknessMil) * 0.0254
}

const netKeyIndex = (cj: any[]) => {
  const nets = cj.filter((e) => e.type === "source_net")
  const portKey = new Map<string, string>()
  for (const p of cj) if (p.type === "source_port" && p.subcircuit_connectivity_map_key) portKey.set(p.source_port_id, p.subcircuit_connectivity_map_key)
  const keyToNet = new Map<string, any>()
  for (const n of nets) if (n.subcircuit_connectivity_map_key) keyToNet.set(n.subcircuit_connectivity_map_key, n)
  return { portKey, keyToNet }
}

function checkTraceCurrent(cj: any[], ctx: Ctx, rules: Rules): CheckIssue[] {
  const out: CheckIssue[] = []
  const entries = Object.entries(rules.netCurrents)
  if (!entries.length) return out
  const { portKey, keyToNet } = netKeyIndex(cj)
  const nameToKey = new Map<string, string>()
  for (const [k, n] of keyToNet) nameToKey.set(n.name, k)
  const netById = new Map<string, any>()
  for (const n of cj) if (n.type === "source_net") netById.set(n.source_net_id, n)

  /** Net of a pcb_trace: autorouter ports, hand-drawn traces via source_trace, or connection_name. */
  const netOf = (t: any): any => {
    for (const pid of t.connectsTo ?? []) {
      const sp = ctx.pcbPortToSource.get(pid)
      const key = sp ? portKey.get(sp) : undefined
      if (key && keyToNet.has(key)) return keyToNet.get(key)
    }
    const st = ctx.byId.get(t.source_trace_id) ?? ctx.byId.get(t.connection_name)
    if (st?.type === "source_trace") {
      for (const id of st.connected_source_net_ids ?? []) if (netById.has(id)) return netById.get(id)
      for (const id of st.connected_source_port_ids ?? []) {
        const key = portKey.get(id)
        if (key && keyToNet.has(key)) return keyToNet.get(key)
      }
    }
    return keyToNet.get(t.connection_name) ?? netById.get(t.connection_name)
  }

  type Worst = { ratio: number; width: number; need: number; at: any; i: number }
  const perNet = new Map<string, Worst>()
  for (const t of cj) {
    if (t.type !== "pcb_trace") continue
    const net = netOf(t)
    const amps = net && rules.netCurrents[net.name]
    if (!amps) continue
    for (const [i, p] of (t.route ?? []).entries()) {
      if (p.route_type !== "wire" || typeof p.width !== "number") continue
      const need = widthForCurrent(amps, rules.copperOz, p.layer)
      const cur = perNet.get(net.name)
      if (!cur || p.width / need < cur.ratio) perNet.set(net.name, { ratio: p.width / need, width: p.width, need, at: t.route, i })
    }
  }
  const pouredNets = new Set(cj.filter((e) => e.type === "pcb_copper_pour").map((p) => ctx.byId.get(p.source_net_id)?.name).filter(Boolean))
  for (const [net, amps] of entries) {
    const seen = perNet.get(net)
    const key = nameToKey.get(net)
    if (!seen) {
      out.push({
        id: `custom-current-${net}-none`, severity: "warning", source: "custom", rule: "trace-current",
        title: `Net ${net}: no traces found to check`,
        message: `Net "${net}" is tagged ${amps} A but no trace on it was found in this build${key ? (pouredNets.has(net) ? " (it has a copper pour, which this check does not size)" : " (it may be fully unrouted or carried by pours)") : " (no net with that name exists)"}.`,
        why: "A current requirement that cannot be matched to copper is not being verified, so a typo or an unrouted high-current net passes silently.",
        fix: key ? "Route the net with wide traces or check the pour carries the current." : "Check the net name in Design rules matches the schematic exactly.",
        refs: [net],
      })
      continue
    }
    if (seen.ratio >= 1 - 1e-6) continue
    const p = seen.at[seen.i]
    const near = routeBox(seen.at.slice(Math.max(0, seen.i - 1), seen.i + 2))
    out.push({
      id: `custom-current-${net}`, severity: seen.ratio < 0.5 ? "error" : "warning", source: "custom", rule: "trace-current",
      title: `Net ${net}: trace too thin for ${amps} A`,
      message: `Narrowest trace on "${net}" is ${seen.width.toFixed(2)} mm on ${p.layer}; ${amps} A on ${rules.copperOz} oz copper needs about ${seen.need.toFixed(2)} mm there (IPC-2221, 10 °C rise${pouredNets.has(net) ? "; this net also has a copper pour, so check the pour carries the current" : ""}).`,
      why: "A trace carrying more current than its width allows heats up, drops voltage, and in the worst case burns open or lifts off the board.",
      fix: `Widen the traces on ${net} to at least ${seen.need.toFixed(1)} mm (traceWidth prop on <trace>), use a copper pour, or add parallel traces on another layer.`,
      refs: [net],
      where: { view: "pcb", ...(near ?? box(p.x, p.y, 2, 2)), layer: p.layer },
    })
  }
  return out
}

function checkMinTrace(cj: any[], ctx: Ctx, rules: Rules): CheckIssue[] {
  const out: CheckIssue[] = []
  let n = 0
  for (const t of cj) {
    if (t.type !== "pcb_trace") continue
    const thin = (t.route ?? []).find((p: any) => p.route_type === "wire" && typeof p.width === "number" && p.width + 1e-6 < rules.minTrace)
    if (!thin) continue
    if (n++ >= 20) {
      const total = cj.filter((e) => e.type === "pcb_trace" && (e.route ?? []).some((q: any) => q.route_type === "wire" && typeof q.width === "number" && q.width + 1e-6 < rules.minTrace)).length
      out.push({ id: "custom-mintrace-more", severity: "info", source: "custom", rule: "min-trace", title: "More thin traces not listed", message: `${total} traces are thinner than ${rules.minTrace} mm; only the first 20 are listed.`, why: "The list is capped so it stays readable.", fix: "Fix these, rebuild, and the rest will show." })
      break
    }
    out.push({
      id: `custom-mintrace-${t.pcb_trace_id}`, severity: "warning", source: "custom", rule: "min-trace",
      title: "Trace thinner than your minimum",
      message: `A trace is ${thin.width.toFixed(3)} mm wide; your Design rules minimum is ${rules.minTrace} mm.`,
      why: "Traces below the fab's capability get rejected or etch away unevenly, which gives open circuits.",
      fix: "Widen the trace or lower the minimum if your fab really allows it.",
      where: { view: "pcb", ...(routeBox(t.route) ?? box(thin.x, thin.y, 2, 2)), layer: thin.layer },
    })
  }
  return out
}

// only modules with an on-board antenna (WROOM/WROVER/MINI), not bare ESP32 chips
const isEsp32 = (sc: any) => sc && /esp32.*(wroom|wrover|mini)/i.test(`${sc.manufacturer_part_number ?? ""} ${sc.name ?? ""} ${sc.display_value ?? ""}`)

function pointInRing(x: number, y: number, ring: { x: number; y: number }[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
function pourCovers(p: any, x: number, y: number): boolean {
  if (p.shape === "rect") return Math.abs(x - p.center.x) <= p.width / 2 && Math.abs(y - p.center.y) <= p.height / 2
  if (p.shape === "polygon") return pointInRing(x, y, p.points)
  if (p.shape === "brep") {
    const b = p.brep_shape
    if (!pointInRing(x, y, b.outer_ring.vertices)) return false
    return !(b.inner_rings ?? []).some((r: any) => pointInRing(x, y, r.vertices))
  }
  return false
}

function checkAntennaKeepout(cj: any[], ctx: Ctx): CheckIssue[] {
  const out: CheckIssue[] = []
  for (const sc of cj.filter((e) => e.type === "source_component" && isEsp32(e))) {
    const pc = ctx.pcbComponentOf.get(sc.source_component_id)
    if (!pc) continue
    const pads = cj.filter((e) => (e.type === "pcb_smtpad" || e.type === "pcb_plated_hole") && e.pcb_component_id === pc.pcb_component_id)
    if (!pads.length) continue
    // pcb_component width/height cover pads only, so work from the pad extents: the antenna end of a
    // WROOM-style module is the edge of the pad field with (almost) no pads along it, since the pin rows run
    // down the other three sides. Coordinates are already rotated, so this holds at any pcbRotation.
    const x0p = Math.min(...pads.map((p) => p.x)), x1p = Math.max(...pads.map((p) => p.x))
    const y0p = Math.min(...pads.map((p) => p.y)), y1p = Math.max(...pads.map((p) => p.y))
    const BAND = 1.0
    const count = {
      left: pads.filter((p) => p.x - x0p < BAND).length,
      right: pads.filter((p) => x1p - p.x < BAND).length,
      bottom: pads.filter((p) => p.y - y0p < BAND).length,
      top: pads.filter((p) => y1p - p.y < BAND).length,
    }
    const side = (Object.entries(count).sort((a, b) => a[1] - b[1])[0][0]) as keyof typeof count
    // the module body continues ~8 mm past the last pad on that side (antenna ~6.5 mm + margin), then keep-out beyond
    const DEPTH_OUT = 18
    const zone = { x0: x0p, x1: x1p, y0: y0p, y1: y1p }
    if (side === "left") zone.x0 -= DEPTH_OUT
    if (side === "right") zone.x1 += DEPTH_OUT
    if (side === "bottom") zone.y0 -= DEPTH_OUT
    if (side === "top") zone.y1 += DEPTH_OUT
    const b = ctx.board
    const clipped = b ? {
      x0: Math.max(zone.x0, b.center.x - b.width / 2), x1: Math.min(zone.x1, b.center.x + b.width / 2),
      y0: Math.max(zone.y0, b.center.y - b.height / 2), y1: Math.min(zone.y1, b.center.y + b.height / 2),
    } : zone
    if (clipped.x1 <= clipped.x0 || clipped.y1 <= clipped.y0) continue
    const zw = clipped.x1 - clipped.x0, zh = clipped.y1 - clipped.y0
    const where: Where = { view: "pcb", ...box((clipped.x0 + clipped.x1) / 2, (clipped.y0 + clipped.y1) / 2, zw, zh), pcbComponentId: pc.pcb_component_id }
    const inZone = (x: number, y: number, m = 0) => x >= clipped.x0 - m && x <= clipped.x1 + m && y >= clipped.y0 - m && y <= clipped.y1 + m

    const pours = cj.filter((e) => e.type === "pcb_copper_pour")
    const pourLayers = [...new Set(pours.map((p) => p.layer as string))] // every copper layer, inner ones included
    const covered: Record<string, number> = {}
    let samples = 0
    const N = 24
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x = clipped.x0 + ((i + 0.5) / N) * zw, y = clipped.y0 + ((j + 0.5) / N) * zh
      samples++
      for (const l of pourLayers) if (pours.some((p) => p.layer === l && pourCovers(p, x, y))) covered[l] = (covered[l] ?? 0) + 1
    }
    for (const [layer, c] of Object.entries(covered)) {
      if (c / samples < 0.03) continue
      out.push({
        id: `custom-antenna-pour-${sc.name}-${layer}`, severity: "error", source: "custom", rule: "antenna-keepout-pour",
        title: `Copper pour under the ${sc.name} antenna`,
        message: `The ${layer} copper pour covers about ${Math.round((c / samples) * 100)}% of the ${zw.toFixed(0)}×${zh.toFixed(0)} mm antenna keep-out at the ${side} end of ${sc.name}.`,
        why: "Ground copper under or beside the antenna detunes it and cuts Wi-Fi/Bluetooth range badly; the module datasheet requires no copper, traces or components under the antenna end.",
        fix: "Add a <cutout> (or keepout) over the antenna end so the pour is removed there, and keep traces out of it.",
        refs: [sc.name], where,
      })
    }
    const traces = cj.filter((t) => t.type === "pcb_trace" && (t.route ?? []).some((p: any) => typeof p.x === "number" && inZone(p.x, p.y)))
    const vias = cj.filter((v) => v.type === "pcb_via" && inZone(v.x, v.y))
    if (traces.length || vias.length)
      out.push({
        id: `custom-antenna-traces-${sc.name}`, severity: "warning", source: "custom", rule: "antenna-keepout-traces",
        title: `Traces or vias in the ${sc.name} antenna keep-out`,
        message: `${traces.length} trace(s) and ${vias.length} via(s) pass through the antenna keep-out at the ${side} end of ${sc.name}.`,
        why: "Copper near the antenna element detunes it and can couple noise into the radio.",
        fix: "Re-route these away from the antenna end of the module.",
        refs: [sc.name], where,
      })
  }
  return out
}

function checkDecoupling(cj: any[], ctx: Ctx, rules: Rules): CheckIssue[] {
  const out: CheckIssue[] = []
  const { portKey, keyToNet } = netKeyIndex(cj)
  const isGround = (key?: string) => {
    const n = key && keyToNet.get(key)
    return !!n && (n.is_ground || /^(gnd|agnd|dgnd|vss)/i.test(n.name))
  }
  const caps = cj.filter((e) => e.type === "source_component" && e.ftype === "simple_capacitor")
  const capsByKey = new Map<string, any[]>() // supply net key -> caps bridging supply and ground
  const portsOf = new Map<string, any[]>()
  for (const p of cj) if (p.type === "source_port") (portsOf.get(p.source_component_id) ?? portsOf.set(p.source_component_id, []).get(p.source_component_id)!).push(p)
  for (const c of caps) {
    const keys = (portsOf.get(c.source_component_id) ?? []).map((p) => portKey.get(p.source_port_id))
    if (keys.length !== 2 || !keys.some(isGround)) continue
    const supply = keys.find((k) => !isGround(k))
    if (supply) (capsByKey.get(supply) ?? capsByKey.set(supply, []).get(supply)!).push(c)
  }
  const SUPPLY = /^(vcc|vdd|vdda|vddio|vcca|vin|v\+|3v3|vdd3p3|vdd_?spi|avdd|dvdd|vbat|v3[_.]?3|v5|5v)\w*$/i
  const padOfPort = new Map<string, any>()
  for (const p of cj) if ((p.type === "pcb_smtpad" || p.type === "pcb_plated_hole") && p.pcb_port_id) padOfPort.set(p.pcb_port_id, p)
  const srcPortToPcb = new Map<string, string>()
  for (const [pcb, src] of ctx.pcbPortToSource) srcPortToPcb.set(src, pcb)

  for (const ic of cj.filter((e) => e.type === "source_component" && e.ftype === "simple_chip")) {
    const pc = ctx.pcbComponentOf.get(ic.source_component_id)
    if (!pc || /^(j|cn|p|tb|usb|x)[_\d]|conn|header|terminal/i.test(`${ic.name ?? ""}`)) continue // ICs only, not connectors
    const seenKeys = new Set<string>()
    for (const sp of portsOf.get(ic.source_component_id) ?? []) {
      const names: string[] = [sp.name, ...(sp.port_hints ?? [])].filter((s) => typeof s === "string")
      const key = portKey.get(sp.source_port_id)
      if (!key || isGround(key) || seenKeys.has(key)) continue
      if (!names.some((n) => SUPPLY.test(n))) continue
      seenKeys.add(key)
      const padCandidates = (portsOf.get(ic.source_component_id) ?? []).filter((q) => portKey.get(q.source_port_id) === key)
      const pad = padOfPort.get(srcPortToPcb.get(sp.source_port_id) ?? "")
      const px = pad?.x ?? pc.center.x, py = pad?.y ?? pc.center.y
      const supplyName = keyToNet.get(key)?.name ?? sp.name
      const nearby = (capsByKey.get(key) ?? []).map((c) => {
        const cp = ctx.pcbComponentOf.get(c.source_component_id)
        return { c, d: cp ? Math.hypot(cp.center.x - px, cp.center.y - py) : Infinity }
      }).sort((a, b) => a.d - b.d)
      const best = nearby[0]
      const where: Where = { view: "pcb", ...box(pc.center.x, pc.center.y, Math.max(pc.width, 2), Math.max(pc.height, 2)), pcbComponentId: pc.pcb_component_id }
      void padCandidates
      if (!best)
        out.push({
          id: `custom-decap-${ic.name}-${sp.name}`, severity: "warning", source: "custom", rule: "decoupling-missing",
          title: `${ic.name} has no decoupling capacitor on ${supplyName}`,
          message: `${ic.name} pin ${sp.name} is supplied from ${supplyName}, but no capacitor connects that net to ground.`,
          why: "Chips draw current in short spikes; without a nearby capacitor the supply dips and rings, causing resets, bus glitches and noise.",
          fix: `Add a 100 nF capacitor between ${supplyName} and GND placed next to ${ic.name}.`,
          refs: [ic.name, supplyName], where,
        })
      else if (best.d > rules.decouplingMaxDistance)
        out.push({
          id: `custom-decap-far-${ic.name}-${sp.name}`, severity: "warning", source: "custom", rule: "decoupling-far",
          title: `${ic.name}'s nearest decoupling cap is far away`,
          message: `The nearest ${supplyName} capacitor (${best.c.name}) is ${best.d.toFixed(1)} mm from ${ic.name} pin ${sp.name}; the limit is ${rules.decouplingMaxDistance} mm.`,
          why: "Trace inductance between the capacitor and the pin makes it ineffective at the frequencies where the chip needs it.",
          fix: `Move ${best.c.name} next to ${ic.name} pin ${sp.name}.`,
          refs: [ic.name, best.c.name], where,
        })
    }
  }
  return out
}

// ---- entry point ---------------------------------------------------------------------

const withRules = (cj: any[], rules: Rules) =>
  cj.map((e) =>
    e.type === "pcb_board"
      ? { ...e, min_trace_width: rules.minTrace, min_pad_edge_to_pad_edge_clearance: rules.minClearance, min_trace_to_pad_edge_clearance: rules.minClearance }
      : e,
  )

// keyed by circuit-json identity (the build cache returns the same array for unchanged inputs) + rules
const checkCache = new WeakMap<object, Map<string, ChecksResult>>()

export async function runChecks(cj: any[], metaRules: any): Promise<ChecksResult> {
  const rules = normalizeRules(metaRules)
  const rk = JSON.stringify(rules)
  const hit = checkCache.get(cj)?.get(rk)
  if (hit) return hit
  const res = await runChecksUncached(cj, rules)
  const m = checkCache.get(cj) ?? new Map<string, ChecksResult>()
  m.clear() // only the latest rules per build
  m.set(rk, res)
  checkCache.set(cj, m)
  return res
}

async function runChecksUncached(cj: any[], rules: Rules): Promise<ChecksResult> {
  const ctx = buildCtx(cj)
  const issues: CheckIssue[] = []
  const seen = new Set<string>()
  const key = (e: any) => `${e.type}|${e.message}`
  let n = 0
  for (const e of cj) {
    if (!e.type?.endsWith("_error") && !e.type?.endsWith("_warning")) continue
    seen.add(key(e))
    const it = fromElement(e, "build", ctx, e.type.endsWith("_error") ? "error" : "warning", n++)
    if (/^schematic_|source_no_(power|ground)_pin|pins_underspecified/.test(e.type)) it.severity = "info" // tidiness hints, not board faults
    issues.push(it)
  }
  try {
    const extra = await runAllChecks(withRules(cj, rules) as any)
    for (const e of extra as any[]) {
      if (seen.has(key(e))) continue
      seen.add(key(e))
      issues.push(fromElement(e, "tscircuit-checks", ctx, String(e.type).endsWith("_warning") ? "warning" : "error", n++))
    }
  } catch (err: any) {
    issues.push({
      id: "checks-crashed", severity: "info", source: "tscircuit-checks", rule: "checks-crashed",
      title: "Some stock checks could not run", message: String(err?.message ?? err),
      why: "The tscircuit check library threw on this design, so only the built-in and custom checks ran.",
    })
  }
  for (const f of [checkTraceCurrent, checkMinTrace, checkDecoupling]) issues.push(...f(cj, ctx, rules))
  issues.push(...checkAntennaKeepout(cj, ctx))
  const rank = { error: 0, warning: 1, info: 2 }
  issues.sort((a, b) => rank[a.severity] - rank[b.severity])
  const counts = { error: 0, warning: 0, info: 0 }
  for (const i of issues) counts[i.severity]++
  return { ok: counts.error === 0, counts, rules, issues }
}

// ---- board.json: checklist + rules + notes splitting ------------------------------------

export type ChecklistItem = { id: string; text: string; status: "open" | "ok" | "wontfix"; note: string }
const STATUSES = ["open", "ok", "wontfix"]

export function normalizeChecklist(list: any): ChecklistItem[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: ChecklistItem[] = []
  for (const it of list) {
    if (!it || typeof it.text !== "string") continue
    let id = typeof it.id === "string" && it.id ? it.id : `c${out.length + 1}`
    while (seen.has(id)) id += "_"
    seen.add(id)
    out.push({ id, text: it.text, status: STATUSES.includes(it.status) ? it.status : "open", note: typeof it.note === "string" ? it.note : "" })
  }
  return out
}

/** Turn "(1) foo. (2) bar." into checklist entries; skips ones already present by text. */
export function splitNotes(notes: string, existing: ChecklistItem[] = []): ChecklistItem[] {
  const parts = notes.split(/\((\d+)\)\s*/)
  const out = [...existing]
  const have = new Set(existing.map((e) => e.text))
  let next = existing.length + 1
  for (let i = 1; i < parts.length; i += 2) {
    const text = (parts[i + 1] ?? "").trim().replace(/[;\s]+$/, "")
    if (!text || have.has(text)) continue
    let id = `c${next++}`
    while (out.some((o) => o.id === id)) id = `c${next++}`
    out.push({ id, text, status: "open", note: "" })
  }
  return out
}

/** Merge a patch into designs/<name>/board.json, preserving other keys. `base` is the caller's current board.json
 *  text (e.g. the editor's unsaved copy); it is used instead of the disk text. Invalid JSON throws a 422 and nothing is written. */
export function patchBoardJson(name: string, patch: { checklist?: any; rules?: any; notes?: string; splitNotes?: boolean; base?: string }): { text: string; meta: any } {
  const file = path.join(ROOT, "designs", name, "board.json")
  let meta: any = {}
  let raw: string | null = typeof patch.base === "string" ? patch.base : null
  if (raw === null && fs.existsSync(file)) raw = fs.readFileSync(file, "utf8")
  if (raw !== null && raw.trim()) {
    try {
      meta = JSON.parse(raw)
    } catch (e: any) {
      throw Object.assign(new Error(`board.json is not valid JSON (${e.message}); fix it before editing the checklist or rules`), { statusCode: 422 })
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw Object.assign(new Error("board.json must be a JSON object"), { statusCode: 422 })
  }
  if (patch.checklist !== undefined) meta.checklist = normalizeChecklist(patch.checklist)
  if (patch.rules !== undefined) {
    const r = normalizeRules(patch.rules)
    meta.rules = { minTrace: r.minTrace, minClearance: r.minClearance, copperOz: r.copperOz, netCurrents: r.netCurrents, decouplingMaxDistance: r.decouplingMaxDistance }
  }
  if (typeof patch.notes === "string") meta.notes = patch.notes
  if (patch.splitNotes) meta.checklist = splitNotes(String(meta.notes ?? ""), normalizeChecklist(meta.checklist))
  const text = JSON.stringify(meta, null, 2) + "\n"
  fs.writeFileSync(file, text)
  return { text, meta }
}
