// Runs one tscircuit build in its own process so the API event loop never blocks.
// Parent -> child: {name, fsMap}. Child -> parent: {type:"phase",phase} ... {type:"done",result}.
import { CircuitRunner } from "@tscircuit/eval/eval"

const toIssue = (e: any) => ({ type: e.type, message: e.message ?? e.type, ...(e.stack ? { stack: e.stack } : {}) })

process.on("disconnect", () => process.exit(1)) // parent died or restarted (tsx watch): stop routing

process.on("message", async (msg: { name: string; fsMap: Record<string, string>; mode: "quick" | "full" | "schematic" | "schematic-preview" }) => {
  const send = (m: unknown) => process.send?.(m)
  const start = Date.now()
  let result
  let runner: CircuitRunner | undefined
  try {
    const main = `designs/${msg.name}/index.tsx`
    if (!(main in msg.fsMap)) throw new Error(`${main} not found`)
    send({ type: "phase", phase: "loading" })
    const draftReady = new Error("live-schematic-ready")
    let draftSnapshot: any[] | undefined
    runner = new CircuitRunner()
    // Schematic wire layout can dominate large boards. Generate it separately from PCB routing.
    await runner.setPlatformConfigProperty("analogSimulationDisabled", true)
    if (msg.mode !== "full") await runner.setPlatformConfigProperty("partsEngineDisabled", true)
    if (!msg.mode.startsWith("schematic")) await runner.setPlatformConfigProperty("schematicDisabled", true)
    if (msg.mode !== "full") {
      await runner.setPlatformConfigProperty("routingDisabled", true)
    }
    let routing = 0
    const effects = new Map<string, any>()
    const reportEffect = () => {
      const e = effects.values().next().value
      if (!routing && e) send({ type: "phase", phase: String(e.phase), detail: String(e.effectName) })
    }
    runner.on("asyncEffect:start", (e: any) => { effects.set(e.asyncEffectId, e); reportEffect() })
    runner.on("asyncEffect:end", (e: any) => { effects.delete(e.asyncEffectId); reportEffect() })
    runner.on("board:renderPhaseStarted", (e: any) => {
      // A live edit needs symbols and ports, not the expensive obstacle-avoiding wire layout.
      // Stop at this public render-phase boundary once all earlier async effects have settled.
      if (msg.mode === "schematic-preview" && e.phase === "SchematicTraceRender" && !effects.size) {
        // eval exposes the executing circuit for diagnostics. Read its database directly:
        // getCircuitJson() would restart an intentionally interrupted first render.
        const circuit = (globalThis as any).__tscircuit_circuit
        if (circuit?.db?.toArray) { draftSnapshot = circuit.db.toArray(); throw draftReady }
      }
      if (!routing && !effects.size) send({ type: "phase", phase: String(e?.phase ?? "rendering") })
    })
    runner.on("autorouting:start", (e: any) => {
      routing++
      send({ type: "phase", phase: "PCB routing", detail: [e?.autorouterName, e?.connectionCount != null ? `${e.connectionCount} connections` : null, e?.obstacleCount != null ? `${e.obstacleCount} obstacles` : null].filter(Boolean).join(" · ") })
    })
    const routeEnded = () => { routing = Math.max(0, routing - 1); if (!routing) { send({ type: "phase", phase: "Finalising PCB" }); reportEffect() } }
    runner.on("autorouting:end", routeEnded)
    runner.on("autorouting:error", routeEnded)
    runner.on("autorouting:progress", (e: any) => {
      const p = e?.progress ?? e?.estimatedProgress
      if (typeof p === "number") send({ type: "progress", progress: p })
    })
    try {
      await runner.executeWithFsMap({ fsMap: msg.fsMap, mainComponentPath: main })
      await runner.renderUntilSettled()
    } catch (e) { if (e !== draftReady) throw e }
    send({ type: "phase", phase: "collecting" })
    const circuitJson = draftSnapshot ?? (await runner.getCircuitJson()) as any[]
    if (msg.mode === "schematic-preview") {
      const ports = new Map(circuitJson.filter((e) => e.type === "schematic_port").map((e) => [e.source_port_id, e]))
      const groups = new Map<string, { trace: any; ids: Set<string> }>()
      for (const trace of circuitJson.filter((e) => e.type === "source_trace")) {
        const key = trace.subcircuit_connectivity_map_key ?? trace.source_trace_id
        const group = groups.get(key) ?? { trace, ids: new Set<string>() }
        for (const id of trace.connected_source_port_ids ?? []) group.ids.add(id)
        groups.set(key, group)
      }
      for (const { trace, ids } of groups.values()) {
        const pins = [...ids].map((id) => ports.get(id)).filter(Boolean)
        if (pins.length < 2) continue
        circuitJson.push({ type: "schematic_trace", schematic_trace_id: `live_${trace.source_trace_id}`, source_trace_id: trace.source_trace_id, subcircuit_connectivity_map_key: trace.subcircuit_connectivity_map_key, edges: pins.slice(1).map((p: any) => ({ from: pins[0].center, to: p.center })), junctions: [] })
      }
    }
    const errors = circuitJson.filter((e) => e.type?.endsWith("_error")).map(toIssue)
    const warnings = circuitJson.filter((e) => e.type?.endsWith("_warning")).map(toIssue)
    result = { ok: errors.length === 0, circuitJson, errors, warnings, durationMs: Date.now() - start }
  } catch (e: any) {
    result = {
      ok: false, circuitJson: [], warnings: [], durationMs: Date.now() - start,
      errors: [{ type: "execution_error", message: String(e?.message ?? e), stack: e?.stack }],
    }
  }
  // Clear circuit state between evaluations, while retaining expensive imported libraries.
  runner?.clearEventListeners()
  await runner?.kill()
  process.send?.({ type: "done", result })
})
