// "Iterate safely" routes: snapshots, variants and revision diff. Registered from server.ts.
import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { buildDesign, NAME_RE, readDesignFiles, readMeta, ROOT, safeDesignPath } from "./build.js"

// Snapshots live in hardware/.cache/snapshots/<design>/<id>.json (gitignored). They are NOT stored
// under designs/<name>/ because the build walks every .ts/.tsx/.json file in the design folder, so a
// snapshot there would be treated as part of the design (and show up in `git status`).
const SNAP_ROOT = path.join(ROOT, ".cache", "snapshots")
const ID_RE = /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/

export type Snapshot = { id: string; label: string; createdAt: string; auto: boolean; files: Record<string, string> }
export type SnapshotInfo = Omit<Snapshot, "files"> & { fileCount: number }

const snapDir = (name: string) => path.join(SNAP_ROOT, name)

export function createSnapshot(name: string, files: Record<string, string>, label = "", auto = false): SnapshotInfo {
  const dir = snapDir(name)
  fs.mkdirSync(dir, { recursive: true })
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  let id = base
  for (let i = 1; fs.existsSync(path.join(dir, `${id}.json`)); i++) id = `${base}-${i}`
  const snap: Snapshot = { id, label: label.trim().slice(0, 120), createdAt: d.toISOString(), auto, files }
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(snap))
  return { id, label: snap.label, createdAt: snap.createdAt, auto, fileCount: Object.keys(files).length }
}

export function readSnapshot(name: string, id: string): Snapshot | null {
  if (!NAME_RE.test(name) || !ID_RE.test(id)) return null
  try { return JSON.parse(fs.readFileSync(path.join(snapDir(name), `${id}.json`), "utf8")) } catch { return null }
}

export function listSnapshots(name: string): SnapshotInfo[] {
  const dir = snapDir(name)
  if (!fs.existsSync(dir)) return []
  const out: SnapshotInfo[] = []
  for (const f of fs.readdirSync(dir)) {
    const id = f.replace(/\.json$/, "")
    if (!ID_RE.test(id)) continue
    const s = readSnapshot(name, id)
    if (s) out.push({ id: s.id, label: s.label, createdAt: s.createdAt, auto: !!s.auto, fileCount: Object.keys(s.files ?? {}).length })
  }
  return out.sort((a, b) => b.id.localeCompare(a.id))
}

/** A -> B, Z -> AA, 3 -> 4; anything else gets a "2" suffix. Keeps the input's case. */
export function bumpRevision(rev: string): string {
  if (/^\d+$/.test(rev)) return String(parseInt(rev, 10) + 1)
  if (/^[A-Za-z]+$/.test(rev)) {
    const lower = rev === rev.toLowerCase()
    const chars = rev.toUpperCase().split("")
    let i = chars.length - 1
    while (i >= 0) {
      if (chars[i] === "Z") { chars[i] = "A"; i-- } else { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); break }
    }
    if (i < 0) chars.unshift("A")
    const r = chars.join("")
    return lower ? r.toLowerCase() : r
  }
  return rev + "2"
}

/** Copies the whole design folder to `<base>-rev<x>` and sets board.json revision to the same <x>. The revision is the
 *  next one after the source's (A -> B), bumped further until the folder name is free, so folder and revision always agree. */
export function createVariant(name: string, wanted?: string): { name: string; revision: string } {
  const src = path.join(ROOT, "designs", name)
  const meta = readMeta(name) ?? {}
  const m = /^(.*)-rev([a-z0-9]+)$/i.exec(name)
  const root = m ? m[1] : name
  let revision = bumpRevision(String(meta.revision ?? (m ? m[2].toUpperCase() : "A")))
  let target = wanted
  if (target) {
    if (!NAME_RE.test(target)) throw Object.assign(new Error("invalid variant name"), { statusCode: 400 })
    if (fs.existsSync(path.join(ROOT, "designs", target))) throw Object.assign(new Error(`"${target}" already exists`), { statusCode: 409 })
  } else {
    for (let n = 0; n < 100; n++, revision = bumpRevision(revision)) {
      target = `${root}-rev${revision.toLowerCase()}`
      if (!fs.existsSync(path.join(ROOT, "designs", target))) break
    }
    if (!target || fs.existsSync(path.join(ROOT, "designs", target))) throw Object.assign(new Error("no free variant name"), { statusCode: 409 })
  }
  const dest = path.join(ROOT, "designs", target)
  fs.cpSync(src, dest, { recursive: true, filter: (p) => path.basename(p) !== ".snapshots" })
  const newMeta = { ...meta, name: !meta.name || meta.name === name ? target : meta.name, revision }
  fs.writeFileSync(path.join(dest, "board.json"), JSON.stringify(newMeta, null, 2) + "\n")
  return { name: target, revision }
}

