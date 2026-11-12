import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
import { NAME_RE, ROOT } from "./build.js"

export const DESIGNS = path.join(ROOT, "designs")
export const TRASH = path.join(ROOT, ".trash")
const THUMBS = path.join(ROOT, ".cache", "thumbs")

export const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "")

/** Newest mtime of any file in the design folder (ms). */
export function lastModified(name: string): number {
  let m = 0
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else m = Math.max(m, fs.statSync(f).mtimeMs)
    }
  }
  try { walk(path.join(DESIGNS, name)) } catch {}
  return m
}

export function duplicateDesign(from: string, to: string) {
  if (!NAME_RE.test(to)) throw new Error("invalid design name")
  const dst = path.join(DESIGNS, to)
  if (fs.existsSync(dst)) throw new Error(`"${to}" already exists`)
  fs.cpSync(path.join(DESIGNS, from), dst, { recursive: true })
  const bj = path.join(dst, "board.json")
  try {
    const meta = JSON.parse(fs.readFileSync(bj, "utf8"))
    meta.name = to
    fs.writeFileSync(bj, JSON.stringify(meta, null, 2) + "\n")
  } catch {}
}

/** Move a design folder to hardware/.trash/<name>-<timestamp>/. Never hard-deletes. */
export function trashDesign(name: string): string {
  fs.mkdirSync(TRASH, { recursive: true })
  const dest = path.join(TRASH, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  fs.renameSync(path.join(DESIGNS, name), dest)
  try { fs.rmSync(thumbPath(name), { force: true }) } catch {}
  return path.relative(ROOT, dest).replaceAll("\\", "/")
}

export const thumbPath = (name: string) => path.join(THUMBS, `${name}.svg`)

let toSvg: ((cj: any) => string) | null | undefined
async function loadSvg() {
  if (toSvg !== undefined) return toSvg
  try {
    const m: any = await import("circuit-to-svg")
    toSvg = m.convertCircuitJsonToPcbSvg ?? null
  } catch {
    toSvg = null
  }
  return toSvg
}

/** Cache a PCB SVG of a good build (best effort). */
export async function saveThumb(name: string, circuitJson: any[]) {
  try {
    const fn = await loadSvg()
    if (!fn || !circuitJson.length) return
    const svg = fn(circuitJson)
    fs.mkdirSync(THUMBS, { recursive: true })
    fs.writeFileSync(thumbPath(name), svg)
  } catch {}
}
