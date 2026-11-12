import { lookupParts, unitPriceAt } from "./parts.js"

// JLCPCB charges a loading fee per unique "extended" part type. Basic and
// "preferred extended" parts are exempt.
export const SETUP_FEE_PER_TYPE = 3

export type Row = {
  refs: string[]
  lcsc: string | null
  mfr: string
  package: string
  description: string
  qtyPerBoard: number
  unitPrice: number
  lineCostPerBoard: number
  stock: number | null
  basic: boolean
  preferred: boolean
  extended: boolean
  missing: boolean
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d

const lcscOf = (sc: any): string | null => {
  const v = sc.supplier_part_numbers?.jlcpcb?.[0]
  return v ? String(v).toUpperCase() : null
}

function commentOf(sc: any): string {
  return (
    sc.display_resistance ||
    sc.display_capacitance ||
    sc.display_inductance ||
    sc.manufacturer_part_number ||
    sc.display_value ||
    ""
  )
}

/** Natural sort so R2 < R10. */
const byRef = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

export type Group = { lcsc: string | null; comment: string; ftype: string; refs: string[] }

export function groupComponents(circuitJson: any[]): Group[] {
  const placed = new Set(circuitJson.filter((e) => e.type === "pcb_component").map((e) => e.source_component_id))
  const groups = new Map<string, Group>()
  for (const sc of circuitJson) {
    if (sc.type !== "source_component" || !sc.name || !placed.has(sc.source_component_id)) continue
    const lcsc = lcscOf(sc)
    const comment = commentOf(sc)
    const key = lcsc ?? `none:${sc.ftype}|${comment}`
    const g = groups.get(key) ?? { lcsc, comment, ftype: String(sc.ftype ?? "").replace(/^simple_/, ""), refs: [] }
    g.refs.push(sc.name)
    groups.set(key, g)
  }
  for (const g of groups.values()) g.refs.sort(byRef)
  return [...groups.values()].sort((a, b) => byRef(a.refs[0], b.refs[0]))
}

export async function computeBom(circuitJson: any[], qty: number, refresh: boolean) {
  const groups = groupComponents(circuitJson)
  const parts = await lookupParts(groups.flatMap((g) => (g.lcsc ? [g.lcsc] : [])), refresh)

  const rows: Row[] = groups.map((g) => {
    const part = g.lcsc ? (parts.get(g.lcsc) ?? null) : null
    const qtyPerBoard = g.refs.length
    const unitPrice = part ? unitPriceAt(part.breaks, qtyPerBoard * qty) : 0
    return {
      refs: g.refs,
      lcsc: g.lcsc,
      mfr: part?.mfr ?? "",
      package: part?.package ?? "",
      description: part?.description || g.comment || g.ftype,
      qtyPerBoard,
      unitPrice,
      lineCostPerBoard: round(unitPrice * qtyPerBoard),
      stock: part?.stock ?? null,
      basic: part?.basic ?? false,
      preferred: part?.preferred ?? false,
      extended: part ? !part.basic : false,
      missing: !part,
    }
  })

  const partsCostPerBoard = round(rows.reduce((s, r) => s + r.lineCostPerBoard, 0))
  const feeTypes = new Set(rows.filter((r) => r.lcsc && !r.missing && !r.basic && !r.preferred).map((r) => r.lcsc))
  const setupFees = feeTypes.size * SETUP_FEE_PER_TYPE
  const setupFeesPerBoard = round(setupFees / qty)
  return {
    qty,
    rows,
    summary: {
      partsCostPerBoard,
      extendedTypes: feeTypes.size,
      setupFeePerType: SETUP_FEE_PER_TYPE,
      setupFees,
      setupFeesPerBoard,
      costPerBoard: round(partsCostPerBoard + setupFeesPerBoard),
      totalAtQty: round(partsCostPerBoard * qty + setupFees, 2),
      missingCount: rows.filter((r) => r.missing).length,
    },
  }
}

/** JLCPCB assembly BOM. Footprint comes from the supplier package when known. */
export async function bomCsv(circuitJson: any[]): Promise<string> {
  const groups = groupComponents(circuitJson)
  const parts = await lookupParts(groups.flatMap((g) => (g.lcsc ? [g.lcsc] : [])))
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const lines = ["Comment,Designator,Footprint,LCSC Part #"]
  for (const g of groups) {
    const part = g.lcsc ? parts.get(g.lcsc) : null
    lines.push([q(g.comment || part?.mfr || g.ftype), q(g.refs.join(",")), q(part?.package ?? ""), g.lcsc ?? ""].join(","))
  }
  return lines.join("\r\n") + "\r\n"
}

/** JLCPCB pick-and-place file. */
export function cplCsv(circuitJson: any[]): string {
  const names = new Map<string, string>()
  for (const e of circuitJson) if (e.type === "source_component") names.set(e.source_component_id, e.name)
  const lines = ["Designator,Mid X,Mid Y,Layer,Rotation"]
  const comps = circuitJson
    .filter((e) => e.type === "pcb_component" && names.get(e.source_component_id))
    .map((e) => ({ ref: names.get(e.source_component_id)!, e }))
    .sort((a, b) => byRef(a.ref, b.ref))
  for (const { ref, e } of comps) {
    const rot = (((e.rotation ?? 0) % 360) + 360) % 360
    lines.push(
      [ref, `${round(e.center.x)}mm`, `${round(e.center.y)}mm`, e.layer === "bottom" ? "Bottom" : "Top", round(rot, 2)].join(","),
    )
  }
  return lines.join("\r\n") + "\r\n"
}
