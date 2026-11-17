import fs from "node:fs"
import path from "node:path"
import { computeBom, groupComponents, SETUP_FEE_PER_TYPE } from "./bom.js"
import { ROOT, readDesignFiles } from "./build.js"
import { getJson, lookupParts, unitPriceAt, type Part } from "./parts.js"
import { getRotationBetweenPcbPin1Locations } from "circuit-json"

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d
const BASE = "https://jlcsearch.tscircuit.com"

// ---------------------------------------------------------------- board facts

export function boardInfo(circuitJson: any[]) {
  const b = circuitJson.find((e) => e.type === "pcb_board")
  let width = Number(b?.width) || 0
  let height = Number(b?.height) || 0
  let outline: { x: number; y: number }[] | null = null
  if (Array.isArray(b?.outline) && b.outline.length >= 3) {
    outline = b.outline.map((p: any) => ({ x: p.x, y: p.y }))
    const xs = outline!.map((p) => p.x)
    const ys = outline!.map((p) => p.y)
    width = Math.max(...xs) - Math.min(...xs)
    height = Math.max(...ys) - Math.min(...ys)
  }
  return {
    width: round(width, 2),
    height: round(height, 2),
    center: { x: b?.center?.x ?? 0, y: b?.center?.y ?? 0 },
    layers: Number(b?.num_layers) || 2,
    outline,
  }
}

// ---------------------------------------------------------------- fab + assembly estimate
// Rough JLCPCB list-price model (USD, standard lead time, shipping and tax excluded). Constants are
// approximations of the public price tables and are meant for budgeting, not quoting.
export const ESTIMATE = {
  fabPerCm2: { 2: 0.0045, 4: 0.018, 6: 0.04 } as Record<number, number>, // per board-cm2, qty-independent slope
  fabMin: { 2: 2, 4: 7, 6: 20 } as Record<number, number>, // minimum order price
  assemblySetup: 8, // economic assembly setup
  stencil: 1.5,
  perJoint: 0.0017,
  perPlacement: 0.0173,
}

export function estimateFab(circuitJson: any[], qty: number) {
  const info = boardInfo(circuitJson)
  const layers = [2, 4, 6].includes(info.layers) ? info.layers : info.layers > 6 ? 6 : info.layers > 2 ? 4 : 2
  const cm2 = (info.width * info.height) / 100
  const fab = Math.max(ESTIMATE.fabMin[layers], cm2 * qty * ESTIMATE.fabPerCm2[layers])

  const placed = circuitJson.filter((e) => e.type === "pcb_component")
  const placedIds = new Set(placed.map((e) => e.pcb_component_id))
  const joints = circuitJson.filter(
    (e) => (e.type === "pcb_smtpad" || e.type === "pcb_plated_hole") && placedIds.has(e.pcb_component_id),
  ).length
  const assemblyOnce = ESTIMATE.assemblySetup + ESTIMATE.stencil
  const assemblyPerBoard = joints * ESTIMATE.perJoint + placed.length * ESTIMATE.perPlacement
  const assembly = assemblyOnce + assemblyPerBoard * qty
  return {
    estimate: true,
    layers,
    widthMm: info.width,
    heightMm: info.height,
    areaCm2: round(cm2, 1),
    placements: placed.length,
    joints,
    fabTotal: round(fab),
    assemblyTotal: round(assembly),
    fabPerBoard: round(fab / qty),
    assemblyPerBoard: round(assembly / qty),
    note: "Rough JLCPCB list-price estimate; shipping, tax and promos excluded.",
  }
}

export async function costSummary(circuitJson: any[], qty: number, refresh = false) {
  const bom = await computeBom(circuitJson, qty, refresh)
  const fab = estimateFab(circuitJson, qty)
  const s = bom.summary
  const partsPerBoard = s.costPerBoard // parts + extended fees
  const estPerBoard = round(partsPerBoard + fab.fabPerBoard + fab.assemblyPerBoard)
  return {
    qty,
    partsCostPerBoard: s.partsCostPerBoard,
    extendedFeesPerBoard: s.setupFeesPerBoard,
    extendedTypes: s.extendedTypes,
    missingCount: s.missingCount,
    partsPerBoard: round(partsPerBoard),
    partsTotal: s.totalAtQty,
    fab,
    estimatedPerBoard: estPerBoard,
    estimatedTotal: round(s.totalAtQty + fab.fabTotal + fab.assemblyTotal),
  }
}

