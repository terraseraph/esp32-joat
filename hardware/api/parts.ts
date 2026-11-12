import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./build.js"

const CACHE_FILE = path.join(ROOT, ".cache", "parts.json")
const FRESH_MS = 24 * 3600 * 1000
const TIMEOUT_MS = 10000
const CONCURRENCY = 3
const BASE = "https://jlcsearch.tscircuit.com"

export type Part = {
  lcsc: string
  mfr: string
  package: string
  description: string
  stock: number | null
  basic: boolean
  preferred: boolean
  breaks: { min: number; price: number }[]
}

type Entry = { t: number; part: Part | null }
let store: Record<string, Entry> | null = null

function load() {
  if (store) return store
  try {
    store = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
  } catch {
    store = {}
  }
  return store!
}

function save() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 1))
  } catch {}
}

// jlcsearch rate-limits bursts (429 / Cloudflare 1101), so retry with backoff.
async function getJson(url: string, tries = 4): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      return await res.json()
    } catch (err) {
      if (attempt >= tries) throw err
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
}

export function parseBreaks(price: unknown): Part["breaks"] {
  if (typeof price === "number") return [{ min: 1, price }]
  if (typeof price !== "string") return []
  return price
    .split(",")
    .map((s) => {
      const [range, p] = s.split(":")
      return { min: parseInt(range, 10), price: parseFloat(p) }
    })
    .filter((b) => Number.isFinite(b.min) && Number.isFinite(b.price))
    .sort((a, b) => a.min - b.min)
}

/** Look up one part number (the only thing ever sent to the service). Null if not found; throws on network failure. */
async function fetchPart(lcsc: string): Promise<Part | null> {
  const num = Number(lcsc.replace(/^C/i, ""))
  const q = encodeURIComponent(lcsc)
  const list = await getJson(`${BASE}/components/list.json?search=${q}&limit=5`)
  let c = (list.components ?? []).find((x: any) => x.lcsc === num)
  let breaks = c ? parseBreaks(c.price) : []
  if (!c || !breaks.length) {
    const s = await getJson(`${BASE}/api/search?q=${q}&limit=5`)
    const sc = (s.components ?? []).find((x: any) => x.lcsc === num)
    if (sc) {
      c = { ...sc, ...(c ?? {}), stock: c?.stock ?? sc.stock }
      if (!breaks.length) breaks = parseBreaks(sc.price)
    }
  }
  if (!c) return null
  return {
    lcsc,
    mfr: c.mfr ?? "",
    package: c.package ?? "",
    description: c.description ?? "",
    stock: typeof c.stock === "number" ? c.stock : null,
    basic: !!c.is_basic,
    preferred: !!c.is_preferred,
    breaks,
  }
}

/** Parts for the given LCSC numbers; a failed lookup yields null (row is then "missing"). */
export async function lookupParts(lcscs: string[], refresh = false): Promise<Map<string, Part | null>> {
  const db = load()
  const out = new Map<string, Part | null>()
  const todo: string[] = []
  for (const id of new Set(lcscs)) {
    const e = db[id]
    if (!refresh && e && Date.now() - e.t < FRESH_MS) out.set(id, e.part)
    else todo.push(id)
  }
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
      while (i < todo.length) {
        const id = todo[i++]
        try {
          const part = await fetchPart(id)
          db[id] = { t: Date.now(), part }
          out.set(id, part)
        } catch {
          // keep a stale cached value if we have one, otherwise treat as missing
          out.set(id, db[id]?.part ?? null)
        }
      }
    }),
  )
  if (todo.length) save()
  return out
}

export function unitPriceAt(breaks: Part["breaks"], qty: number): number {
  let price = breaks[0]?.price ?? 0
  for (const b of breaks) if (b.min <= qty) price = b.price
  return price
}
