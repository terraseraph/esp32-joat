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

export type PartInfo = { ref: string; type: string; value: string | null; mpn: string | null; footprint: string | null; lcsc: string | null; x: number | null; y: number | null; rotation: number | null; width: number | null; height: number | null; source: { file: string; line: number } | null }
export type Explain = { title: string; summary: string; groups: { id: string; title: string; sentences: { text: string; refs: string[] }[] }[] }
export type DesignRequest = { id: string; text: string; createdAt: string; status: "open" | "resolved" | "dismissed"; proposalIds: string[] }
export type ProposalDiff = { file: string; status: "add" | "modify" | "delete"; added: number; removed: number; shared: string[] | null; lines: { t: " " | "+" | "-"; s: string }[] }
export type Proposal = { id: string; summary: string; requestId: string | null; createdAt: string; status: "pending" | "accepted" | "rejected"; diffs: ProposalDiff[]; stale: string[] }

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
  explain: (n: string) => req<Explain>(`/api/designs/${enc(n)}/explain`),
  components: (n: string) => req<PartInfo[]>(`/api/designs/${enc(n)}/components`),
  requests: (n: string) => req<DesignRequest[]>(`/api/designs/${enc(n)}/requests`),
  addRequest: (n: string, text: string) => post(`/api/designs/${enc(n)}/requests`, { text }) as Promise<DesignRequest>,
  resolveRequest: (n: string, id: string, status: "resolved" | "dismissed") => post(`/api/designs/${enc(n)}/requests/${id}/resolve`, { status }),
  proposals: (n: string) => req<Proposal[]>(`/api/designs/${enc(n)}/proposals?status=pending`),
  acceptProposal: (n: string, id: string, force = false) => post(`/api/designs/${enc(n)}/proposals/${id}/accept`, { force }),
  rejectProposal: (n: string, id: string) => post(`/api/designs/${enc(n)}/proposals/${id}/reject`),
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