// ---------- revision diff ----------
type Comp = { name: string; ftype?: string; x?: number; y?: number; w?: number; h?: number; rot?: number; layer?: string; props: Record<string, unknown> }
const SKIP_PROPS = new Set(["type", "source_component_id", "source_group_id", "subcircuit_id", "source_group_ids", "pcb_component_id", "name"])

function components(cj: any[]): { comps: Map<string, Comp>; board: any } {
  const pcbBySource = new Map<string, any>()
  for (const e of cj) if (e.type === "pcb_component") pcbBySource.set(e.source_component_id, e)
  const comps = new Map<string, Comp>()
  for (const e of cj) {
    if (e.type !== "source_component" || !e.name) continue
    const p = pcbBySource.get(e.source_component_id)
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e)) if (!SKIP_PROPS.has(k) && v != null && typeof v !== "object") props[k] = v
    // prefer the human-readable display_* value over its raw numeric twin (0.000022 vs 22uF)
    for (const k of Object.keys(props)) if (`display_${k}` in props) delete props[k]
    comps.set(e.name, { name: e.name, ftype: e.ftype, x: p?.center?.x, y: p?.center?.y, w: p?.width, h: p?.height, rot: p?.rotation, layer: p?.layer, props })
  }
  return { comps, board: cj.find((e) => e.type === "pcb_board") }
}