// ---------------------------------------------------------------- swap to Basic

type Swap = {
  from: string
  to: string
  /** every ref sharing the old part number in the BOM */
  refs: string[]
  /** refs whose part is written directly in the design files (these change on Apply) */
  designRefs: string[]
  /** refs that come from a lib/ block and keep the old part until that block changes */
  libRefs: string[]
  kind: string
  package: string
  current: { mfr: string; description: string; unitPrice: number; extended: boolean }
  alternative: { mfr: string; description: string; unitPrice: number; basic: boolean; preferred: boolean; stock: number | null }
  /** savings from the refs Apply would actually change */
  savingPerBoard: number
  savingTotal: number
  /** where the old LCSC number appears in source */
  where: { file: string; inDesign: boolean }[]
  canApply: boolean
  hint: string
}

// Only part families where jlcsearch returns structured specs we can compare. Diodes are deliberately
// excluded: its diode type and ratings are unreliable (zeners come back as "general_purpose", ratings null).
const ENDPOINT: Record<string, string> = { resistor: "resistors", capacitor: "capacitors", led: "leds" }

const cache = new Map<string, { t: number; data: any }>()
async function cached(url: string) {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.t < 3600_000) return hit.data
  const data = await getJson(url)
  if (data?.error) throw new Error(data.message ?? data.error)
  cache.set(url, { t: Date.now(), data })
  return data
}

const same = (a: unknown, b: unknown) => {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= Math.abs(y) * 1e-6
}
const known = (...v: unknown[]) => v.every((x) => x !== null && x !== undefined && x !== "")
const num = (x: unknown) => Number(x)

/** All places an LCSC number appears in source: design files, then lib blocks. */
export function findLcscSources(name: string, lcsc: string) {
  const re = new RegExp(`["']${lcsc}["']`, "i")
  const out: { file: string; inDesign: boolean }[] = []
  for (const [rel, content] of Object.entries(readDesignFiles(name))) if (re.test(content)) out.push({ file: `designs/${name}/${rel}`, inDesign: true })
  const lib = path.join(ROOT, "lib")
  if (fs.existsSync(lib))
    for (const f of fs.readdirSync(lib))
      if (/\.tsx?$/.test(f) && re.test(fs.readFileSync(path.join(lib, f), "utf8"))) out.push({ file: `lib/${f}`, inDesign: false })
  return out
}

/** Does this ref appear as a literal name="REF" in a design file that holds the LCSC number? */
function designOwnsRef(name: string, lcsc: string, ref: string) {
  const re = new RegExp(`["']${lcsc}["']`, "i")
  const nm = new RegExp(`name=(["'])${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`)
  return Object.values(readDesignFiles(name)).some((c) => re.test(c) && nm.test(c))
}

