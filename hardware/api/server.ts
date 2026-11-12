import Fastify from "fastify"
import JSZip from "jszip"
import { convertCircuitJsonToGerberFiles } from "circuit-json-to-gerber"
import fs from "node:fs"
import path from "node:path"
import { bomCsv, computeBom, cplCsv } from "./bom.js"
import { buildDesign, NAME_RE, readDesignFiles, readMeta, ROOT, safeDesignPath } from "./build.js"
import { patchBoardJson, runChecks } from "./checks.js"
import { gitCommit, gitPush, gitStatus } from "./git.js"

const app = Fastify({ logger: { level: "warn" }, bodyLimit: 20 * 1024 * 1024 })

// Local-only tool: design files are executed on build and git push is exposed, so refuse
// cross-site requests (no CORS) and DNS-rebinding hosts. The app reaches us via Vite's proxy.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin
  const originHost = origin ? origin.replace(/^https?:\/\//, "") : null
  if (!LOCAL.test(req.headers.host ?? "") || (originHost !== null && !LOCAL.test(originHost)))
    return reply.code(403).send({ error: "forbidden" })
})

const designExists = (name: string) => NAME_RE.test(name) && fs.existsSync(path.join(ROOT, "designs", name, "index.tsx"))
const notFound = (reply: any) => reply.code(404).send({ error: "design not found" })

app.get("/api/designs", async () => {
  const dir = path.join(ROOT, "designs")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && NAME_RE.test(e.name))
    .map((e) => ({ name: e.name, meta: readMeta(e.name) }))
})

app.get<{ Params: { name: string } }>("/api/designs/:name", async (req, reply) => {
  const { name } = req.params
  if (!designExists(name)) return notFound(reply)
  return { name, meta: readMeta(name), files: readDesignFiles(name) }
})

app.put<{ Params: { name: string }; Body: { files?: Record<string, string> } }>("/api/designs/:name/files", async (req, reply) => {
  const { name } = req.params
  const files = req.body?.files
  if (!NAME_RE.test(name)) return reply.code(400).send({ error: "invalid design name" })
  if (!files || typeof files !== "object") return reply.code(400).send({ error: "files required" })
  const targets: [string, string][] = []
  for (const [rel, content] of Object.entries(files)) {
    const full = safeDesignPath(name, rel)
    if (!full || typeof content !== "string") return reply.code(400).send({ error: `invalid file: ${rel}` })
    targets.push([full, content])
  }
  for (const [full, content] of targets) {
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return { ok: true, written: targets.length }
})

app.post<{ Params: { name: string }; Body: { files?: Record<string, string> } }>("/api/designs/:name/build", async (req, reply) => {
  const { name } = req.params
  const files = req.body?.files
  if (!NAME_RE.test(name)) return reply.code(400).send({ error: "invalid design name" })
  if (!designExists(name) && !files?.["index.tsx"]) return notFound(reply)
  if (files) for (const rel of Object.keys(files)) if (!safeDesignPath(name, rel)) return reply.code(400).send({ error: `invalid file: ${rel}` })
  const { ok, circuitJson, errors, warnings, durationMs } = await buildDesign(name, files)
  // design-rule checks run on every build; board.json (possibly an unsaved override) supplies the rules
  let rulesSrc = readMeta(name)?.rules
  if (files?.["board.json"]) try { rulesSrc = JSON.parse(files["board.json"]).rules } catch {}
  const checks = circuitJson.length ? await runChecks(circuitJson, rulesSrc).catch(() => null) : null
  return { ok, circuitJson, errors, warnings, durationMs, checks }
})

// Full design-rule check results (stock @tscircuit/checks + custom rules) with plain-English explanations.
app.get<{ Params: { name: string } }>("/api/designs/:name/checks", async (req, reply) => {
  const { name } = req.params
  if (!designExists(name)) return notFound(reply)
  const build = await buildDesign(name)
  if (!build.circuitJson.length) return reply.code(422).send({ error: build.errors[0]?.message ?? "build failed" })
  const meta = readMeta(name)
  const checks = await runChecks(build.circuitJson, meta?.rules)
  return { name, buildOk: build.ok, ...checks, checklist: meta?.checklist ?? [], notes: meta?.notes ?? "" }
})

// Patch board.json: { checklist?, rules?, notes?, splitNotes? } (other keys are preserved).
app.patch<{ Params: { name: string }; Body: { checklist?: unknown; rules?: unknown; notes?: string; splitNotes?: boolean; base?: string } }>(
  "/api/designs/:name/meta",
  async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return notFound(reply)
    const b = req.body ?? {}
    return patchBoardJson(name, { checklist: b.checklist, rules: b.rules, notes: b.notes, splitNotes: b.splitNotes, base: b.base })
  },
)

