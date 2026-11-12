// Read-only views of a built design: components, nets, source mapping, snapshots.
// Everything is derived from the circuit JSON of the last build plus a static scan of the source files.
import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg"
import { Resvg } from "@resvg/resvg-js"
import fs from "node:fs"
import path from "node:path"
import { readDesignFiles, ROOT } from "./build.js"

export type SourceRef = { file: string; line: number }
export type ComponentInfo = {
  ref: string
  type: string
  value: string | null
  mpn: string | null
  footprint: string | null
  lcsc: string | null
  x: number | null
  y: number | null
  rotation: number | null
  layer: string | null
  width: number | null
  height: number | null
  source: SourceRef | null
  /** lib block file when the part is placed by a shared block, else null */
  block: string | null
  /** net name per port label, e.g. { pin1: "V5", pin2: "SDA" } */
  pins: Record<string, string | null>
}
export type NetInfo = { name: string; kind: "ground" | "power" | "signal"; ports: { ref: string; port: string }[] }

const round = (n: any, d = 3) => (typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : null)

const TYPE_NAMES: Record<string, string> = {
  simple_resistor: "resistor", simple_capacitor: "capacitor", simple_inductor: "inductor", simple_diode: "diode",
  simple_led: "led", simple_transistor: "transistor", simple_chip: "chip", simple_pin_header: "pin header",
  simple_fuse: "fuse", simple_crystal: "crystal", simple_switch: "switch", simple_pinout: "pinout",
}
const typeOf = (ftype: string) => TYPE_NAMES[ftype] ?? ftype.replace(/^simple_/, "").replace(/_/g, " ")

// ---------- source mapping (static scan for name="X" / name={`X${n}`}) ----------
type Pattern = { re: RegExp; file: string; line: number; exact: boolean }

