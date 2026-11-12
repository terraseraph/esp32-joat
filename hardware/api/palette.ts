// Parts palette: lists insertable items (hardware/lib blocks + common primitives), searches JLC
// parts, and inserts a component's JSX into a design's index.tsx. The UI and Claude both use it:
//   GET  /api/palette
//   GET  /api/parts/search?q=...&limit=20
//   POST /api/designs/:name/components   { item, props?, source? }
import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { NAME_RE, ROOT, safeDesignPath } from "./build.js"
import { parseBreaks } from "./parts.js"

export type PropType = "string" | "number" | "boolean" | "raw" | "select"
export type PropSpec = {
  name: string
  type: PropType
  options?: string[]
  default?: string | number | boolean
  required: boolean
  doc?: string
  /** shown only under the form's Advanced expander */
  advanced?: boolean
}
export type PaletteItem = {
  /** "lib:<Component>" or "prim:<tag>" */
  id: string
  kind: "lib" | "primitive"
  label: string
  /** JSX tag / component name */
  tag: string
  /** lib only: module path relative to the design's index.tsx, no extension */
  importPath?: string
  description: string
  /** ref-designator prefix for the generated name */
  prefix: string
  /** the prop that receives the board X/Y position ("pcbX" or, for blocks like RelayChannel, "x") */
  posProps: { x: string; y: string } | null
  props: PropSpec[]
}

const FOOTPRINTS = ["0402", "0603", "0805", "1206", "sot23", "sod123", "soic8", "tssop16", "qfn16"]
const posProps = (): PropSpec[] => [
  { name: "pcbX", type: "number", default: 0, required: false, doc: "board X (mm, from centre)" },
  { name: "pcbY", type: "number", default: 0, required: false, doc: "board Y (mm, from centre)" },
  { name: "pcbRotation", type: "number", default: 0, required: false, doc: "rotation in degrees", advanced: true },
  { name: "schX", type: "number", required: false, doc: "schematic X", advanced: true },
  { name: "schY", type: "number", required: false, doc: "schematic Y", advanced: true },
]
const lcscProp = (): PropSpec => ({ name: "lcsc", type: "string", required: false, doc: "JLCPCB/LCSC part number, e.g. C14663 (use the search box)" })
const fpProp = (def: string): PropSpec => ({ name: "footprint", type: "string", options: FOOTPRINTS, default: def, required: true, doc: "package footprint" })
const nameProp = (): PropSpec => ({ name: "name", type: "string", required: true, doc: "reference designator (auto-generated, unique)" })
const prim = (tag: string, label: string, prefix: string, description: string, props: PropSpec[]): PaletteItem => ({
  id: `prim:${tag}`, kind: "primitive", label, tag, description, prefix,
  posProps: { x: "pcbX", y: "pcbY" },
  props: [nameProp(), ...props, ...posProps()],
})

export const PRIMITIVES: PaletteItem[] = [
  prim("resistor", "Resistor", "R", "Two-pin resistor.", [
    { name: "resistance", type: "string", default: "10k", required: true, doc: "e.g. 4.7k" }, fpProp("0603"), lcscProp()]),
  prim("capacitor", "Capacitor", "C", "Two-pin capacitor.", [
    { name: "capacitance", type: "string", default: "100nF", required: true, doc: "e.g. 10uF" }, fpProp("0603"), lcscProp()]),
  prim("led", "LED", "D", "Light emitting diode.", [
    { name: "color", type: "select", options: ["red", "green", "blue", "yellow", "white"], default: "red", required: false }, fpProp("0603"), lcscProp()]),
  prim("diode", "Diode", "D", "Generic diode (set the LCSC part for the real one).", [fpProp("sod123"), lcscProp()]),
  prim("pinheader", "Pin header", "J", "Single-row pin header.", [
    { name: "pinCount", type: "number", default: 4, required: true },
    { name: "pitch", type: "string", default: "2.54mm", required: true },
    { name: "gender", type: "select", options: ["male", "female"], default: "male", required: false },
    { name: "showSilkscreenPinLabels", type: "boolean", default: false, required: false, advanced: true },
    lcscProp()]),
  prim("chip", "Chip (by LCSC / footprint)", "U", "Any IC: pick a JLC part with the search box, which fills its LCSC number and footprint.", [
    fpProp("soic8"),
    { name: "manufacturerPartNumber", type: "string", required: false, doc: "MPN (the search box fills it)" },
    lcscProp()]),
  {
    id: "prim:hole", kind: "primitive", label: "Mounting hole", tag: "hole", prefix: "H", description: "Unplated mounting hole.",
    posProps: { x: "pcbX", y: "pcbY" },
    props: [nameProp(), { name: "diameter", type: "string", default: "3.2mm", required: true }, ...posProps().slice(0, 2)],
  },
]

