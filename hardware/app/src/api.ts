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

// ---- iterate safely: snapshots, variants, revision diff ----
export type SnapshotInfo = { id: string; label: string; createdAt: string; auto: boolean; fileCount: number }
export type DiffItem = {
  name: string; kind: "added" | "removed" | "moved" | "changed"; detail: string
  x?: number; y?: number; w?: number; h?: number; rot?: number; fromX?: number; fromY?: number
}
export type DiffResult = {
  items: DiffItem[]
  unchanged: { name: string; x?: number; y?: number; w?: number; h?: number; rot?: number }[]
  board: { x: number; y: number; w: number; h: number } | null
  boardChange: string | null
  counts: Record<DiffItem["kind"], number>
  errors: { from: number; to: number }
}
export const iterApi = {
  snapshots: (n: string) => req<SnapshotInfo[]>(`/api/designs/${enc(n)}/snapshots`),
  snapshot: (n: string, label: string, files?: Record<string, string>) => post(`/api/designs/${enc(n)}/snapshots`, { label, files }) as Promise<SnapshotInfo>,
  deleteSnapshot: (n: string, id: string) => req<any>(`/api/designs/${enc(n)}/snapshots/${enc(id)}`, { method: "DELETE" }),
  restore: (n: string, id: string) => post(`/api/designs/${enc(n)}/snapshots/${enc(id)}/restore`) as Promise<{ ok: boolean; files: Record<string, string>; backup: SnapshotInfo }>,
  variant: (n: string, name?: string) => post(`/api/designs/${enc(n)}/variant`, { name }) as Promise<{ name: string; revision: string }>,
  diff: (n: string, a: string, b: string, files?: Record<string, string>) => post(`/api/designs/${enc(n)}/diff`, { a, b, files }) as Promise<DiffResult>,
}