export type DiffItem = {
  name: string
  kind: "added" | "removed" | "moved" | "changed"
  detail: string
  /** geometry in mm: the "to" build, or the "from" build for removed parts */
  x?: number; y?: number; w?: number; h?: number; rot?: number
  /** previous position, for moved parts */
  fromX?: number; fromY?: number
}
export type DiffResult = {
  items: DiffItem[]
  unchanged: { name: string; x?: number; y?: number; w?: number; h?: number; rot?: number }[]
  board: { x: number; y: number; w: number; h: number } | null
  boardChange: string | null
  counts: Record<DiffItem["kind"], number>
  errors: { from: number; to: number }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const bbox = (b: any) => (b?.width ? { x: b.center?.x ?? 0, y: b.center?.y ?? 0, w: b.width, h: b.height } : null)

export function diffCircuits(a: any[], b: any[]): DiffResult {
  const A = components(a), B = components(b)
  const items: DiffItem[] = []
  const unchanged: DiffResult["unchanged"] = []
  for (const [name, cb] of B.comps) {
    const ca = A.comps.get(name)
    const geo = { x: cb.x, y: cb.y, w: cb.w, h: cb.h, rot: cb.rot }
    if (!ca) { items.push({ name, kind: "added", detail: `${cb.ftype ?? "part"} added`, ...geo }); continue }
    const propDiffs = [...new Set([...Object.keys(ca.props), ...Object.keys(cb.props)])]
      .filter((k) => ca.props[k] !== cb.props[k])
      .map((k) => `${k}: ${ca.props[k] ?? "-"} -> ${cb.props[k] ?? "-"}`)
    const dist = ca.x !== undefined && cb.x !== undefined ? Math.hypot(ca.x - cb.x, (ca.y ?? 0) - (cb.y ?? 0)) : 0
    const rotChanged = (ca.rot ?? 0) !== (cb.rot ?? 0)
    const layerChanged = ca.layer !== cb.layer
    const moved = dist > 0.01 || rotChanged || layerChanged
    const from = moved ? { fromX: ca.x, fromY: ca.y } : {}
    if (propDiffs.length) items.push({ name, kind: "changed", detail: propDiffs.join(", "), ...geo, ...from })
    else if (moved) {
      const parts: string[] = []
      if (dist > 0.01) parts.push(`(${r2(ca.x!)}, ${r2(ca.y!)}) -> (${r2(cb.x!)}, ${r2(cb.y!)}) mm`)
      if (rotChanged) parts.push(`rotation ${ca.rot ?? 0} -> ${cb.rot ?? 0} deg`)
      if (layerChanged) parts.push(`layer ${ca.layer} -> ${cb.layer}`)
      items.push({ name, kind: "moved", detail: parts.join(", "), ...geo, ...from })
    } else unchanged.push({ name, ...geo })
  }
  for (const [name, ca] of A.comps)
    if (!B.comps.has(name)) items.push({ name, kind: "removed", detail: `${ca.ftype ?? "part"} removed`, x: ca.x, y: ca.y, w: ca.w, h: ca.h, rot: ca.rot })
  const ba = bbox(A.board), bb = bbox(B.board)
  const boardChange = ba && bb && (ba.w !== bb.w || ba.h !== bb.h) ? `board ${r2(ba.w)}x${r2(ba.h)} -> ${r2(bb.w)}x${r2(bb.h)} mm` : null
  const order = { added: 0, removed: 1, moved: 2, changed: 3 }
  items.sort((x, y) => order[x.kind] - order[y.kind] || x.name.localeCompare(y.name, undefined, { numeric: true }))
  const counts = { added: 0, removed: 0, moved: 0, changed: 0 }
  for (const i of items) counts[i.kind]++
  const errs = (c: any[]) => c.filter((e) => e.type?.endsWith("_error")).length
  return { items, unchanged, board: bb ?? ba, boardChange, counts, errors: { from: errs(a), to: errs(b) } }
}

export function registerIterateRoutes(app: FastifyInstance, designExists: (n: string) => boolean) {
  const bad = (reply: any, msg: string, code = 400) => reply.code(code).send({ error: msg })

  app.get<{ Params: { name: string } }>("/api/designs/:name/snapshots", async (req, reply) =>
    designExists(req.params.name) ? listSnapshots(req.params.name) : bad(reply, "design not found", 404))

  // Body: { label?, files? }. Without files, the files on disk are stored.
  app.post<{ Params: { name: string }; Body: { label?: string; files?: Record<string, string> } }>("/api/designs/:name/snapshots", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return bad(reply, "design not found", 404)
    let files = readDesignFiles(name)
    if (req.body?.files) {
      for (const [k, v] of Object.entries(req.body.files)) if (!safeDesignPath(name, k) || typeof v !== "string") return bad(reply, `invalid file: ${k}`)
      files = req.body.files
    }
    return createSnapshot(name, files, req.body?.label ?? "")
  })

  app.get<{ Params: { name: string; id: string } }>("/api/designs/:name/snapshots/:id", async (req, reply) => {
    const s = designExists(req.params.name) ? readSnapshot(req.params.name, req.params.id) : null
    return s ?? bad(reply, "snapshot not found", 404)
  })

  app.delete<{ Params: { name: string; id: string } }>("/api/designs/:name/snapshots/:id", async (req, reply) => {
    if (!designExists(req.params.name) || !readSnapshot(req.params.name, req.params.id)) return bad(reply, "snapshot not found", 404)
    fs.rmSync(path.join(snapDir(req.params.name), `${req.params.id}.json`))
    return { ok: true }
  })

  // Writes the snapshot's files to disk; files not in the snapshot are removed. The current disk state is
  // snapshotted first (auto) so a restore is never destructive.
  app.post<{ Params: { name: string; id: string } }>("/api/designs/:name/snapshots/:id/restore", async (req, reply) => {
    const { name, id } = req.params
    const snap = designExists(name) ? readSnapshot(name, id) : null
    if (!snap) return bad(reply, "snapshot not found", 404)
    const current = readDesignFiles(name)
    const backup = createSnapshot(name, current, `Before restoring ${snap.label || id}`, true)
    for (const rel of Object.keys(current)) {
      if (rel in snap.files) continue
      const full = safeDesignPath(name, rel)
      if (full) fs.rmSync(full, { force: true })
    }
    for (const [rel, content] of Object.entries(snap.files)) {
      const full = safeDesignPath(name, rel)
      if (!full) continue
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    return { ok: true, files: readDesignFiles(name), backup }
  })

  app.post<{ Params: { name: string }; Body: { name?: string } }>("/api/designs/:name/variant", async (req, reply) =>
    designExists(req.params.name) ? createVariant(req.params.name, req.body?.name) : bad(reply, "design not found", 404))

  // Body: { a: "current" | snapshotId, b: "current" | snapshotId, files?: unsaved editor files used for "current" }
  app.post<{ Params: { name: string }; Body: { a?: string; b?: string; files?: Record<string, string> } }>("/api/designs/:name/diff", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return bad(reply, "design not found", 404)
    const pick = (ref?: string): Record<string, string> | null =>
      !ref || ref === "current" ? (req.body?.files ?? readDesignFiles(name)) : (readSnapshot(name, ref)?.files ?? null)
    if (req.body?.files) for (const [k, v] of Object.entries(req.body.files)) if (!safeDesignPath(name, k) || typeof v !== "string") return bad(reply, `invalid file: ${k}`)
    const fa = pick(req.body?.a), fb = pick(req.body?.b)
    if (!fa || !fb) return bad(reply, "snapshot not found", 404)
    const ra = await buildDesign(name, fa)
    const rb = await buildDesign(name, fb)
    if (!ra.circuitJson.length || !rb.circuitJson.length) {
      const failed = ra.circuitJson.length ? rb : ra
      return bad(reply, `build failed for ${ra.circuitJson.length ? "b" : "a"}: ${failed.errors[0]?.message ?? "no output"}`, 422)
    }
    return diffCircuits(ra.circuitJson, rb.circuitJson)
  })
}
