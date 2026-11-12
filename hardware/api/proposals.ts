// Human-in-the-loop change path: the user files a request, Claude (via the API/MCP) submits a proposal
// (files + summary), the user reviews a diff and accepts or rejects. Nothing is written until Accept.
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { readDesignFiles, ROOT, safeDesignPath, NAME_RE } from "./build.js"

const STATE_DIR = path.join(ROOT, ".designer-state")

export type DesignRequest = { id: string; text: string; createdAt: string; status: "open" | "resolved" | "dismissed"; resolvedAt?: string; note?: string; proposalIds: string[] }
export type Proposal = {
  id: string
  summary: string
  requestId: string | null
  createdAt: string
  status: "pending" | "accepted" | "rejected"
  decidedAt?: string
  /** new content per file, null = delete. Keys are design-relative, or `lib/<block>.tsx` for shared blocks. */
  files: Record<string, string | null>
  /** hash of each file as it was when proposed ("" = did not exist), used to detect stale proposals */
  base: Record<string, string>
}
type State = { requests: DesignRequest[]; proposals: Proposal[] }

const statePath = (name: string) => path.join(STATE_DIR, `${name}.json`)
function load(name: string): State {
  try {
    return JSON.parse(fs.readFileSync(statePath(name), "utf8"))
  } catch {
    return { requests: [], proposals: [] }
  }
}
function save(name: string, s: State) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(statePath(name), JSON.stringify(s, null, 2))
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const LIB_RE = /^lib\/[A-Za-z0-9_-]+\.tsx$/

/** Absolute path for a proposal file key, or null if not allowed. */
function resolveKey(name: string, key: string): string | null {
  if (LIB_RE.test(key)) return path.join(ROOT, key)
  return safeDesignPath(name, key)
}
function currentContent(name: string, key: string): string | null {
  const full = resolveKey(name, key)
  if (!full || !fs.existsSync(full)) return null
  return fs.readFileSync(full, "utf8")
}

// ---------- line diff (LCS, 3 lines of context) ----------
export type DiffLine = { t: " " | "+" | "-"; s: string }
export function lineDiff(a: string, b: string, ctx = 3): { lines: DiffLine[]; added: number; removed: number } {
  const x = a === "" ? [] : a.replace(/\r\n/g, "\n").split("\n"), y = b === "" ? [] : b.replace(/\r\n/g, "\n").split("\n")
  const n = x.length, m = y.length
  // trim common head/tail to keep the table small
  let h = 0
  while (h < n && h < m && x[h] === y[h]) h++
  let t = 0
  while (t < n - h && t < m - h && x[n - 1 - t] === y[m - 1 - t]) t++
  const xa = x.slice(h, n - t), ya = y.slice(h, m - t)
  if (xa.length * ya.length > 4_000_000) {
    // too big for an LCS table: show the differing middle as a whole-block replace
    const lines: DiffLine[] = [...xa.slice(0, 300).map((s) => ({ t: "-" as const, s })), ...ya.slice(0, 300).map((s) => ({ t: "+" as const, s })), { t: " ", s: "… (large change shown as a block replace, truncated)" }]
    return { lines, added: ya.length, removed: xa.length }
  }
  const w = ya.length + 1
  const dp = new Uint32Array((xa.length + 1) * w)
  for (let i = xa.length - 1; i >= 0; i--)
    for (let j = ya.length - 1; j >= 0; j--)
      dp[i * w + j] = xa[i] === ya[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
  const mid: DiffLine[] = []
  let i = 0, j = 0
  while (i < xa.length && j < ya.length) {
    if (xa[i] === ya[j]) { mid.push({ t: " ", s: xa[i] }); i++; j++ }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) mid.push({ t: "-", s: xa[i++] })
    else mid.push({ t: "+", s: ya[j++] })
  }
  while (i < xa.length) mid.push({ t: "-", s: xa[i++] })
  while (j < ya.length) mid.push({ t: "+", s: ya[j++] })
  const all: DiffLine[] = [...x.slice(0, h).map((s) => ({ t: " " as const, s })), ...mid, ...x.slice(n - t).map((s) => ({ t: " " as const, s }))]
  // collapse long unchanged runs to "…" markers
  const keep = new Array(all.length).fill(false)
  all.forEach((l, k) => { if (l.t !== " ") for (let d = -ctx; d <= ctx; d++) if (all[k + d]) keep[k + d] = true })
  const lines: DiffLine[] = []
  let skipped = false
  all.forEach((l, k) => {
    if (keep[k]) { lines.push(l); skipped = false }
    else if (!skipped) { lines.push({ t: " ", s: "…" }); skipped = true }
  })
  return { lines, added: all.filter((l) => l.t === "+").length, removed: all.filter((l) => l.t === "-").length }
}