// ---------- lib block discovery ----------

const LIB_DIR = path.join(ROOT, "lib")
const LIB_PREFIX: Record<string, string> = { SrdRelay: "K", ScrewTerminal3: "TB", IdEeprom: "U", ExpansionHeader: "J", RelayChannel: "" }
const humanize = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2")

function typeBody(src: string, typeName: string): string | null {
  const m = new RegExp(`export type ${typeName}\\s*=\\s*\\{`).exec(src)
  if (!m) return null
  let depth = 1, i = m.index + m[0].length
  const start = i
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") depth--
  }
  return src.slice(start, i - 1)
}

function parseProp(name: string, optional: boolean, rawType: string, doc: string | undefined): PropSpec {
  const t = rawType.replace(/\/\/.*$/, "").replace(/[;,]\s*$/, "").trim()
  const spec: PropSpec = { name, type: "raw", required: !optional, doc }
  if (t === "number") { spec.type = "number"; if (name.startsWith("pcb") || name.startsWith("sch")) spec.default = 0 }
  else if (t === "string") spec.type = "string"
  else if (t === "boolean") spec.type = "boolean"
  else if (/^("[^"]*"|\d+|-\d+)(\s*\|\s*("[^"]*"|-?\d+))+$/.test(t)) {
    spec.type = "select"
    spec.options = t.split("|").map((s) => s.trim().replace(/^"|"$/g, ""))
    spec.default = spec.options[0]
  } else if (/^\[.*\]$/.test(t)) {
    spec.type = "raw" // tuples etc.: the user edits the expression
  }
  if (name === "pcbRotation" || name.startsWith("sch") || (optional && name !== "pcbX" && name !== "pcbY" && name !== "x" && name !== "y")) spec.advanced = true
  if (name === "pcbX" || name === "pcbY") spec.advanced = false
  return spec
}

function parseLibFile(file: string): PaletteItem[] {
  const src = fs.readFileSync(path.join(LIB_DIR, file), "utf8").split(String.fromCharCode(13)).join("")
  const base = file.replace(/\.tsx?$/, "")
  const items: PaletteItem[] = []
  const leading = (/^(?:\/\/.*\n)+/.exec(src)?.[0] ?? "").replace(/^\/\/ ?/gm, "").trim()
  // only React components: PascalCase arrow functions
  for (const m of src.matchAll(/(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?export const ([A-Z]\w*)\s*=\s*\(/g)) {
    const comp = m[2]
    const body = typeBody(src, `${comp}Props`)
    if (body === null) continue
    const doc = m[1] ? m[1].replace(/^\s*\* ?/gm, "").replace(/\s+/g, " ").trim() : leading.replace(/\s+/g, " ")
    const props: PropSpec[] = []
    let pending: string | undefined
    for (const line of body.split("\n")) {
      const t = line.trim()
      const dc = /^\/\*\*\s*(.*?)\s*\*\/$/.exec(t)
      if (dc) { pending = dc[1]; continue }
      const pm = /^(\w+)(\?)?:\s*(.+)$/.exec(t)
      if (pm) { props.push(parseProp(pm[1], !!pm[2], pm[3], pending)); pending = undefined }
    }
    const has = (n: string) => props.some((p) => p.name === n)
    const pos = has("pcbX") ? { x: "pcbX", y: "pcbY" } : has("x") ? { x: "x", y: "y" } : null
    for (const p of props) {
      if (p.name === "name") p.doc = p.doc ?? "reference designator (auto-generated, unique)"
      if (p.name === "n") p.default = 1
    }
    items.push({
      id: `lib:${comp}`, kind: "lib", label: humanize(comp), tag: comp, importPath: `../../lib/${base}`,
      description: doc, prefix: LIB_PREFIX[comp] ?? comp.replace(/[a-z0-9]/g, "").slice(0, 2) ?? "X",
      posProps: pos && has(pos.y) ? pos : pos ? { x: pos.x, y: "" } : null, props,
    })
  }
  return items
}

export function listPalette() {
  const lib: PaletteItem[] = []
  if (fs.existsSync(LIB_DIR))
    for (const f of fs.readdirSync(LIB_DIR).filter((f) => /\.tsx$/.test(f)).sort()) {
      try { lib.push(...parseLibFile(f)) } catch {}
    }
  return { lib, primitives: PRIMITIVES }
}

// ---------- insertion ----------

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

function usedNames(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/\bname=(?:"([^"]+)"|\{`([^`]+)`\}|\{"([^"]+)"\})/g)) out.add(m[1] ?? m[2] ?? m[3])
  return out
}