app.get<{ Params: { name: string }; Querystring: { qty?: string; refresh?: string } }>("/api/designs/:name/bom", async (req, reply) => {
  const { name } = req.params
  if (!designExists(name)) return notFound(reply)
  const qty = Math.max(1, parseInt(req.query.qty ?? "10", 10) || 10)
  const build = await buildDesign(name)
  if (!build.circuitJson.length) return reply.code(422).send({ error: build.errors[0]?.message ?? "build failed" })
  return computeBom(build.circuitJson, qty, req.query.refresh === "1")
})

// Protel-style extensions, which the JLCPCB uploader recognises reliably.
const GERBER_EXT: Record<string, string> = {
  F_Cu: "gtl", B_Cu: "gbl", F_Mask: "gts", B_Mask: "gbs",
  F_SilkScreen: "gto", B_SilkScreen: "gbo", F_Paste: "gtp", B_Paste: "gbp", Edge_Cuts: "gm1",
}

app.get<{ Params: { name: string } }>("/api/designs/:name/export", async (req, reply) => {
  const { name } = req.params
  if (!designExists(name)) return notFound(reply)
  const build = await buildDesign(name)
  if (!build.circuitJson.length) return reply.code(422).send({ error: build.errors[0]?.message ?? "build failed" })
  const zip = new JSZip()
  for (const [file, content] of Object.entries(convertCircuitJsonToGerberFiles(build.circuitJson))) {
    const base = file.replace(/\.gbr$/, "")
    zip.file(GERBER_EXT[base] ? `${base}.${GERBER_EXT[base]}` : file, content)
  }
  zip.file("bom.csv", await bomCsv(build.circuitJson))
  zip.file("cpl.csv", cplCsv(build.circuitJson))
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const rev = String(readMeta(name)?.revision ?? "0").replace(/[^A-Za-z0-9._-]/g, "")
  reply
    .header("Content-Type", "application/zip")
    .header("Content-Disposition", `attachment; filename="${name}-r${rev}-jlcpcb.zip"`)
    .header("Access-Control-Expose-Headers", "X-Build-Errors, Content-Disposition")
  if (build.errors.length) reply.header("X-Build-Errors", String(build.errors.length))
  return reply.send(buf)
})

app.get("/api/git/status", async () => gitStatus())

app.post<{ Body: { message?: string } }>("/api/git/commit", async (req, reply) => {
  const message = req.body?.message?.trim()
  if (!message) return reply.code(400).send({ error: "commit message required" })
  const r = await gitCommit(message)
  return reply.code(r.ok ? 200 : 500).send(r)
})

app.post("/api/git/push", async (_req, reply) => {
  const r = await gitPush()
  return reply.code(r.ok ? 200 : 500).send(r)
})

app.setErrorHandler((err: any, _req, reply) => {
  reply.code(err.statusCode ?? 500).send({ error: err.message ?? String(err) })
})

await app.listen({ host: "127.0.0.1", port: Number(process.env.HW_API_PORT ?? 3101) })
console.log(`hardware api on http://127.0.0.1:${app.server.address() && (app.server.address() as any).port}`)