function scanSources(name: string): Pattern[] {
  const out: Pattern[] = []
  const add = (file: string, text: string) => {
    text.split(/\r?\n/).forEach((ln, i) => {
      for (const m of ln.matchAll(/\bname=(?:"([^"]+)"|\{`([^`]+)`\}|\{"([^"]+)"\})/g)) {
        const lit = m[1] ?? m[3]
        if (lit) out.push({ re: new RegExp(`^${lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), file, line: i + 1, exact: true })
        else if (m[2]) {
          const src = m[2].split(/\$\{[^}]*\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[A-Za-z0-9_]+")
          out.push({ re: new RegExp(`^${src}$`), file, line: i + 1, exact: false })
        }
      }
    })
  }
  for (const [rel, text] of Object.entries(readDesignFiles(name))) if (/\.tsx$/.test(rel)) add(`designs/${name}/${rel}`, text)
  const lib = path.join(ROOT, "lib")
  if (fs.existsSync(lib)) for (const f of fs.readdirSync(lib)) if (f.endsWith(".tsx")) add(`lib/${f}`, fs.readFileSync(path.join(lib, f), "utf8"))
  return out
}

function locate(patterns: Pattern[], ref: string): SourceRef | null {
  // exact literals win; then templates. Lib blocks only contain templates/literals for their own parts.
  const hit = patterns.find((p) => p.exact && p.re.test(ref) && !p.file.startsWith("lib/")) ??
    patterns.find((p) => p.re.test(ref) && p.file.startsWith("designs/")) ??
    patterns.find((p) => p.re.test(ref))
  return hit ? { file: hit.file, line: hit.line } : null
}

// ---------- circuit JSON -> components / nets ----------
type Cj = any[]
const by = (cj: Cj, type: string) => cj.filter((e) => e.type === type)

function netTable(cj: Cj) {
  // union-find over source ports and source nets joined by source_trace
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    if (!parent.has(a)) parent.set(a, a)
    let r = a
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(a, r)
    return r
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  for (const t of by(cj, "source_trace")) {
    const ids = [...(t.connected_source_port_ids ?? []), ...(t.connected_source_net_ids ?? [])]
    ids.forEach((id: string) => find(id))
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i])
  }
  const comps = new Map<string, any>(by(cj, "source_component").map((c) => [c.source_component_id, c]))
  const nets = new Map<string, any>(by(cj, "source_net").map((n) => [n.source_net_id, n]))
  const groups = new Map<string, { names: string[]; ground: boolean; power: boolean; ports: { ref: string; port: string; id: string }[] }>()
  const g = (root: string) => {
    if (!groups.has(root)) groups.set(root, { names: [], ground: false, power: false, ports: [] })
    return groups.get(root)!
  }
  for (const n of nets.values()) {
    const e = g(find(n.source_net_id))
    e.names.push(n.name)
    if (n.is_ground) e.ground = true
    if (n.is_power || n.is_positive_voltage_source) e.power = true
  }
  for (const p of by(cj, "source_port")) {
    const c = comps.get(p.source_component_id)
    if (!c) continue
    const label = (p.port_hints ?? []).find((h: string) => !/^\d+$/.test(h) && !/^pin\d+$/.test(h)) ?? p.name ?? `pin${p.pin_number}`
    g(find(p.source_port_id)).ports.push({ ref: c.name, port: String(label), id: p.source_port_id })
  }
  const result: (NetInfo & { id: string })[] = []
  for (const [root, e] of groups) {
    if (e.ports.length === 0 && e.names.length === 0) continue
    const name = e.names[0] ?? `~${e.ports.slice(0, 2).map((p) => `${p.ref}.${p.port}`).join("/")}`
    const lower = name.toLowerCase()
    const kind = e.ground || /^(gnd|agnd|dgnd|vss)$/.test(lower) ? "ground"
      : e.power || /^(v\d|vin|vbus|vcc|vdd|\+?\d+v\d*|3v3|5v|12v|24v|vbat)/.test(lower) ? "power" : "signal"
    result.push({ id: root, name, kind, ports: e.ports.map(({ ref, port }) => ({ ref, port })) })
  }
  // port id -> net name, for the per-component pin map
  const portNet = new Map<string, string>()
  for (const [root, e] of groups) {
    const n = result.find((r) => r.id === root)
    if (n) for (const p of e.ports) portNet.set(p.id, n.name)
  }
  return { nets: result.map(({ id: _id, ...n }) => n).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), portNet }
}

export function nets(cj: Cj): NetInfo[] {
  return netTable(cj).nets
}

export function components(name: string, cj: Cj): ComponentInfo[] {
  const patterns = scanSources(name)
  const { portNet } = netTable(cj)
  const pcb = new Map<string, any>(by(cj, "pcb_component").map((c) => [c.source_component_id, c]))
  const cad = new Map<string, any>(by(cj, "cad_component").map((c) => [c.source_component_id, c]))
  const portsOf = new Map<string, Record<string, string | null>>()
  for (const p of by(cj, "source_port")) {
    const m = portsOf.get(p.source_component_id) ?? {}
    const label = (p.port_hints ?? []).find((h: string) => !/^\d+$/.test(h) && !/^pin\d+$/.test(h)) ?? `pin${p.pin_number}`
    m[`${label}`] = portNet.get(p.source_port_id) ?? null
    portsOf.set(p.source_component_id, m)
  }
  return by(cj, "source_component").map((s): ComponentInfo => {
    const pc = pcb.get(s.source_component_id)
    const src = locate(patterns, s.name)
    const value = s.display_resistance ?? s.display_capacitance ?? s.display_inductance ?? s.symbol_display_value ??
      (s.transistor_type ? String(s.transistor_type) : null)
    const fp = cad.get(s.source_component_id)?.footprinter_string ?? null
    return {
      ref: s.name,
      type: typeOf(s.ftype ?? "unknown"),
      value: value ?? null,
      mpn: s.manufacturer_part_number ?? null,
      footprint: fp,
      lcsc: s.supplier_part_numbers?.jlcpcb?.[0] ?? null,
      x: round(pc?.center?.x),
      y: round(pc?.center?.y),
      rotation: round(pc?.rotation, 1),
      layer: pc?.layer ?? null,
      width: round(pc?.width),
      height: round(pc?.height),
      source: src,
      block: src?.file.startsWith("lib/") ? src.file : null,
      pins: portsOf.get(s.source_component_id) ?? {},
    }
  }).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
}

// ---------- snapshots ----------
export function snapshotPng(cj: Cj, view: "pcb" | "schematic", width = 1600): Buffer {
  const svg = view === "pcb" ? convertCircuitJsonToPcbSvg(cj as any) : convertCircuitJsonToSchematicSvg(cj as any)
  const bg = view === "pcb" ? "#111111" : "#f8f8f4"
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: width }, background: bg }).render().asPng())
}
