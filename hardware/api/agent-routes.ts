// Routes that exist for the shared agent tool registry (hardware/shared/tools.ts):
// the working-draft "run" (begin / log / accept / rollback) and a single-pin net edit.
//
// A run groups an agent's structured edits. Opening one takes an automatic snapshot of the design's
// files; the edits then write to the design directly, so builds and checks see them. The user keeps
// the whole run (accept) or undoes it (rollback restores the snapshot) instead of approving each edit.
import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { readDesignFiles, ROOT, safeDesignPath } from "./build.js"
import { setPinNet } from "./connect.js"
import { createSnapshot, readSnapshot } from "./iterate.js"

export type Run = { id: string; label: string; startedAt: string; snapshotId: string; edits: { at: string; tool: string; summary: string }[] }

// Kept on disk (gitignored .cache) so an open run survives an API restart.
const runFile = (name: string) => path.join(ROOT, ".cache", "runs", `${name}.json`)
export function readRun(name: string): Run | null {
  try { return JSON.parse(fs.readFileSync(runFile(name), "utf8")) } catch { return null }
}
const writeRun = (name: string, run: Run) => {
  fs.mkdirSync(path.dirname(runFile(name)), { recursive: true })
  fs.writeFileSync(runFile(name), JSON.stringify(run))
}
const closeRun = (name: string) => fs.rmSync(runFile(name), { force: true })

export function beginRun(name: string, label = ""): Run {
  const open = readRun(name)
  // a run whose snapshot has been deleted cannot be rolled back: start a new one
  if (open && readSnapshot(name, open.snapshotId)) return open
  const clean = label.trim().slice(0, 80)
  const snap = createSnapshot(name, readDesignFiles(name), `Before agent run${clean ? `: ${clean}` : ""}`, true)
  const run: Run = { id: randomUUID().slice(0, 8), label: clean, startedAt: new Date().toISOString(), snapshotId: snap.id, edits: [] }
  writeRun(name, run)
  return run
}

export function registerAgentRoutes(app: FastifyInstance, designExists: (n: string) => boolean) {
  const missing = (reply: any) => reply.code(404).send({ error: "design not found" })
  type P = { Params: { name: string } }

  app.get<P>("/api/designs/:name/run", async (req, reply) => (designExists(req.params.name) ? { run: readRun(req.params.name) } : missing(reply)))

  app.post<P & { Body: { label?: string } }>("/api/designs/:name/run/begin", async (req, reply) =>
    designExists(req.params.name) ? beginRun(req.params.name, String(req.body?.label ?? "")) : missing(reply))

  app.post<P & { Body: { tool?: string; summary?: string } }>("/api/designs/:name/run/log", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return missing(reply)
    const run = readRun(name)
    if (!run) return reply.code(409).send({ error: "no open run" })
    run.edits.push({ at: new Date().toISOString(), tool: String(req.body?.tool ?? "").slice(0, 60), summary: String(req.body?.summary ?? "").slice(0, 300) })
    writeRun(name, run)
    return { ok: true, edits: run.edits.length }
  })

  app.post<P>("/api/designs/:name/run/accept", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return missing(reply)
    const run = readRun(name)
    if (!run) return reply.code(409).send({ error: "no open run" })
    closeRun(name)
    return { ok: true, kept: run.edits.length, snapshotId: run.snapshotId }
  })

  app.post<P>("/api/designs/:name/run/rollback", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return missing(reply)
    const run = readRun(name)
    if (!run) return reply.code(409).send({ error: "no open run" })
    // the snapshot restore route also backs up the current files first, so a rollback can be undone
    const r = await app.inject({ method: "POST", url: `/api/designs/${name}/snapshots/${run.snapshotId}/restore` })
    if (r.statusCode !== 200) return reply.code(409).send({ error: `could not restore the run's snapshot ${run.snapshotId}: ${r.json()?.error ?? r.statusCode}` })
    closeRun(name)
    return { ok: true, undone: run.edits.length, restored: run.snapshotId, backup: r.json().backup?.id, files: r.json().files }
  })

  // Set (or with net null remove) the net of one pin in index.tsx.
  app.post<P & { Body: { ref?: string; pin?: string; net?: string | null } }>("/api/designs/:name/pin-net", async (req, reply) => {
    const { name } = req.params
    const full = designExists(name) ? safeDesignPath(name, "index.tsx") : null
    if (!full) return missing(reply)
    const { ref, pin, net } = req.body ?? {}
    if (!ref || !pin || (net !== null && typeof net !== "string")) return reply.code(400).send({ error: "ref, pin and net (string or null) required" })
    try {
      const r = setPinNet(fs.readFileSync(full, "utf8"), { ref, pin }, net)
      if (r.changed) fs.writeFileSync(full, r.source)
      return { ok: true, changed: r.changed, how: r.how, written: r.changed }
    } catch (e: any) {
      return reply.code(400).send({ error: e.message ?? String(e) })
    }
  })
}
