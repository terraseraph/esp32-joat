import fs from "node:fs"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { buildDesign, readDesignFiles, ROOT } from "./build.js"
import { assignGpio, connectPins, gpioMap, libMentions, netExists, normNet, renameNet } from "./connect.js"
import { indexCircuit, suggestNetName } from "../shared/nets.js"

type Deps = { designExists: (n: string) => boolean; notFound: (r: any) => any }

/**
 * Connect / nets / GPIO endpoints. Every edit endpoint takes the design `name`, edits `index.tsx`
 * and returns `{ ok, changed, how, source, written }`. Pass `source` (the editor's unsaved text) to get
 * the edited text back WITHOUT writing to disk; omit it and the file on disk is edited in place.
 */
export function registerConnectRoutes(app: FastifyInstance, { designExists, notFound }: Deps) {
  const file = (name: string) => path.join(ROOT, "designs", name, "index.tsx")
  const load = (name: string, source?: string) => (typeof source === "string" ? source : fs.readFileSync(file(name), "utf8"))
  const finish = (name: string, body: { source?: string }, r: { source: string; changed: boolean; how?: string }, extra: object = {}) => {
    const write = typeof body.source !== "string" && r.changed
    if (write) fs.writeFileSync(file(name), r.source)
    return { ok: true, changed: r.changed, how: r.how, source: r.source, written: write, ...extra }
  }
  const fail = (reply: any, e: any) => reply.code(400).send({ error: e.message ?? String(e) })

  const nets = async (name: string, circuitJson: any[] | undefined, reply: any) => {
    if (!designExists(name)) return notFound(reply)
    const circuit = circuitJson?.length ? circuitJson : (await buildDesign(name)).circuitJson
    const idx = indexCircuit(circuit)
    return { nets: idx.nets.map((n) => ({ name: n.name, pinCount: n.pins.length, pins: n.pins.map((p) => `${p.ref}.${p.pin}`), isGround: n.isGround, isPower: n.isPower })) }
  }
  // GET builds the design; POST lets the app send the circuit it already has.
  app.get<{ Params: { name: string } }>("/api/designs/:name/nets", (req, reply) => nets(req.params.name, undefined, reply))
  app.post<{ Params: { name: string }; Body: { circuitJson?: any[] } }>("/api/designs/:name/nets", (req, reply) => nets(req.params.name, req.body?.circuitJson, reply))

  type Pin = { ref?: string; pin?: string }
  app.post<{ Params: { name: string }; Body: { a?: Pin; b?: Pin; net?: string; source?: string } }>("/api/designs/:name/connect", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return notFound(reply)
    const { a, b, net, source } = req.body ?? {}
    if (!a?.ref || !a.pin) return fail(reply, new Error("a: {ref, pin} required"))
    if (b && (!b.ref || !b.pin)) return fail(reply, new Error("b must be {ref, pin}"))
    try {
      const src = load(name, source)
      const used = [...src.matchAll(/net\.([A-Za-z_]\w*)/g)].map((m) => m[1])
      const chosen = net?.trim() || suggestNetName(a as any, b as any, used)
      return finish(name, req.body, connectPins(src, a as any, b as any, chosen), { net: normNet(chosen) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.post<{ Params: { name: string }; Body: { from?: string; to?: string; source?: string; merge?: boolean } }>("/api/designs/:name/rename-net", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return notFound(reply)
    const { from, to, source, merge } = req.body ?? {}
    if (!from || !to) return fail(reply, new Error("from and to required"))
    try {
      // every design file is renamed together; `source` (the editor's unsaved index.tsx) replaces the disk copy
      const files = { ...readDesignFiles(name), "index.tsx": load(name, source) }
      const lib = libMentions(from)
      if (lib.length) return fail(reply, new Error(`"${from}" is also used in lib/${lib.join(", lib/")}; renaming it here would split the net. Rename it in the lib block (or pass the net in as a prop) instead.`))
      const clash = normNet(to) === normNet(from) ? [] : netExists(files, to)
      if (clash.length && !merge) return fail(reply, new Error(`net "${normNet(to)}" already exists (in ${clash.join(", ")}); renaming would merge the two nets. Pass merge:true to do it anyway.`))
      const r = renameNet(files, from, to)
      if (!r.count) return fail(reply, new Error(`"${from}" is not written in any design file`))
      const write = typeof source !== "string"
      if (write) for (const [k, v] of Object.entries(r.files)) fs.writeFileSync(path.join(ROOT, "designs", name, k), v)
      return { ok: true, changed: true, how: `renamed ${r.count} reference(s) in ${Object.keys(r.files).join(", ")}`, source: r.files["index.tsx"] ?? files["index.tsx"], files: r.files, written: write, count: r.count }
    } catch (e) {
      return fail(reply, e)
    }
  })

  const gpio = (name: string, source: string | undefined, reply: any) => (designExists(name) ? { map: gpioMap(load(name, source)) } : notFound(reply))
  app.get<{ Params: { name: string } }>("/api/designs/:name/gpio", (req, reply) => gpio(req.params.name, undefined, reply))
  app.post<{ Params: { name: string }; Body: { source?: string } }>("/api/designs/:name/gpio", (req, reply) => gpio(req.params.name, req.body?.source, reply))
  app.post<{ Params: { name: string }; Body: { pin?: string; net?: string | null; source?: string } }>("/api/designs/:name/gpio/assign", async (req, reply) => {
    const { name } = req.params
    if (!designExists(name)) return notFound(reply)
    const { pin, net, source } = req.body ?? {}
    if (!pin) return fail(reply, new Error("pin required"))
    try {
      const r = assignGpio(load(name, source), pin, net ? net : null)
      return finish(name, req.body, r, { map: gpioMap(r.source) })
    } catch (e) {
      return fail(reply, e)
    }
  })
}
