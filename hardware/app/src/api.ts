export type Meta = { name?: string; description?: string; revision?: string; notes?: string } | null
export type DesignSummary = { name: string; meta: Meta }
export type Design = { name: string; meta: Meta; files: Record<string, string> }
export type Issue = { type: string; message: string; stack?: string }
export type BuildMode = "quick" | "full"
export type BuildResult = { ok: boolean; circuitJson: any[]; errors: Issue[]; warnings: Issue[]; durationMs: number; mode?: BuildMode; cached?: boolean; cancelled?: boolean }
export type BuildStatus = { state: "idle" | "running"; id?: number; mode?: BuildMode; phase?: string; progress?: number; elapsedMs?: number }
export type BomRow = {
  refs: string[]; lcsc: string; mfr: string; package: string; description: string
  qtyPerBoard: number; unitPrice: number; lineCostPerBoard: number; stock: number
  basic: boolean; preferred: boolean; extended: boolean; missing: boolean
}
export type BomSummary = {
  partsCostPerBoard: number; extendedTypes: number; setupFeePerType: number; setupFees: number
  setupFeesPerBoard: number; costPerBoard: number; totalAtQty: number; missingCount: number
}
export type SrcComponent = {
  file: string; name: string; tag: string; props: Record<string, string | number | boolean>
  dynamic: string[]; inLoop: boolean; line: number
}
export type PropValue = string | number | boolean | null
export type Bom = { qty: number; rows: BomRow[]; summary: BomSummary }
export type GitStatus = { branch: string; dirty: boolean; files: { status: string; path: string }[]; ahead: number }

export type EditResp = { ok: boolean; changed: boolean; how?: string; source: string; written: boolean; net?: string; count?: number; files?: Record<string, string>; map?: GpioMap | null }
export type GpioNote = { level: "error" | "warn" | "info"; text: string }
export type GpioRow = { pin: string; pinNumber: number; net: string | null; isDefault: boolean; notes: GpioNote[] }
export type GpioMap = { component: string; rows: GpioRow[]; clashes: { level: "error" | "warn" | "info"; text: string; pins: string[] }[]; nets: string[] }
export type PinRefT = { ref: string; pin: string }

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

export type PropSpec = {
  name: string; type: "string" | "number" | "boolean" | "raw" | "select"; options?: string[]
  default?: string | number | boolean; required: boolean; doc?: string; advanced?: boolean
}
export type PaletteItem = {
  id: string; kind: "lib" | "primitive"; label: string; tag: string; description: string; prefix: string; props: PropSpec[]
}
export type PartHit = {
  lcsc: string; mfr: string; package: string; description: string; stock: number | null
  price: number | null; tier: "basic" | "preferred" | "extended"; footprint: string
}

const enc = encodeURIComponent
export const api = {
  designs: () => req<DesignSummary[]>("/api/designs"),
  design: (n: string) => req<Design>(`/api/designs/${enc(n)}`),
  save: (n: string, files: Record<string, string>) =>
    req<any>(`/api/designs/${enc(n)}/files`, { method: "PUT", body: JSON.stringify({ files }) }),
  build: (n: string, files?: Record<string, string>, mode: BuildMode = "full") =>
    post(`/api/designs/${enc(n)}/build`, { files, mode }) as Promise<BuildResult>,
  buildStatus: (n: string) => req<BuildStatus>(`/api/designs/${enc(n)}/build/status`),
  cancelBuild: (n: string) => post(`/api/designs/${enc(n)}/build/cancel`) as Promise<{ cancelled: boolean }>,
  cachedBuild: (n: string) => req<BuildResult>(`/api/designs/${enc(n)}/build/cached`).catch(() => null),
  bom: (n: string, qty: number, refresh = false) =>
    req<Bom>(`/api/designs/${enc(n)}/bom?qty=${qty}${refresh ? "&refresh=1" : ""}`),
  /** Components named in the source (unsaved `files` overlay optional). */
  components: (n: string, files?: Record<string, string>) => post(`/api/designs/${enc(n)}/components/source`, { files }) as Promise<SrcComponent[]>,
  /** Rewrite props of one component in the in-memory `files`; returns the new file text (not written). */
  patchComponent: (n: string, component: string, props: Record<string, PropValue>, files: Record<string, string>, delta?: Record<string, number>) =>
    req<{ file: string; content: string; warnings: string[] }>(`/api/designs/${enc(n)}/components/${enc(component)}`, { method: "PATCH", body: JSON.stringify({ props, delta, files }) }),
  palette: () => req<{ lib: PaletteItem[]; primitives: PaletteItem[] }>("/api/palette"),
  searchParts: (q: string) => req<PartHit[]>(`/api/parts/search?q=${enc(q)}`),
  /** with `source` nothing is written; the edited source comes back */
  insertComponent: (n: string, item: string, props: Record<string, string>, source?: string, knownNames?: string[]) =>
    post(`/api/designs/${enc(n)}/components`, { item, props, source, knownNames }) as Promise<{ ok: boolean; name: string | null; snippet: string; source: string }>,
  exportUrl: (n: string) => `/api/designs/${enc(n)}/export`,
  gitStatus: () => req<GitStatus>("/api/git/status"),
  commit: (message: string) => post("/api/git/commit", { message }) as Promise<{ ok: boolean; output: string }>,
  // connect / nets / GPIO: pass the editor's index.tsx as `source` to get edited text back without touching disk
  connect: (n: string, a: PinRefT, b: PinRefT | undefined, net: string | undefined, source: string) =>
    post(`/api/designs/${enc(n)}/connect`, { a, b, net, source }) as Promise<EditResp>,
  renameNet: (n: string, from: string, to: string, source: string, merge = false) =>
    post(`/api/designs/${enc(n)}/rename-net`, { from, to, source, merge }) as Promise<EditResp>,
  gpio: (n: string, source: string) => post(`/api/designs/${enc(n)}/gpio`, { source }) as Promise<{ map: GpioMap | null }>,
  assignGpio: (n: string, pin: string, net: string | null, source: string) =>
    post(`/api/designs/${enc(n)}/gpio/assign`, { pin, net, source }) as Promise<EditResp>,
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