export function uniqueName(src: string, prefix: string): string {
  const used = usedNames(src)
  const usedLc = new Set([...used].map((s) => s.toUpperCase()))
  for (let i = 1; ; i++) if (!usedLc.has(`${prefix}${i}`.toUpperCase())) return `${prefix}${i}`
}

function jsxProp(spec: PropSpec, v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null
  switch (spec.type) {
    case "number": {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error(`${spec.name} must be a number`)
      return `${spec.name}={${n}}`
    }
    case "boolean": return v === true || v === "true" ? spec.name : `${spec.name}={false}`
    case "raw": return `${spec.name}={${String(v)}}`
    case "select":
      // numeric-literal unions (e.g. 1 | -1) must stay numbers
      return /^-?\d+$/.test(String(v)) && spec.options?.every((o) => /^-?\d+$/.test(o)) ? `${spec.name}={${v}}` : `${spec.name}="${esc(String(v))}"`
    default: return `${spec.name}="${esc(String(v))}"`
  }
}

export type InsertRequest = { item: string; props?: Record<string, unknown>; source?: string }
export type InsertResult = { name: string | null; snippet: string; source: string; item: string }

/** Pure: insert one component into `source` (an index.tsx) and return the new source. */
export function insertIntoSource(source: string, item: PaletteItem, input: Record<string, unknown> = {}): InsertResult {
  const close = source.lastIndexOf("</board>")
  if (close < 0) throw new Error("no <board>…</board> found in index.tsx (self-closing boards are not supported)")
  const names = usedNames(source)
  const hasName = item.props.some((p) => p.name === "name")
  const values: Record<string, unknown> = { ...input }
  if (hasName) {
    const given = typeof values.name === "string" ? values.name.trim() : ""
    if (given) {
      if (!/^[A-Za-z][\w-]*$/.test(given)) throw new Error(`invalid name "${given}"`)
      if (names.has(given)) throw new Error(`name "${given}" already exists in the design`)
    } else values.name = uniqueName(source, item.prefix || "X")
  }
  // default position: board centre, staggered so successive inserts do not stack exactly
  const k = (source.match(/\bpcb[XY]=/g)?.length ?? 0) / 2
  if (item.posProps) {
    const { x, y } = item.posProps
    if (values[x] === undefined || values[x] === "") values[x] = ((Math.floor(k) % 5) - 2) * 4
    if (y && (values[y] === undefined || values[y] === "")) values[y] = -((Math.floor(k / 5) % 5) - 2) * 4
  }
  const parts: string[] = []
  for (const spec of item.props) {
    let v = values[spec.name]
    if (v === undefined || v === "") v = spec.required ? spec.default : undefined
    // not emitted when it just restates a default (keeps the JSX short), except required/position props
    if (!spec.required && spec.default !== undefined && String(v) === String(spec.default) && !/^pcb[XY]$/.test(spec.name) && spec.name !== (item.posProps?.x) && spec.name !== item.posProps?.y) continue
    if (spec.name === "lcsc") continue
    const p = jsxProp(spec, v)
    if (p) parts.push(p)
    else if (spec.required && item.kind === "lib") throw new Error(`${spec.name} is required`)
  }
  const lcsc = String(values.lcsc ?? "").trim()
  if (lcsc) {
    if (!/^C\d+$/i.test(lcsc)) throw new Error(`invalid LCSC number "${lcsc}" (expected like C14663)`)
    parts.push(`supplierPartNumbers={{ jlcpcb: ["${lcsc.toUpperCase()}"] }}`)
  }
  const lineStart = source.lastIndexOf("\n", close) + 1
  const baseIndent = /^[ \t]*/.exec(source.slice(lineStart, close))![0]
  const indent = baseIndent + "  "
  const onlyWs = source.slice(lineStart, close).trim() === ""
  const snippet = `<${item.tag} ${parts.join(" ")} />`
  let out = onlyWs
    ? source.slice(0, lineStart) + indent + snippet + "\n" + source.slice(lineStart)
    : source.slice(0, close) + "\n" + indent + snippet + "\n" + baseIndent + source.slice(close)
  if (item.kind === "lib" && item.importPath) out = addImport(out, item.tag, item.importPath)
  return { name: hasName ? String(values.name) : null, snippet, source: out, item: item.id }
}

