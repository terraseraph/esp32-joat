// Deterministic plain-English walkthrough of a board, grouped by function. No LLM involved:
// parts are classified from type / MPN / net names, then each group is phrased from templates.
import type { ComponentInfo, NetInfo } from "./inspect.js"

export type Sentence = { text: string; refs: string[] }
export type ExplainGroup = { id: string; title: string; sentences: Sentence[] }
export type Explain = { title: string; summary: string; groups: ExplainGroup[] }

const ORDER = [
  ["power", "Power input"],
  ["protection", "Protection"],
  ["monitoring", "Monitoring & indicators"],
  ["regulation", "Regulation & decoupling"],
  ["logic", "MCU & logic"],
  ["io", "I/O & drivers"],
  ["connectors", "Connectors"],
  ["other", "Other parts"],
] as const
type Gid = (typeof ORDER)[number][0]

const txt0 = (c: ComponentInfo) => `${c.type} ${c.mpn ?? ""}`
const isConnector = (c: ComponentInfo) => /header|terminal|connector|usb|jack/i.test(c.type + " " + (c.mpn ?? "")) || /^(J|P|CN|TB|X)\d*($|_)/i.test(c.ref)
const REG_MPN = /AMS1117|LDO|LM1117|LM2596|LM78|AP2112|AP7\d|TPS\d|MP\d{4}|XC6|RT9|SY8|ME6|HT7|XL\d{4}|LM3\d{2}|buck|boost/i
const PROT_MPN = /TVS|ESD|SMBJ|SMAJ|PRTR|USBLC|PESD|fuse|PTC|varistor|MOV|ferrite|bead/i
const MON_MPN = /INA\d|ADS\d|TMP\d|LM75|BME|BMP|SHT\d|MCP3|ACS7/i
const RELAY = /relay|SRD|G5Q|HF\d/i

function classify(c: ComponentInfo): Gid | "passive" {
  const txt = `${c.type} ${c.mpn ?? ""} ${c.value ?? ""}`
  if (c.type === "led") return "monitoring"
  if (MON_MPN.test(txt)) return "monitoring"
  if (c.type === "fuse" || PROT_MPN.test(txt) || c.type === "diode") return "protection"
  if (c.type === "inductor" || REG_MPN.test(txt)) return "regulation"
  if (c.type === "transistor" || RELAY.test(txt)) return "io"
  if (isConnector(c)) return "connectors"
  if (c.type === "chip") return "logic"
  if (c.type === "resistor" || c.type === "capacitor") return "passive"
  return "other"
}

/** "Q1, Q2, Q3, Q5" -> "Q1–Q3, Q5" */
export function compressRefs(refs: string[]): string {
  const parsed = refs.map((r) => ({ r, m: /^(.*?)(\d+)$/.exec(r) }))
  const out: string[] = []
  for (let i = 0; i < parsed.length; ) {
    const a = parsed[i]
    if (!a.m) { out.push(a.r); i++; continue }
    let j = i
    while (j + 1 < parsed.length && parsed[j + 1].m && parsed[j + 1].m![1] === a.m[1] && +parsed[j + 1].m![2] === +parsed[j].m![2] + 1) j++
    out.push(j - i >= 2 ? `${a.r}–${parsed[j].r}` : parsed.slice(i, j + 1).map((p) => p.r).join(", "))
    i = j + 1
  }
  return out.join(", ")
}