/** Is `c` a safe drop-in for `o` (the part ordered today)? Unknown specs on either side reject it. */
function compatible(kind: string, o: any, c: any): boolean {
  if (c.package !== o.package) return false
  if (kind === "resistor") {
    return (
      known(o.resistance, c.resistance, o.tolerance_fraction, c.tolerance_fraction, o.power_watts, c.power_watts) &&
      same(c.resistance, o.resistance) &&
      num(c.tolerance_fraction) <= num(o.tolerance_fraction) + 1e-9 &&
      num(c.power_watts) >= num(o.power_watts) &&
      !c.is_potentiometer && !c.is_multi_resistor_chip && !o.is_potentiometer && !o.is_multi_resistor_chip
    )
  }
  if (kind === "capacitor") {
    return (
      known(o.capacitance_farads, c.capacitance_farads, o.voltage_rating, c.voltage_rating, o.temperature_coefficient, c.temperature_coefficient, o.tolerance_fraction, c.tolerance_fraction) &&
      same(c.capacitance_farads, o.capacitance_farads) &&
      num(c.voltage_rating) >= num(o.voltage_rating) &&
      String(c.temperature_coefficient).toUpperCase() === String(o.temperature_coefficient).toUpperCase() &&
      num(c.tolerance_fraction) <= num(o.tolerance_fraction) + 1e-9 &&
      !!c.is_polarized === !!o.is_polarized &&
      (c.capacitor_type ?? "") === (o.capacitor_type ?? "")
    )
  }
  if (kind === "led") {
    return (
      known(o.color, c.color) &&
      c.color === o.color &&
      !!c.is_rgb === !!o.is_rgb &&
      (!known(o.luminous_intensity_mcd, c.luminous_intensity_mcd) || num(c.luminous_intensity_mcd) >= num(o.luminous_intensity_mcd)) &&
      (!known(o.wavelength_nm, c.wavelength_nm) || Math.abs(num(c.wavelength_nm) - num(o.wavelength_nm)) <= 5)
    )
  }
  return false
}

export async function swapSuggestions(name: string, circuitJson: any[], qty: number): Promise<{ qty: number; swaps: Swap[]; skipped: { lcsc: string; refs: string[]; reason: string }[] }> {
  const groups = groupComponents(circuitJson).filter((g) => g.lcsc)
  const parts = await lookupParts(groups.map((g) => g.lcsc!))
  const scByName = new Map<string, any>()
  for (const e of circuitJson) if (e.type === "source_component" && e.name) scByName.set(e.name, e)

  const swaps: Swap[] = []
  const skipped: { lcsc: string; refs: string[]; reason: string }[] = []
  for (const g of groups) {
    const part = parts.get(g.lcsc!)
    if (!part || part.basic || part.preferred) continue
    const kind = String(scByName.get(g.refs[0])?.ftype ?? "").replace(/^simple_/, "")
    const endpoint = ENDPOINT[kind]
    if (!endpoint) { skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: `no automatic matching for ${kind || "this part type"}` }); continue }
    try {
      const id = Number(g.lcsc!.slice(1))
      // The part ordered today, with structured specs. jlcsearch cannot filter by LCSC number, so look it up
      // among the (max 100) parts with the same package and value taken from the design.
      const sc = scByName.get(g.refs[0])
      const find = new URLSearchParams({ package: part.package, limit: "100" })
      if (kind === "resistor" && typeof sc?.resistance === "number") find.set("resistance", String(sc.resistance))
      if (kind === "capacitor" && typeof sc?.capacitance === "number") find.set("capacitance", String(sc.capacitance))
      const orig = part.package ? ((await cached(`${BASE}/${endpoint}/list.json?${find}`))[endpoint] ?? []).find((x: any) => x.lcsc === id) : null
      if (!orig || !orig.package) { skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: "original part's specs could not be read from jlcsearch" }); continue }
      const params = new URLSearchParams({ package: orig.package, limit: "60" })
      if (kind === "resistor") params.set("resistance", String(orig.resistance))
      if (kind === "capacitor") params.set("capacitance", String(orig.capacitance_farads))
      if (kind === "led") params.set("color", String(orig.color))
      let cands: any[] = []
      for (const flag of ["is_basic", "is_preferred"]) {
        params.set(flag, "true")
        cands.push(...((await cached(`${BASE}/${endpoint}/list.json?${params}`))[endpoint] ?? []))
        params.delete(flag)
      }
      const needed = qty * g.refs.length
      cands = cands.filter(
        (c) => c.lcsc !== id && (c.is_basic || c.is_preferred) && c.in_stock === true && (c.stock === null || c.stock === undefined || c.stock >= needed) && compatible(kind, orig, c),
      )
      if (!cands.length) { skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: "no in-stock Basic/Preferred part with matching package and specs" }); continue }
      cands.sort((a, b) => Number(!!b.is_basic) - Number(!!a.is_basic) || (a.price1 ?? 9) - (b.price1 ?? 9) || (b.stock ?? 0) - (a.stock ?? 0))
      const best = cands[0]
      const toId = `C${best.lcsc}`
      const altPart = (await lookupParts([toId])).get(toId) as Part | null

      const designRefs = g.refs.filter((r) => designOwnsRef(name, g.lcsc!, r))
      const libRefs = g.refs.filter((r) => !designRefs.includes(r))
      const where = findLcscSources(name, g.lcsc!)
      const altUnit = altPart ? unitPriceAt(altPart.breaks, g.refs.length * qty) : (best.price1 ?? 0)
      const curUnit = unitPriceAt(part.breaks, g.refs.length * qty)
      // the $3 extended fee only disappears once no ref uses the old part
      const fee = libRefs.length === 0 ? SETUP_FEE_PER_TYPE / qty : 0
      const savingPerBoard = round(designRefs.length * (curUnit - altUnit) + fee, 4)
      const libFiles = where.filter((w) => !w.inDesign).map((w) => w.file)
      swaps.push({
        from: g.lcsc!, to: toId, refs: g.refs, designRefs, libRefs, kind, package: orig.package,
        current: { mfr: part.mfr, description: part.description, unitPrice: curUnit, extended: true },
        alternative: { mfr: best.mfr ?? "", description: best.description ?? "", unitPrice: altUnit, basic: !!best.is_basic, preferred: !!best.is_preferred, stock: best.stock ?? null },
        savingPerBoard, savingTotal: round(savingPerBoard * qty), where,
        canApply: designRefs.length > 0,
        hint: designRefs.length === 0
          ? `Change the LCSC number in ${libFiles.join(", ") || "its source"} (shared block, affects every design using it)`
          : libRefs.length
            ? `${libRefs.join(", ")} come from ${libFiles.join(", ") || "a lib block"} and keep the old part; change it there too (shared block). Savings shown cover ${designRefs.join(", ")} only.`
            : "",
      })
    } catch (e: any) {
      skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: `lookup failed: ${e.message}` })
    }
  }
  return { qty, swaps: swaps.sort((a, b) => b.savingTotal - a.savingTotal), skipped }
}

