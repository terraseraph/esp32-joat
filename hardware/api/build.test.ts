import { test } from "node:test"
import assert from "node:assert/strict"
import { buildDesign, buildStatus, cancelBuild } from "./build.js"

test("build deadlines release the queue, and cancel clears queued work", async () => {
  const name = "build-deadline-test"
  const source = { "index.tsx": "while (true) {}\nexport default () => <board />" }
  const previous = process.env.HW_QUICK_TIMEOUT_MS
  try {
    process.env.HW_QUICK_TIMEOUT_MS = "30"
    const result = await buildDesign(name, source, "quick", { background: true })
    assert.equal(result.ok, false)
    assert.equal(result.errors[0].type, "build_timeout")
    assert.equal(buildStatus(name).state, "idle")
    process.env.HW_QUICK_TIMEOUT_MS = "15000"
    const a = buildDesign(name, source, "quick", { background: true })
    const b = buildDesign(name, source, "quick", { background: true })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(cancelBuild(name), true)
    assert.equal((await a).cancelled, true)
    assert.equal((await b).cancelled, true)
    assert.equal(buildStatus(name).state, "idle")
    const recovered = await buildDesign(name, { "index.tsx": 'export default () => <board width="20mm" height="20mm" />' }, "quick", { background: true })
    assert.equal(recovered.ok, true, JSON.stringify(recovered.errors))
    assert.ok(recovered.circuitJson.some((e) => e.type === "pcb_board"))
    const next = await buildDesign(name, { "index.tsx": 'export default () => <board width="30mm" height="20mm" />' }, "quick", { background: true })
    assert.equal(next.ok, true)
    assert.equal(next.circuitJson.find((e) => e.type === "pcb_board")?.width, 30)
    assert.equal(recovered.circuitJson.find((e) => e.type === "pcb_board")?.width, 20)
  } finally {
    cancelBuild(name)
    if (previous === undefined) delete process.env.HW_QUICK_TIMEOUT_MS
    else process.env.HW_QUICK_TIMEOUT_MS = previous
  }
})

test("live schematic edits keep symbols and direct connections without running PCB or wire routing", async () => {
  const name = "live-schematic-test"
  const source = 'export default () => <board width="20mm" height="20mm"><resistor name="R1" resistance="10k" footprint="0603" schX={-2} /><capacitor name="C1" capacitance="100nF" footprint="0603" schX={2} /><trace from=".R1 > .pin1" to=".C1 > .pin1" /><trace from=".R1 > .pin2" to="net.GND" /><trace from=".C1 > .pin2" to="net.GND" /></board>'
  const first = await buildDesign(name, { "index.tsx": source }, "schematic-preview", { background: true })
  assert.equal(first.ok, true, JSON.stringify(first.errors))
  assert.equal(first.circuitJson.filter((e) => e.type === "schematic_component").length, 2)
  assert.equal(first.circuitJson.filter((e) => e.type === "pcb_trace").length, 0)
  const wire = first.circuitJson.find((e) => e.type === "schematic_trace")
  assert.ok(wire.schematic_trace_id.startsWith("live_"))
  assert.equal(wire.edges.length, 1)
  assert.equal(first.circuitJson.filter((e) => e.type === "schematic_trace").length, 2)
  const second = await buildDesign(name, { "index.tsx": source.replace("100nF", "220nF") }, "schematic-preview", { background: true })
  assert.equal(second.ok, true)
  assert.ok(second.circuitJson.some((e) => e.type === "schematic_component" && e.symbol_display_value === "220nF"))
})
