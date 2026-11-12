// Runs one tscircuit build in its own process so the API event loop never blocks.
// Parent -> child: {name, fsMap}. Child -> parent: {type:"phase",phase} ... {type:"done",result}.
import { CircuitRunner } from "@tscircuit/eval/eval"

const toIssue = (e: any) => ({ type: e.type, message: e.message ?? e.type, ...(e.stack ? { stack: e.stack } : {}) })

process.on("disconnect", () => process.exit(1)) // parent died or restarted (tsx watch): stop routing

process.once("message", async (msg: { name: string; fsMap: Record<string, string>; quick?: boolean }) => {
  const send = (m: unknown) => process.send?.(m)
  const start = Date.now()
  let result
  try {
    const main = `designs/${msg.name}/index.tsx`
    if (!(main in msg.fsMap)) throw new Error(`${main} not found`)
    send({ type: "phase", phase: "loading" })
    const runner = new CircuitRunner()
    // quick mode: skip schematic generation (its trace routing dominates big boards); PCB placement is unaffected
    if (msg.quick) await runner.setPlatformConfigProperty("schematicDisabled", true)
    runner.on("board:renderPhaseStarted", (e: any) => send({ type: "phase", phase: String(e?.phase ?? "rendering") }))
    runner.on("autorouting:start", () => send({ type: "phase", phase: "AutorouterPhase" }))
    runner.on("autorouting:progress", (e: any) => {
      const p = e?.progress ?? e?.estimatedProgress
      if (typeof p === "number") send({ type: "progress", progress: p })
    })
    await runner.executeWithFsMap({ fsMap: msg.fsMap, mainComponentPath: main })
    await runner.renderUntilSettled()
    send({ type: "phase", phase: "collecting" })
    const circuitJson = (await runner.getCircuitJson()) as any[]
    const errors = circuitJson.filter((e) => e.type?.endsWith("_error")).map(toIssue)
    const warnings = circuitJson.filter((e) => e.type?.endsWith("_warning")).map(toIssue)
    result = { ok: errors.length === 0, circuitJson, errors, warnings, durationMs: Date.now() - start }
  } catch (e: any) {
    result = {
      ok: false, circuitJson: [], warnings: [], durationMs: Date.now() - start,
      errors: [{ type: "execution_error", message: String(e?.message ?? e), stack: e?.stack }],
    }
  }
  // exit only once the (possibly multi-MB) result has been flushed to the pipe
  process.send?.({ type: "done", result }, () => process.exit(0))
})
