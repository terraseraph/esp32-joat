import { CircuitRunner } from "@tscircuit/eval/eval"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { fork, type ChildProcess } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/
const EXT_RE = /\.(tsx|ts|json)$/

export type Issue = { type: string; message: string; stack?: string }
export type BuildResult = {
  ok: boolean
  circuitJson: any[]
  errors: Issue[]
  warnings: Issue[]
  durationMs: number
}

const toKey = (p: string) => p.split(path.sep).join("/")

function walk(dir: string, base: string, out: Record<string, string>) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else if (EXT_RE.test(e.name)) out[toKey(path.relative(base, full))] = fs.readFileSync(full, "utf8")
  }
}

/** Design files relative to the design folder. */
export function readDesignFiles(name: string): Record<string, string> {
  const out: Record<string, string> = {}
  walk(path.join(ROOT, "designs", name), path.join(ROOT, "designs", name), out)
  return out
}

export function readMeta(name: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "designs", name, "board.json"), "utf8"))
  } catch {
    return null
  }
}

/** Resolve a relative file path inside a design folder, or null if it escapes / has a bad extension. */
export function safeDesignPath(name: string, rel: string): string | null {
  if (!NAME_RE.test(name) || !EXT_RE.test(rel) || path.isAbsolute(rel) || rel.includes("\0")) return null
  const dir = path.join(ROOT, "designs", name)
  const full = path.resolve(dir, rel)
  return full.startsWith(dir + path.sep) ? full : null
}

function buildFsMap(name: string, overrides?: Record<string, string>) {
  const fsMap: Record<string, string> = {}
  walk(path.join(ROOT, "lib"), ROOT, fsMap)
  const files = { ...readDesignFiles(name), ...(overrides ?? {}) }
  for (const [rel, content] of Object.entries(files)) fsMap[`designs/${name}/${rel.replace(/\\/g, "/")}`] = content
  return fsMap
}

const hashOf = (fsMap: Record<string, string>) => {
  const h = createHash("sha256")
  for (const k of Object.keys(fsMap).sort()) h.update(k).update("\0").update(fsMap[k]).update("\0")
  return h.digest("hex")
}

export type BuildMode = "quick" | "full"
export type BuildStatus = {
  state: "idle" | "running"
  id?: number
  mode?: BuildMode
  phase?: string
  progress?: number
  startedAt?: number
  elapsedMs?: number
}
export type BuildOutcome = BuildResult & { mode: BuildMode; cached?: boolean; cancelled?: boolean }

const CACHE_DIR = path.join(ROOT, ".cache", "builds")
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "build-worker.ts")

const mem = new Map<string, { hash: string; mode: BuildMode; result: BuildResult }>() // last good per design
const queues = new Map<string, Promise<unknown>>()
type Job = { id: number; mode: BuildMode; phase: string; progress?: number; startedAt: number; child?: ChildProcess; cancelled: boolean; supersedable: boolean }
const running = new Map<string, Job>()
let jobSeq = 0

/** Quick mode: placement + ratsnest only. `<board routeRemaining={false}>` skips the autorouter for unassigned connections. */
const quickify = (fsMap: Record<string, string>) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fsMap))
    out[k] = k.endsWith(".tsx")
      ? v.replace(/\s+routeRemaining(?:\s*=\s*\{[^}]*\})?(?=[\s/>])/g, "").replace(/<board(?=[\s>])/g, "<board routeRemaining={false}")
      : v
  return out
}

const cacheFile = (name: string) => path.join(CACHE_DIR, `${name}.json`)
/** Last good build persisted to disk, regardless of hash (shown immediately while a rebuild runs). */
export function readDiskBuild(name: string): { hash: string; mode: BuildMode; result: BuildResult } | null {
  if (!NAME_RE.test(name)) return null
  try { return JSON.parse(fs.readFileSync(cacheFile(name), "utf8")) } catch { return null }
}
function writeDiskBuild(name: string, entry: { hash: string; mode: BuildMode; result: BuildResult }) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(cacheFile(name), JSON.stringify(entry))
  } catch {}
}

export function buildStatus(name: string): BuildStatus {
  const j = running.get(name)
  if (!j) return { state: "idle" }
  return { state: "running", id: j.id, mode: j.mode, phase: j.phase, progress: j.progress, startedAt: j.startedAt, elapsedMs: Date.now() - j.startedAt }
}

/** Kill the running build for a design. Returns whether one was running. */
export function cancelBuild(name: string): boolean {
  const j = running.get(name)
  if (!j) return false
  j.cancelled = true
  j.child?.kill()
  return true
}

function runInWorker(name: string, fsMap: Record<string, string>, job: Job, quick: boolean): Promise<BuildResult | null> {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] })
    job.child = child
    let done = false
    const finish = (r: BuildResult | null) => { if (!done) { done = true; resolve(r) } }
    child.on("message", (m: any) => {
      if (m.type === "phase") { job.phase = m.phase; job.progress = undefined }
      else if (m.type === "progress") job.progress = m.progress
      else if (m.type === "done") finish(m.result)
    })
    child.on("exit", (code) => {
      if (job.cancelled) return finish(null)
      finish({ ok: false, circuitJson: [], warnings: [], durationMs: Date.now() - job.startedAt, errors: [{ type: "execution_error", message: `build process exited (code ${code})` }] })
    })
    if (job.cancelled) child.kill()
    else child.send({ name, fsMap, quick })
  })
}

/**
 * Build a design in a child process (serialized per design). `overrides` are unsaved editor files; such builds are
 * "supersedable": a newer editor build cancels them instead of queueing behind them. Reuses the last build when the
 * inputs hash is unchanged (a full build also satisfies a quick request).
 */
export function buildDesign(name: string, overrides?: Record<string, string>, mode: BuildMode = "full"): Promise<BuildOutcome> {
  const supersedable = !!overrides
  const cur = running.get(name)
  if (cur && cur.supersedable && supersedable) cancelBuild(name)
  const prev = queues.get(name) ?? Promise.resolve()
  const next = prev.then(async (): Promise<BuildOutcome> => {
    const fsMap = buildFsMap(name, overrides)
    const hash = hashOf(fsMap)
    const hit = mem.get(name) ?? readDiskBuild(name)
    if (hit && hit.hash === hash && (hit.mode === "full" || mode === "quick")) return { ...hit.result, mode: hit.mode, cached: true }
    const job: Job = { id: ++jobSeq, mode, phase: "starting", startedAt: Date.now(), cancelled: false, supersedable }
    running.set(name, job)
    try {
      const result = await runInWorker(name, mode === "quick" ? quickify(fsMap) : fsMap, job, mode === "quick")
      if (result && mode === "quick") {
        // Unrouted nets are expected without the autorouter: report them as warnings, not errors.
        const unrouted = (e: Issue) => e.type === "pcb_port_not_connected_error" || e.type === "pcb_trace_missing_error"
        result.warnings = [...result.warnings, ...result.errors.filter(unrouted)]
        result.errors = result.errors.filter((e) => !unrouted(e))
        result.ok = result.errors.length === 0
      }
      if (!result) return { ok: false, circuitJson: [], errors: [], warnings: [], durationMs: Date.now() - job.startedAt, mode, cancelled: true }
      if (result.circuitJson.length && result.ok) {
        const entry = { hash, mode, result }
        mem.set(name, entry)
        writeDiskBuild(name, entry)
      }
      return { ...result, mode }
    } finally {
      if (running.get(name) === job) running.delete(name)
    }
  })
  queues.set(name, next.catch(() => {}))
  return next
}