export function explain(meta: any, comps: ComponentInfo[], nets: NetInfo[]): Explain {
  const netByName = new Map(nets.map((n) => [n.name, n]))
  const kindOf = (name: string | null) => (name ? netByName.get(name)?.kind ?? "signal" : "signal")
  const membersOf = new Map<string, Set<string>>()
  for (const n of nets) membersOf.set(n.name, new Set(n.ports.map((p) => p.ref)))
  const byRef = new Map(comps.map((c) => [c.ref, c]))

  // 1. classify, then place passives next to the parts they serve
  const group = new Map<string, Gid>()
  for (const c of comps) {
    const g = classify(c)
    if (g !== "passive") group.set(c.ref, g)
  }
  const PRIORITY: Gid[] = ["io", "logic", "monitoring", "protection", "regulation", "power", "connectors"]
  for (const c of comps) {
    if (group.has(c.ref)) continue
    const local = Object.values(c.pins).filter((n): n is string => !!n && kindOf(n) === "signal" && (membersOf.get(n)?.size ?? 99) <= 8)
    const neighbours = local.flatMap((n) => [...(membersOf.get(n) ?? [])]).filter((r) => r !== c.ref && group.has(r)).map((r) => group.get(r)!)
    const pick = PRIORITY.find((g) => neighbours.includes(g))
    const rails = Object.values(c.pins).filter((n) => n && kindOf(n) !== "signal")
    group.set(c.ref, c.type === "capacitor" && rails.length >= 2 ? "regulation" : pick ?? (rails.length ? "regulation" : "other"))
  }
  // a connector that carries a supply rail is the board's power input
  for (const c of comps) {
    if (group.get(c.ref) === "connectors" && Object.values(c.pins).some((n) => kindOf(n) === "power")) group.set(c.ref, "power")
  }

  // 2. phrase
  // unnamed nets ("~U1.P0/RG1.pin1") read better as "the node shared with RG1"
  const disp = (c: ComponentInfo, n: string) => (n.startsWith("~") ? `node shared with ${[...(membersOf.get(n) ?? [])].filter((r) => r !== c.ref).join("/") || "itself"}` : n)
  const netsOf = (c: ComponentInfo) => [...new Set(Object.values(c.pins).filter((n): n is string => !!n).map((n) => disp(c, n)))]
  const sig = (c: ComponentInfo) => netsOf(c).filter((n) => kindOf(n) === "signal")
  const names = (list: string[], max = 6) => (list.length > max ? list.slice(0, max).join(", ") + ` and ${list.length - max} more` : list.join(", "))
  const role = (c: ComponentInfo): { key: string; text: string } => {
    const ns = netsOf(c)
    const k = ns.map(kindOf)
    const who = [c.mpn, c.value].filter(Boolean).join(" ") || c.type
    if (c.type === "resistor") {
      const s = sig(c)
      const rail = ns.find((n) => kindOf(n) === "power"), gnd = ns.find((n) => kindOf(n) === "ground")
      if (s.length === 1 && rail && s[0].startsWith("node shared")) return { key: `${who}|rser`, text: `${c.value ?? "resistor"} series resistor from ${rail} to the ${s[0].replace("node shared with ", "")} branch` }
      if (s.length === 1 && rail) return { key: `${who}|pullup`, text: `${c.value ?? "resistor"} pull-up from ${rail} to ${s[0]}` }
      if (s.length === 1 && gnd) return { key: `${who}|pulldown`, text: `${c.value ?? "resistor"} pull-down holds ${s[0]} low` }
      if (s.length === 2) return { key: `${who}|series`, text: `${c.value ?? "resistor"} in series between ${s[0]} and ${s[1]}` }
      if (s.length === 1 && ns.length === 2) return { key: `${who}|series`, text: `${c.value ?? "resistor"} on ${s[0]}` }
      return { key: `${who}|res`, text: `${c.value ?? "resistor"} between ${ns.join(" and ")}` }
    }
    if (c.type === "capacitor") {
      const rail = ns.find((n) => kindOf(n) === "power")
      return rail && k.includes("ground") ? { key: `${who}|decouple`, text: `${c.value ?? "capacitor"} decoupling on ${rail}` } : { key: `${who}|cap`, text: `${c.value ?? "capacitor"} on ${names(ns)}` }
    }
    if (c.type === "led") return { key: `${who}|led`, text: `${c.value ?? ""} LED indicator${sig(c).length ? ` on ${names(sig(c))}` : ""}`.replace("  ", " ") }
    if (c.type === "diode") return { key: `${who}|diode`, text: `${c.mpn ?? "diode"} clamp/flyback diode between ${names(ns)}` }
    if (c.type === "transistor") return { key: `${who}|fet`, text: `${c.mpn ?? "transistor"} ${c.value ?? ""} switch`.replace("  ", " ") + (sig(c).length ? ` driving ${names(sig(c))}` : "") }
    if (RELAY.test(txt0(c))) return { key: `${who}|relay`, text: `relay ${c.mpn ?? ""}: coil from ${disp(c, c.pins.COIL_A ?? "?")} to ${disp(c, c.pins.COIL_B ?? "?")}, contacts COM/NO/NC wired to ${[...new Set(["COM", "NO", "NC"].map((p) => disp(c, c.pins[p] ?? "?")))].join(", ")}`.replace("relay  ", "relay ") }
    if (isConnector(c)) return { key: `${who}|conn`, text: `${c.mpn ?? c.type} carrying ${names(ns.filter((n) => kindOf(n) !== "ground").concat(ns.some((n) => kindOf(n) === "ground") ? ["GND"] : []))}` }
    return { key: `${who}|${c.type}`, text: `${c.mpn ?? c.value ?? c.type} using ${names(sig(c))}` }
  }

  const groups: ExplainGroup[] = []
  for (const [gid, title] of ORDER) {
    const members = comps.filter((c) => group.get(c.ref) === gid)
    if (!members.length) continue
    const buckets = new Map<string, { role: ReturnType<typeof role>; items: ComponentInfo[] }>()
    for (const c of members) {
      const r = role(c)
      const b = buckets.get(r.key) ?? { role: r, items: [] }
      b.items.push(c)
      buckets.set(r.key, b)
    }
    const sentences: Sentence[] = []
    for (const { role: r, items } of buckets.values()) {
      const refs = items.map((i) => i.ref)
      const shown = compressRefs(refs)
      const extra = [...new Set(items.map((i) => i.footprint).filter(Boolean))].join("/")
      const lcsc = [...new Set(items.map((i) => i.lcsc).filter(Boolean))].join(", ")
      const detail = [extra, lcsc].filter(Boolean).join(", ")
      const text = items.length === 1
        ? `${items[0].ref}: ${r.text}${detail ? ` (${detail})` : ""}.`
        : `${items.length}× ${r.text.replace(/ (on|between|from|driving|carrying|using|in series between) .*$/, "")} (${shown}) — e.g. ${items[0].ref}: ${r.text}${detail ? ` (${detail})` : ""}.`
      sentences.push({ text, refs })
    }
    groups.push({ id: gid, title, sentences })
  }

  // 3. designer notes
  const notes = String(meta?.notes ?? "").trim()
  if (notes) {
    const parts = notes.split(/\s*\(\d+\)\s*/).map((s) => s.trim()).filter(Boolean)
    groups.push({ id: "notes", title: "Designer notes", sentences: parts.map((p) => ({ text: p, refs: [...new Set((p.match(/\b[A-Z][A-Za-z_]*\d+\b/g) ?? []).filter((r) => byRef.has(r)))] })) })
  }

  const counts = comps.length
  const power = nets.filter((n) => n.kind === "power").map((n) => n.name)
  return {
    title: meta?.name ?? "Board",
    summary: `${meta?.description ? meta.description + " " : ""}${counts} parts on ${nets.length} nets${power.length ? `; rails: ${power.join(", ")}` : ""}.`,
    groups,
  }
}
