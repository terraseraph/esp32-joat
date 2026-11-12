export type Meta = { name?: string; description?: string; revision?: string; notes?: string } | null
export type DesignSummary = { name: string; meta: Meta }
export type Design = { name: string; meta: Meta; files: Record<string, string> }
export type Issue = { type: string; message: string; stack?: string }
export type BuildResult = { ok: boolean; circuitJson: any[]; errors: Issue[]; warnings: Issue[]; durationMs: number }
export type BomRow = {
  refs: string[]; lcsc: string; mfr: string; package: string; description: string
  qtyPerBoard: number; unitPrice: number; lineCostPerBoard: number; stock: number
  basic: boolean; preferred: boolean; extended: boolean; missing: boolean
}
export type BomSummary = {
  partsCostPerBoard: number; extendedTypes: number; setupFeePerType: number; setupFees: number
  setupFeesPerBoard: number; costPerBoard: number; totalAtQty: number; missingCount: number
}
export type Bom = { qty: number; rows: BomRow[]; summary: BomSummary }
export type Cost = {
  qty: number; partsCostPerBoard: number; extendedFeesPerBoard: number; extendedTypes: number; missingCount: number
  partsPerBoard: number; partsTotal: number; estimatedPerBoard: number; estimatedTotal: number
  fab: { layers: number; widthMm: number; heightMm: number; placements: number; fabTotal: number; assemblyTotal: number; fabPerBoard: number; assemblyPerBoard: number; note: string }
}
export type Swap = {
  from: string; to: string; refs: string[]; kind: string; package: string
  current: { mfr: string; unitPrice: number }; alternative: { mfr: string; unitPrice: number; basic: boolean; preferred: boolean; stock: number | null }
  designRefs: string[]; libRefs: string[]
  savingPerBoard: number; savingTotal: number; canApply: boolean; hint: string
}
export type Swaps = { qty: number; swaps: Swap[]; skipped: { lcsc: string; refs: string[]; reason: string }[] }
export type CplPart = { ref: string; x: number; y: number; w: number; h: number; rotation: number; layer: "top" | "bottom"; pads: { x: number; y: number; w: number; h: number; round: boolean; pin1: boolean }[] }
export type Preflight = {
  layers: number; widthMm: number; heightMm: number; partCount: number; bomLines: number; missingLcsc: string[]; errors: number; warnings: number
  checks: { level: "ok" | "warn" | "bad"; text: string }[]
  board: { center: { x: number; y: number }; width: number; height: number; outline: { x: number; y: number }[] | null }
  cpl: CplPart[]
}
export type GitStatus = { branch: string; dirty: boolean; files: { status: string; path: string }[]; ahead: number }

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  })
  const text = await res.text()
  let data: any
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) throw new Error(data?.error || data?.message || `${res.status} ${res.statusText}`)
  return data as T
}
const post = (url: string, body?: unknown) =>
  req<any>(url, { method: "POST", body: JSON.stringify(body ?? {}) })

const enc = encodeURIComponent
export const api = {
  designs: () => req<DesignSummary[]>("/api/designs"),
  design: (n: string) => req<Design>(`/api/designs/${enc(n)}`),
  save: (n: string, files: Record<string, string>) =>
    req<any>(`/api/designs/${enc(n)}/files`, { method: "PUT", body: JSON.stringify({ files }) }),
  build: (n: string, files?: Record<string, string>) => post(`/api/designs/${enc(n)}/build`, { files }) as Promise<BuildResult>,
  bom: (n: string, qty: number, refresh = false) =>
    req<Bom>(`/api/designs/${enc(n)}/bom?qty=${qty}${refresh ? "&refresh=1" : ""}`),
  cost: (n: string, qty: number) => req<Cost>(`/api/designs/${enc(n)}/cost?qty=${qty}`),
  swaps: (n: string, qty: number) => req<Swaps>(`/api/designs/${enc(n)}/swaps?qty=${qty}`),
  applySwap: (n: string, from: string, to: string) =>
    post(`/api/designs/${enc(n)}/swaps/apply`, { from, to }) as Promise<{ ok: boolean; changed: Record<string, string>; libFiles: string[] }>,
  preflight: (n: string) => req<Preflight>(`/api/designs/${enc(n)}/preflight`),
  exportUrl: (n: string) => `/api/designs/${enc(n)}/export`,
  gitStatus: () => req<GitStatus>("/api/git/status"),
  commit: (message: string) => post("/api/git/commit", { message }) as Promise<{ ok: boolean; output: string }>,
  push: () => post("/api/git/push") as Promise<{ ok: boolean; output: string }>,
}

export const NEW_INDEX = `export default () => (
  <board width="50mm" height="40mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={0} pcbY={0} />
  </board>
)
`
export const newBoardJson = (name: string) =>
  JSON.stringify({ name, description: "", revision: "A", notes: "" }, null, 2) + "\n"
