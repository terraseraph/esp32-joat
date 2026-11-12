import fs from "node:fs"
import path from "node:path"
import { computeBom, groupComponents, SETUP_FEE_PER_TYPE } from "./bom.js"
import { ROOT, readDesignFiles } from "./build.js"
import { getJson, lookupParts, unitPriceAt, type Part } from "./parts.js"

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
  refs: string[]
  kind: string
  package: string
  current: { mfr: string; description: string; unitPrice: number; extended: boolean }
  alternative: { mfr: string; description: string; unitPrice: number; basic: boolean; preferred: boolean; stock: number | null }
  savingPerBoard: number
  savingTotal: number
  /** where the old LCSC number appears in source */
  where: { file: string; inDesign: boolean }[]
  canApply: boolean
  hint: string
}

const KINDS: Record<string, { endpoint: string; key?: (sc: any) => Record<string, string | number> | null }> = {
  resistor: {
    endpoint: "resistors",
    key: (sc) => (typeof sc.resistance === "number" ? { resistance: sc.resistance } : null),
  },
  capacitor: {
    endpoint: "capacitors",
    key: (sc) => (typeof sc.capacitance === "number" ? { capacitance: sc.capacitance } : null),
  },
  led: { endpoint: "leds" },
  diode: { endpoint: "diodes" },
}

const cache = new Map<string, { t: number; data: any }>()
async function cached(url: string) {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.t < 3600_000) return hit.data
  const data = await getJson(url)
  if (data?.error) throw new Error(data.message ?? data.error)
  cache.set(url, { t: Date.now(), data })
  return data
}

const sameNumber = (a: unknown, b: unknown) => {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= Math.abs(y) * 1e-6
}

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
    const sc = scByName.get(g.refs[0])
    const kind = String(sc?.ftype ?? "").replace(/^simple_/, "")
    const spec = KINDS[kind]
    if (!spec || !part.package) {
      skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: spec ? "no package known" : `no automatic matching for ${kind || "this part type"}` })
      continue
    }
    try {
      const params = new URLSearchParams({ package: part.package, limit: "60" })
      const keyed = spec.key?.(sc)
      if (spec.key && !keyed) { skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: "value not readable" }); continue }
      for (const [k, v] of Object.entries(keyed ?? {})) params.set(k, String(v))
      params.set("is_basic", "true")
      const basicList = (await cached(`${BASE}/${spec.endpoint}/list.json?${params}`))[spec.endpoint] ?? []
      params.delete("is_basic")
      params.set("is_preferred", "true")
      const prefList = (await cached(`${BASE}/${spec.endpoint}/list.json?${params}`))[spec.endpoint] ?? []

      let cands: any[] = [...basicList, ...prefList]
      cands = cands.filter((c) => c.package === part.package && c.lcsc !== Number(g.lcsc!.slice(1)) && (c.is_basic || c.is_preferred))
      if (keyed) for (const [k, v] of Object.entries(keyed)) cands = cands.filter((c) => sameNumber(c[k], v))
      if (kind === "led") cands = cands.filter((c) => c.color === ledColor(part.description))
      if (kind === "diode") {
        const t = diodeType(part.description)
        cands = cands.filter((c) => t === "" || (c.diode_type ?? "") === t)
      }
      if (kind === "capacitor") {
        // keep voltage rating and dielectric at least as good as the original
        const volt = voltage(part.description)
        cands = cands.filter((c) => {
          const v = voltage(c.description ?? "")
          return volt === null || (v !== null && v >= volt)
        })
        const diel = dielectric(part.description)
        if (diel) cands = cands.filter((c) => dielectric(c.description ?? "") === diel)
      }
      if (kind === "resistor") {
        const ptol = tolOf(part.description)
        cands = cands.filter((c) => (ptol === null || c.tolerance_fraction === null || c.tolerance_fraction <= ptol + 1e-9) && !c.is_potentiometer && !c.is_multi_resistor_chip)
      }
      cands = cands.filter((c) => c.stock !== 0)
      if (!cands.length) { skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: "no Basic/Preferred part with the same package and value" }); continue }
      cands.sort((a, b) => Number(!!b.is_basic) - Number(!!a.is_basic) || (a.price1 ?? 9) - (b.price1 ?? 9) || (b.stock ?? 0) - (a.stock ?? 0))
      const best = cands[0]
      const toId = `C${best.lcsc}`
      const altPart = (await lookupParts([toId])).get(toId) as Part | null
      const altUnit = altPart ? unitPriceAt(altPart.breaks, g.refs.length * qty) : (best.price1 ?? 0)
      const curUnit = unitPriceAt(part.breaks, g.refs.length * qty)
      const savingPerBoard = round(g.refs.length * (curUnit - altUnit) + SETUP_FEE_PER_TYPE / qty, 4)
      const where = findLcscSources(name, g.lcsc!)
      swaps.push({
        from: g.lcsc!, to: toId, refs: g.refs, kind, package: part.package,
        current: { mfr: part.mfr, description: part.description, unitPrice: curUnit, extended: true },
        alternative: { mfr: best.mfr ?? "", description: best.description ?? "", unitPrice: altUnit, basic: !!best.is_basic, preferred: !!best.is_preferred, stock: best.stock ?? null },
        savingPerBoard, savingTotal: round(savingPerBoard * qty), where,
        canApply: where.some((w) => w.inDesign),
        hint: where.some((w) => w.inDesign) ? "" : where.length ? `Change the LCSC number in ${where.map((w) => w.file).join(", ")} (shared block, affects every design using it)` : "LCSC number not found in source",
      })
    } catch (e: any) {
      skipped.push({ lcsc: g.lcsc!, refs: g.refs, reason: `lookup failed: ${e.message}` })
    }
  }
  return { qty, swaps: swaps.sort((a, b) => b.savingTotal - a.savingTotal), skipped }
}

// helpers parsing the supplier description string
const ledColor = (d: string) => (/(red|green|blue|yellow|white|orange|amber)/i.exec(d)?.[1] ?? "").toLowerCase()
const diodeType = (d: string) => (/schottky/i.test(d) ? "schottky" : /zener/i.test(d) ? "zener" : /tvs/i.test(d) ? "tvs" : "")
const voltage = (d: string): number | null => {
  const m = /(\d+(?:\.\d+)?)\s*V\b/.exec(d)
  return m ? Number(m[1]) : null
}
const dielectric = (d: string) => /\b(X7R|X5R|C0G|NP0|X7S|Y5V)\b/i.exec(d)?.[1]?.toUpperCase().replace("NP0", "C0G") ?? null
const tolOf = (d: string): number | null => {
  const m = /±\s*(\d+(?:\.\d+)?)\s*%/.exec(d)
  return m ? Number(m[1]) / 100 : null
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