function addImport(src: string, comp: string, from: string): string {
  const re = new RegExp(`^import\\s*\\{([^}]*)\\}\\s*from\\s*["']${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'];?[ \\t]*$`, "m")
  const m = re.exec(src)
  if (m) {
    const have = m[1].split(",").map((s) => s.trim()).filter(Boolean)
    if (have.includes(comp)) return src
    return src.slice(0, m.index) + `import { ${[...have, comp].join(", ")} } from "${from}"` + src.slice(m.index + m[0].length)
  }
  const line = `import { ${comp} } from "${from}"`
  const imports = [...src.matchAll(/^import[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm)]
  if (!imports.length) return line + "\n" + src
  const last = imports[imports.length - 1]
  const end = last.index! + last[0].length
  return src.slice(0, end) + "\n" + line + src.slice(end)
}

export function findItem(id: string): PaletteItem | undefined {
  const { lib, primitives } = listPalette()
  return [...primitives, ...lib].find((i) => i.id === id || i.tag === id)
}

// ---------- JLC part search ----------

const BASE = "https://jlcsearch.tscircuit.com"
const KNOWN_FP = /^(0201|0402|0603|0805|1206|1210|2512|sot23|sot223|sot323|sod123|sod323|soic\d+|tssop\d+|ssop\d+|msop\d+|qfn\d+|dfn\d+|to92|to220|to252|dip\d+)$/

/** Map a JLC package string to a tscircuit footprint string when it is a plain standard one, else "". */
export function guessFootprint(pkg: string): string {
  let p = pkg.toLowerCase().replace(/[\s_]/g, "")
  p = p.replace(/^sot-?23-\d$/, "sot23").replace(/^sot-?23$/, "sot23").replace(/-/g, "")
  return KNOWN_FP.test(p) ? p : ""
}

export type PartHit = {
  lcsc: string; mfr: string; package: string; description: string; stock: number | null
  price: number | null; tier: "basic" | "preferred" | "extended"; footprint: string
}

export async function searchParts(q: string, limit = 20): Promise<PartHit[]> {
  const url = `${BASE}/api/search?q=${encodeURIComponent(q)}&limit=${Math.min(50, Math.max(1, limit))}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`jlcsearch ${res.status}`)
  const j: any = await res.json()
  return (j.components ?? []).map((c: any): PartHit => {
    const breaks = parseBreaks(c.price)
    return {
      lcsc: `C${c.lcsc}`, mfr: c.mfr ?? "", package: c.package ?? "", description: c.description ?? "",
      stock: typeof c.stock === "number" ? c.stock : null,
      price: breaks[0]?.price ?? null,
      tier: c.is_basic ? "basic" : c.is_preferred ? "preferred" : "extended",
      footprint: guessFootprint(c.package ?? ""),
    }
  })
}

// ---------- routes ----------

export function registerPalette(app: FastifyInstance) {
  app.get("/api/palette", async () => listPalette())

  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/parts/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim()
    if (q.length < 2) return reply.code(400).send({ error: "q must be at least 2 characters" })
    try {
      return await searchParts(q, parseInt(req.query.limit ?? "20", 10) || 20)
    } catch (e: any) {
      return reply.code(502).send({ error: `part search failed: ${e.message}` })
    }
  })

  // With `source` (the UI's unsaved editor text) nothing is written: the new source is returned.
  // Without it the design's index.tsx on disk is edited in place (the form Claude uses).
  app.post<{ Params: { name: string }; Body: InsertRequest }>("/api/designs/:name/components", async (req, reply) => {
    const { name } = req.params
    const full = NAME_RE.test(name) ? safeDesignPath(name, "index.tsx") : null
    if (!full || !fs.existsSync(full)) return reply.code(404).send({ error: "design not found" })
    const item = req.body?.item ? findItem(req.body.item) : undefined
    if (!item) return reply.code(400).send({ error: `unknown item "${req.body?.item}"; see GET /api/palette` })
    const inMemory = typeof req.body.source === "string"
    try {
      const r = insertIntoSource(inMemory ? req.body.source! : fs.readFileSync(full, "utf8"), item, req.body.props ?? {})
      if (!inMemory) fs.writeFileSync(full, r.source)
      return { ok: true, written: !inMemory, name: r.name, snippet: r.snippet, source: r.source }
    } catch (e: any) {
      return reply.code(422).send({ error: e.message })
    }
  })
}