/** Designs whose source imports the lib block (lib/<x>.tsx). */
function designsUsing(key: string): string[] {
  const base = key.replace(/^lib//, "").replace(/.tsx$/, "")
  const re = new RegExp(`from\s+["'][./]*lib/${base}["']`)
  const dir = path.join(ROOT, "designs")
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name)
    .filter((d) => Object.values(readDesignFiles(d)).some((t) => re.test(t)))
}

// Diffing is O(n*m); compute once per (proposal, current file state) instead of on every UI poll.
const diffCache = new Map<string, any>()
function withDiffs(name: string, p: Proposal) {
  const cur = Object.keys(p.files).map((f) => sha(currentContent(name, f) ?? ""))
  const ck = `${name}:${p.id}:${p.status}:${cur.join(",")}`
  const hit = diffCache.get(ck)
  if (hit) return hit
  const r = computeWithDiffs(name, p)
  if (diffCache.size > 200) diffCache.clear()
  diffCache.set(ck, r)
  return r
}
function computeWithDiffs(name: string, p: Proposal) {
  const diffs = Object.entries(p.files).map(([file, next]) => {
    const prev = p.status === "pending" ? currentContent(name, file) : null
    const status = next === null ? "delete" : prev === null ? "add" : "modify"
    // for decided proposals we no longer have the old text, so show the new text only
    const d = p.status === "pending" ? lineDiff(prev ?? "", next ?? "") : { lines: (next ?? "").split("\n").slice(0, 200).map((s) => ({ t: "+" as const, s })), added: 0, removed: 0 }
    const shared = LIB_RE.test(file) ? designsUsing(file) : null
    return { file, status, added: d.added, removed: d.removed, lines: d.lines, shared }
  })
  const stale = p.status === "pending" && Object.keys(p.files).filter((f) => sha(currentContent(name, f) ?? "") !== p.base[f])
  return { ...p, diffs, stale: stale || [] }
}

