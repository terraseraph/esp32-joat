import { buildDesign, readMeta } from "./build.js"
import { explain } from "./explain.js"
import { components, nets, snapshotPng } from "./inspect.js"

/** Read-only inspection endpoints. They reuse the cached build, so they are instant after the first build.
 *  They use the quick (unrouted) build by default, which has every part, position and net; `?mode=full` routes first. */
export function registerInspectRoutes(app: any, designExists: (n: string) => boolean) {
  const built = async (name: string, reply: any, mode?: string) => {
    if (!designExists(name)) { reply.code(404).send({ error: "design not found" }); return null }
    const b = await buildDesign(name, undefined, mode === "full" ? "full" : "quick")
    if (!b.circuitJson.length) { reply.code(422).send({ error: b.errors[0]?.message ?? "build failed" }); return null }
    return b
  }

  app.get("/api/designs/:name/components", async (req: any, reply: any) => {
    const b = await built(req.params.name, reply, req.query?.mode)
    return b && components(req.params.name, b.circuitJson)
  })
  app.get("/api/designs/:name/nets", async (req: any, reply: any) => {
    const b = await built(req.params.name, reply, req.query?.mode)
    return b && nets(b.circuitJson)
  })
  app.get("/api/designs/:name/explain", async (req: any, reply: any) => {
    const b = await built(req.params.name, reply, req.query?.mode)
    return b && explain(readMeta(req.params.name), components(req.params.name, b.circuitJson), nets(b.circuitJson))
  })
  app.get("/api/designs/:name/snapshot.png", async (req: any, reply: any) => {
    const view = req.query?.view === "schematic" ? "schematic" : "pcb"
    const width = Math.min(4000, Math.max(200, parseInt(req.query?.width ?? "1600", 10) || 1600))
    const b = await built(req.params.name, reply, req.query?.mode)
    if (!b) return
    return reply.header("Content-Type", "image/png").send(snapshotPng(b.circuitJson, view, width))
  })
}
