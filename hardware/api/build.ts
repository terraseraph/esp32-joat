import { CircuitRunner } from "@tscircuit/eval/eval"
import { createHash } from "node:crypto"
import fs from "node:fs"
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
  // board.json holds notes/checklist/rules: keep it out of the build (and its cache hash) unless a source file reads it,
  // so ticking a checklist item does not trigger a multi-minute rebuild.
  const usesMeta = Object.entries(files).some(([rel, c]) => rel !== "board.json" && c.includes("board.json"))
  for (const [rel, content] of Object.entries(files)) {
    if (rel === "board.json" && !usesMeta) continue
    fsMap[`designs/${name}/${rel.replace(/\\/g, "/")}`] = content
  }
  return fsMap
}

const hashOf = (fsMap: Record<string, string>) => {
  const h = createHash("sha256")
  for (const k of Object.keys(fsMap).sort()) h.update(k).update("\0").update(fsMap[k]).update("\0")
  return h.digest("hex")
}

const cache = new Map<string, { hash: string; result: BuildResult }>()
const queues = new Map<string, Promise<unknown>>()

const toIssue = (e: any): Issue => ({ type: e.type, message: e.message ?? e.type, ...(e.stack ? { stack: e.stack } : {}) })

async function runBuild(name: string, fsMap: Record<string, string>): Promise<BuildResult> {
  const start = Date.now()
  const main = `designs/${name}/index.tsx`
  try {
    if (!(main in fsMap)) throw new Error(`designs/${name}/index.tsx not found`)
    const runner = new CircuitRunner()
    await runner.executeWithFsMap({ fsMap, mainComponentPath: main })
    await runner.renderUntilSettled()
    const circuitJson = (await runner.getCircuitJson()) as any[]
    const errors = circuitJson.filter((e) => e.type?.endsWith("_error")).map(toIssue)
    const warnings = circuitJson.filter((e) => e.type?.endsWith("_warning")).map(toIssue)
    return { ok: errors.length === 0, circuitJson, errors, warnings, durationMs: Date.now() - start }
  } catch (e: any) {
    return {
      ok: false,
      circuitJson: [],
      errors: [{ type: "execution_error", message: String(e?.message ?? e), stack: e?.stack }],
      warnings: [],
      durationMs: Date.now() - start,
    }
  }
}

/** Build a design (serialized per design). Reuses the last build when the inputs hash is unchanged. */
export function buildDesign(name: string, overrides?: Record<string, string>): Promise<BuildResult> {
  const prev = queues.get(name) ?? Promise.resolve()
  const next = prev.then(async () => {
    const fsMap = buildFsMap(name, overrides)
    const hash = hashOf(fsMap)
    const hit = cache.get(name)
    if (hit && hit.hash === hash) return hit.result
    const result = await runBuild(name, fsMap)
    if (result.circuitJson.length) cache.set(name, { hash, result })
    return result
  })
  queues.set(name, next.catch(() => {}))
  return next
}