/** Rewrite one LCSC number to another in every design file (lib files are reported, never edited). */
export function applySwap(name: string, from: string, to: string) {
  if (!/^C\d+$/i.test(from) || !/^C\d+$/i.test(to)) throw Object.assign(new Error("invalid LCSC number"), { statusCode: 400 })
  const re = new RegExp(`(["'])${from}\\1`, "gi")
  const changed: Record<string, string> = {}
  for (const [rel, content] of Object.entries(readDesignFiles(name))) {
    if (!/\.tsx?$/.test(rel) || !re.test(content)) continue
    re.lastIndex = 0
    changed[rel] = content.replace(re, `$1${to.toUpperCase()}$1`)
  }
  for (const [rel, content] of Object.entries(changed)) fs.writeFileSync(path.join(ROOT, "designs", name, rel), content)
  const libFiles = findLcscSources(name, from).filter((w) => !w.inDesign).map((w) => w.file)
  return { changed, libFiles }
}

// ---------------------------------------------------------------- preflight + CPL preview

export function cplPreview(circuitJson: any[]) {
  const names = new Map<string, string>()
  for (const e of circuitJson) if (e.type === "source_component") names.set(e.source_component_id, e.name)
  const pads = new Map<string, any[]>()
  for (const e of circuitJson) {
    if ((e.type === "pcb_smtpad" || e.type === "pcb_plated_hole") && e.pcb_component_id) {
      const hints: string[] = e.port_hints ?? []
      const pin1 = hints.some((h) => /^(pin)?1$/i.test(h))
      const w = e.width ?? e.rect_pad_width ?? e.outer_diameter ?? e.hole_diameter ?? 0.5
      const h = e.height ?? e.rect_pad_height ?? e.outer_diameter ?? e.hole_diameter ?? 0.5
      const list = pads.get(e.pcb_component_id) ?? []
      list.push({ x: round(e.x, 3), y: round(e.y, 3), w: round(w, 3), h: round(h, 3), round: e.shape === "circle", pin1 })
      pads.set(e.pcb_component_id, list)
    }
  }
  return circuitJson
    .filter((e) => e.type === "pcb_component" && names.get(e.source_component_id))
    .map((e) => ({
      ref: names.get(e.source_component_id)!,
      x: round(e.center.x, 3),
      y: round(e.center.y, 3),
      w: round(e.width ?? 1, 3),
      h: round(e.height ?? 1, 3),
      rotation: round((((e.rotation ?? 0) % 360) + 360) % 360, 2),
      layer: e.layer === "bottom" ? "bottom" : "top",
      pads: pads.get(e.pcb_component_id) ?? [],
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
}

export function preflight(circuitJson: any[], build: { errors: any[]; warnings: any[] }) {
  const info = boardInfo(circuitJson)
  const groups = groupComponents(circuitJson)
  const missingLcsc = groups.filter((g) => !g.lcsc).flatMap((g) => g.refs)
  const checks: { level: "ok" | "warn" | "bad"; text: string }[] = []
  checks.push({ level: "ok", text: `${info.layers}-layer board, ${info.width} × ${info.height} mm` })
  checks.push({ level: "ok", text: `${groups.reduce((n, g) => n + g.refs.length, 0)} parts in ${groups.length} BOM lines` })
  checks.push(missingLcsc.length ? { level: "warn", text: `${missingLcsc.length} part(s) without an LCSC number: ${missingLcsc.join(", ")}` } : { level: "ok", text: "Every part has an LCSC number" })
  checks.push(build.errors.length ? { level: "bad", text: `${build.errors.length} build error(s): ${build.errors.slice(0, 3).map((e) => e.message).join("; ")}` } : { level: "ok", text: "No build errors" })
  if (build.warnings.length) checks.push({ level: "warn", text: `${build.warnings.length} build warning(s)` })
  const cpl = cplPreview(circuitJson)
  return { layers: info.layers, widthMm: info.width, heightMm: info.height, partCount: cpl.length, bomLines: groups.length, missingLcsc, errors: build.errors.length, warnings: build.warnings.length, checks, board: { center: info.center, width: info.width, height: info.height, outline: info.outline }, cpl }
}

// ---------------------------------------------------------------- JLCPCB pick-and-place with rotation correction
// JLCPCB places each part in the orientation of its own library footprint, which can differ from the
// footprint drawn here. tscircuit records where pin 1 sits on both (`pin1_location` for the authored
// footprint, `supplier_pin1_location_map.jlcpcb` read from the JLC/EasyEDA footprint), so the offset is
// the rotation between the two. This is the same rule as circuit-json-to-pnp-csv; it is repeated here so
// every row carries what was applied and whether it could be verified.

export type CplRow = {
  ref: string
  x: number
  y: number
  layer: "top" | "bottom"
  /** rotation of the part on this board */
  pcbRotation: number
  /** rotation written to cpl.csv */
  rotation: number
  /** degrees added to pcbRotation */
  adjustment: number
  status: "verified" | "override" | "unverified"
  /** why an unverified row has no correction */
  reason?: string
}

const norm = (deg: number) => round(((deg % 360) + 360) % 360, 2)

/** `overrides` maps a ref to the exact rotation to write (for parts fixed by hand after a JLC placement review). */
export function jlcCplRows(circuitJson: any[], overrides: Record<string, number> = {}): CplRow[] {
  const names = new Map<string, string>()
  for (const e of circuitJson) if (e.type === "source_component") names.set(e.source_component_id, e.name)
  return circuitJson
    .filter((e) => e.type === "pcb_component" && names.get(e.source_component_id) && !e.do_not_place)
    .map((e): CplRow => {
      const ref = names.get(e.source_component_id)!
      const pcbRotation = norm(e.rotation ?? 0)
      const base = { ref, x: round(e.center.x, 4), y: round(e.center.y, 4), layer: (e.layer === "bottom" ? "bottom" : "top") as "top" | "bottom", pcbRotation }
      if (Number.isFinite(overrides[ref])) return { ...base, rotation: norm(overrides[ref]), adjustment: norm(overrides[ref] - pcbRotation), status: "override" }
      const mine = e.pin1_location
      const theirs = e.supplier_pin1_location_map?.jlcpcb
      const reason = !mine ? "pin 1 position of this footprint is unknown" : !theirs ? "no JLCPCB footprint to compare against" : null
      const adj = reason ? null : getRotationBetweenPcbPin1Locations(theirs, mine)
      if (adj === null) return { ...base, rotation: pcbRotation, adjustment: 0, status: "unverified", reason: reason ?? "pin 1 frames cannot be matched by rotation" }
      return { ...base, rotation: norm(pcbRotation + adj), adjustment: adj, status: "verified" }
    })
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
}

export function jlcCplCsv(rows: CplRow[]): string {
  const lines = ["Designator,Mid X,Mid Y,Layer,Rotation"]
  for (const r of rows) lines.push([r.ref, `${r.x}mm`, `${r.y}mm`, r.layer === "bottom" ? "Bottom" : "Top", r.rotation].join(","))
  return lines.join("\r\n") + "\r\n"
}

// ---------------------------------------------------------------- stock at the order quantity

export type StockLine = {
  lcsc: string
  refs: string[]
  needed: number
  stock: number | null
  /** short: stock below need. tight: under twice the need. unknown: catalogue gave no stock figure. */
  state: "ok" | "tight" | "short" | "unknown"
  alternates: { lcsc: string; mfr: string; description: string; stock: number | null; unitPrice: number; basic: boolean; preferred: boolean }[]
  /** why no alternates are offered */
  note?: string
}

type BomRowLike = { refs: string[]; lcsc: string | null; qtyPerBoard: number; stock: number | null; missing: boolean }

/** Stock per BOM line against boards x parts per board. JLCPCB's own attrition allowance is not included. */
export function stockCheck(rows: BomRowLike[], qty: number): StockLine[] {
  return rows
    .filter((r) => r.lcsc && !r.missing)
    .map((r) => {
      const needed = r.qtyPerBoard * qty
      const state = r.stock === null ? "unknown" : r.stock < needed ? "short" : r.stock < needed * 2 ? "tight" : "ok"
      return { lcsc: r.lcsc!, refs: r.refs, needed, stock: r.stock, state, alternates: [] }
    })
}

/**
 * Second pass over lines that are short or have no stock figure. jlcsearch's general lookup often returns no
 * stock, but its resistor, capacitor and LED lists do, so those lines get a figure from there, and short ones
 * get up to three in-stock parts with matching specs. Other part types keep "unknown" with a note.
 */
export async function suggestAlternates(circuitJson: any[], lines: StockLine[]): Promise<StockLine[]> {
  const todo = lines.filter((l) => l.state === "short" || l.state === "unknown")
  if (!todo.length) return lines
  const scByName = new Map<string, any>()
  for (const e of circuitJson) if (e.type === "source_component" && e.name) scByName.set(e.name, e)
  const parts = await lookupParts(todo.map((l) => l.lcsc))
  for (const line of todo) {
    const sc = scByName.get(line.refs[0])
    const kind = String(sc?.ftype ?? "").replace(/^simple_/, "")
    const endpoint = ENDPOINT[kind]
    const part = parts.get(line.lcsc)
    if (!endpoint || !part?.package) {
      line.note = line.state === "unknown"
        ? "The catalogue has no stock figure for this part; check it on JLCPCB's parts page."
        : `No automatic match for ${kind || "this part type"}; search the JLC tab for a part with the same footprint and pinout.`
      continue
    }
    try {
      const id = Number(line.lcsc.slice(1))
      const find = new URLSearchParams({ package: part.package, limit: "100" })
      if (kind === "resistor" && typeof sc?.resistance === "number") find.set("resistance", String(sc.resistance))
      if (kind === "capacitor" && typeof sc?.capacitance === "number") find.set("capacitance", String(sc.capacitance))
      const all: any[] = (await cached(`${BASE}/${endpoint}/list.json?${find}`))[endpoint] ?? []
      const orig = all.find((x) => x.lcsc === id)
      if (line.state === "unknown") {
        if (typeof orig?.stock !== "number") { line.note = "The catalogue has no stock figure for this part; check it on JLCPCB's parts page."; continue }
        line.stock = orig.stock
        line.state = orig.stock < line.needed ? "short" : orig.stock < line.needed * 2 ? "tight" : "ok"
        if (line.state !== "short") continue
      }
      if (!orig) { line.note = "The part's specs could not be read from jlcsearch, so no safe match is offered."; continue }
      const cands = all
        .filter((c) => c.lcsc !== id && c.in_stock === true && typeof c.stock === "number" && c.stock >= line.needed && compatible(kind, orig, c))
        .sort((a, b) => Number(!!b.is_basic) - Number(!!a.is_basic) || Number(!!b.is_preferred) - Number(!!a.is_preferred) || (a.price1 ?? 9) - (b.price1 ?? 9))
        .slice(0, 3)
      line.alternates = cands.map((c) => ({ lcsc: `C${c.lcsc}`, mfr: c.mfr ?? "", description: c.description ?? "", stock: c.stock ?? null, unitPrice: c.price1 ?? 0, basic: !!c.is_basic, preferred: !!c.is_preferred }))
      if (!cands.length) line.note = `No in-stock part with the same package and specs has ${line.needed} available.`
    } catch (e: any) {
      line.note = `Alternate lookup failed: ${e.message}`
    }
  }
  return lines
}

// ---------------------------------------------------------------- quote

export type Quote = {
  /** always "local-estimate": this is the list-price model above, not a vendor quote */
  source: "local-estimate"
  label: string
  currency: "USD"
  estimatedAt: string
  qty: number
  parts: number
  extendedFees: number
  fab: number
  assembly: number
  subtotal: number
  /** null amount = not entered yet */
  shipping: { method: string; amount: number | null }
  tax: { ratePct: number | null; amount: number | null }
  /** subtotal + shipping + tax, counting unknown amounts as 0 */
  total: number
  /** false while shipping or tax is still unknown */
  complete: boolean
  unpricedParts: number
  note: string
}

type CostLike = { qty: number; partsCostPerBoard: number; extendedFeesPerBoard: number; missingCount: number; fab: { fabTotal: number; assemblyTotal: number } }
export type QuoteExtras = { assembly?: boolean; shipping?: { method?: string; amount?: number | null }; tax?: { ratePct?: number | null; amount?: number | null } }

/** Local estimate plus user-entered shipping and tax. Tax is `ratePct` of subtotal + shipping unless `amount` is given. */
export function makeQuote(cost: CostLike, extra: QuoteExtras = {}): Quote {
  const assemble = extra.assembly !== false
  const parts = assemble ? round(cost.partsCostPerBoard * cost.qty) : 0
  const extendedFees = assemble ? round(cost.extendedFeesPerBoard * cost.qty) : 0
  const assembly = assemble ? cost.fab.assemblyTotal : 0
  const subtotal = round(parts + extendedFees + cost.fab.fabTotal + assembly)
  const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? round(v) : null)
  const shipAmount = money(extra.shipping?.amount)
  const ratePct = money(extra.tax?.ratePct)
  const taxAmount = money(extra.tax?.amount) ?? (ratePct !== null && shipAmount !== null ? round(((subtotal + shipAmount) * ratePct) / 100) : null)
  return {
    source: "local-estimate",
    label: "Local estimate, not a vendor quote",
    currency: "USD",
    estimatedAt: new Date().toISOString(),
    qty: cost.qty,
    parts, extendedFees, fab: cost.fab.fabTotal, assembly, subtotal,
    shipping: { method: String(extra.shipping?.method ?? "").slice(0, 80), amount: shipAmount },
    tax: { ratePct, amount: taxAmount },
    total: round(subtotal + (shipAmount ?? 0) + (taxAmount ?? 0)),
    complete: shipAmount !== null && taxAmount !== null,
    unpricedParts: assemble ? cost.missingCount : 0,
    note: "Parts are jlcsearch prices; fab and assembly are a rough JLCPCB list-price model. Shipping and tax are whatever you entered; the vendor's checkout is the real figure.",
  }
}