export function registerProposalRoutes(app: any, designExists: (n: string) => boolean) {
  const guard = (req: any, reply: any) => {
    if (!NAME_RE.test(req.params.name) || !designExists(req.params.name)) { reply.code(404).send({ error: "design not found" }); return false }
    return true
  }

  app.get("/api/designs/:name/requests", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const { status } = req.query ?? {}
    return load(req.params.name).requests.filter((r) => !status || r.status === status)
  })

  app.post("/api/designs/:name/requests", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const text = String(req.body?.text ?? "").trim()
    if (!text) return reply.code(400).send({ error: "text required" })
    if (text.length > 4000) return reply.code(400).send({ error: "text too long" })
    const s = load(req.params.name)
    const r: DesignRequest = { id: randomUUID().slice(0, 8), text, createdAt: new Date().toISOString(), status: "open", proposalIds: [] }
    s.requests.push(r)
    save(req.params.name, s)
    return r
  })

  app.post("/api/designs/:name/requests/:id/resolve", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const s = load(req.params.name)
    const r = s.requests.find((x) => x.id === req.params.id)
    if (!r) return reply.code(404).send({ error: "request not found" })
    r.status = req.body?.status === "dismissed" ? "dismissed" : "resolved"
    r.resolvedAt = new Date().toISOString()
    if (typeof req.body?.note === "string") r.note = req.body.note.slice(0, 1000)
    save(req.params.name, s)
    return r
  })

  app.get("/api/designs/:name/proposals", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const { status } = req.query ?? {}
    return load(req.params.name).proposals.filter((p) => !status || p.status === status).map((p) => withDiffs(req.params.name, p))
  })

  app.get("/api/designs/:name/proposals/:id", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const p = load(req.params.name).proposals.find((x) => x.id === req.params.id)
    return p ? withDiffs(req.params.name, p) : reply.code(404).send({ error: "proposal not found" })
  })

  app.post("/api/designs/:name/proposals", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const name = req.params.name
    const files = req.body?.files
    const summary = String(req.body?.summary ?? "").trim()
    if (!summary) return reply.code(400).send({ error: "summary required" })
    if (!files || typeof files !== "object" || !Object.keys(files).length) return reply.code(400).send({ error: "files required" })
    const base: Record<string, string> = {}
    for (const [key, content] of Object.entries(files)) {
      if (!resolveKey(name, key)) return reply.code(400).send({ error: `invalid file: ${key}` })
      if (LIB_RE.test(key) && content === null) return reply.code(400).send({ error: `deleting shared block ${key} is not allowed` })
      if (content !== null && typeof content !== "string") return reply.code(400).send({ error: `invalid content for ${key}` })
      base[key] = sha(currentContent(name, key) ?? "")
    }
    const s = load(name)
    const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : null
    if (requestId && !s.requests.some((r) => r.id === requestId)) return reply.code(400).send({ error: "unknown requestId" })
    const p: Proposal = { id: randomUUID().slice(0, 8), summary, requestId, createdAt: new Date().toISOString(), status: "pending", files, base }
    s.proposals.push(p)
    if (requestId) s.requests.find((r) => r.id === requestId)!.proposalIds.push(p.id)
    save(name, s)
    return withDiffs(name, p)
  })

  app.post("/api/designs/:name/proposals/:id/accept", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const name = req.params.name
    const s = load(name)
    const p = s.proposals.find((x) => x.id === req.params.id)
    if (!p) return reply.code(404).send({ error: "proposal not found" })
    if (p.status !== "pending") return reply.code(409).send({ error: `proposal already ${p.status}` })
    const stale = Object.keys(p.files).filter((f) => sha(currentContent(name, f) ?? "") !== p.base[f])
    if (stale.length && !req.body?.force) return reply.code(409).send({ error: `files changed since the proposal was made: ${stale.join(", ")}`, stale })
    for (const [key, content] of Object.entries(p.files)) {
      const full = resolveKey(name, key)!
      if (content === null) fs.rmSync(full, { force: true })
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, content)
      }
    }
    p.status = "accepted"
    p.decidedAt = new Date().toISOString()
    const r = p.requestId ? s.requests.find((x) => x.id === p.requestId) : null
    if (r && r.status === "open") { r.status = "resolved"; r.resolvedAt = p.decidedAt }
    save(name, s)
    return { ok: true, written: Object.keys(p.files), files: readDesignFiles(name) }
  })

  app.post("/api/designs/:name/proposals/:id/reject", async (req: any, reply: any) => {
    if (!guard(req, reply)) return
    const s = load(req.params.name)
    const p = s.proposals.find((x) => x.id === req.params.id)
    if (!p) return reply.code(404).send({ error: "proposal not found" })
    if (p.status !== "pending") return reply.code(409).send({ error: `proposal already ${p.status}` })
    p.status = "rejected"
    p.decidedAt = new Date().toISOString()
    save(req.params.name, s)
    return { ok: true }
  })
}
