import { test } from "node:test"
import assert from "node:assert/strict"
import { TOOLS, ToolError, checkArgs, findTool, inputSchema, runTool, type ToolCtx } from "./tools.js"

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
/** A transport that records calls and answers from a table of "METHOD path" -> body (or [status, body]). */
function fake(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: any }[] = []
  const ctx: ToolCtx = {
    call: async (method, path, body) => {
      calls.push({ method, path, body })
      const hit = routes[`${method} ${path}`]
      if (hit === undefined) return { status: 404, type: "application/json", body: enc({ error: `no route ${method} ${path}` }) }
      const [status, data] = Array.isArray(hit) && typeof hit[0] === "number" ? (hit as [number, unknown]) : [200, hit]
      return { status, type: "application/json", body: enc(data) }
    },
  }
  return { ctx, calls }
}
const RUN = { id: "r1", snapshotId: "20260101-000000", edits: [] }

test("every tool has a unique name, a description, a kind and a valid object schema", () => {
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length)
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z_]+$/)
    assert.ok(t.description.length > 20, t.name)
    assert.ok(["read", "edit", "run"].includes(t.kind))
    const s = inputSchema(t)
    assert.equal(s.type, "object")
    for (const r of s.required) assert.ok(r in s.properties, `${t.name}: required "${r}" is not a property`)
    for (const [k, p] of Object.entries<any>(s.properties)) assert.ok(p.type, `${t.name}.${k} has no type`)
  }
})

test("the registry covers the original MCP tools and the structured edits", () => {
  const names = TOOLS.map((t) => t.name)
  for (const n of ["list_designs", "read_design", "build_design", "run_checks", "cost_summary", "gpio_map", "list_components", "list_nets", "explain_design", "get_bom", "get_snapshot", "list_requests", "propose_change", "list_proposals",
    "add_part", "patch_component", "connect_pins", "set_pin_net", "rename_net", "assign_gpio", "apply_swap", "search_parts", "list_palette", "list_snapshots", "create_snapshot", "restore_snapshot", "run_status", "accept_run", "rollback_run"])
    assert.ok(names.includes(n), `missing ${n}`)
  assert.deepEqual(TOOLS.filter((t) => t.kind === "edit").map((t) => t.name), ["add_part", "patch_component", "connect_pins", "set_pin_net", "rename_net", "assign_gpio", "apply_swap"])
})

test("arguments are checked against the schema before anything is called", async () => {
  const { ctx, calls } = fake({})
  await assert.rejects(runTool("nope", {}, ctx), /unknown tool/)
  await assert.rejects(runTool("read_design", {}, ctx), /"name" is required/)
  await assert.rejects(runTool("read_design", { name: 5 }, ctx), /must be string/)
  await assert.rejects(runTool("build_design", { name: "x", mode: "slow" }, ctx), /one of quick, full/)
  await assert.rejects(runTool("read_design", { name: "x", extra: 1 }, ctx), /unknown argument "extra"/)
  await assert.rejects(runTool("connect_pins", { name: "x", a: { ref: "R1" } }, ctx), /"a.pin" is required/)
  assert.doesNotThrow(() => checkArgs(findTool("set_pin_net")!, { name: "x", ref: "R1", pin: "pin1", net: null }))
  assert.equal(calls.length, 0)
})

test("an edit opens a run first, performs the edit, then records it, and returns no source text", async () => {
  const { ctx, calls } = fake({
    "POST /api/designs/demo/run/begin": RUN,
    "POST /api/designs/demo/components": { ok: true, name: "R7", snippet: '<resistor name="R7" />', source: "x".repeat(5000) },
    "POST /api/designs/demo/run/log": { ok: true },
  })
  const out = await runTool("add_part", { name: "demo", item: "resistor", props: { resistance: "10k" } }, ctx)
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/designs/demo/run/begin", "POST /api/designs/demo/components", "POST /api/designs/demo/run/log"])
  assert.deepEqual(calls[1].body, { item: "resistor", props: { resistance: "10k" } })
  assert.equal(calls[2].body.summary, "added R7")
  assert.deepEqual(out, { part: "R7", snippet: '<resistor name="R7" />', summary: "added R7", run: { id: "r1", snapshotId: "20260101-000000", edits: 1 } })
  assert.ok(JSON.stringify(out).length < 300)
})

test("a failed edit is reported and not recorded on the run", async () => {
  const { ctx, calls } = fake({ "POST /api/designs/demo/run/begin": RUN, "POST /api/designs/demo/connect": [400, { error: "no component named R9" }] })
  await assert.rejects(runTool("connect_pins", { name: "demo", a: { ref: "R9", pin: "pin1" }, net: "GND" }, ctx), (e: any) => e instanceof ToolError && /400: no component named R9/.test(e.message))
  assert.equal(calls.some((c) => c.path.endsWith("/run/log")), false)
})

test("read tools map to their routes and trim large results", async () => {
  const { ctx, calls } = fake({
    "POST /api/designs/demo/build": { ok: true, mode: "quick", durationMs: 9, errors: [], warnings: [{ message: "w" }], circuitJson: new Array(400).fill({ type: "x" }), checks: { counts: { error: 2 } } },
    "GET /api/designs/demo/checks?mode=quick": { counts: { error: 2 } },
    "GET /api/parts/search?q=10k%200603&limit=8": [{ lcsc: "C1" }],
    "GET /api/palette": { primitives: [{ id: "resistor", label: "Resistor", tag: "resistor", props: [{ name: "resistance", type: "string", required: true, doc: "long text" }] }], lib: [{ id: "lib:Buck5V", label: "Buck 5 V", tag: "Buck5V", props: [] }] },
    "GET /api/designs/demo/cost?qty=25": { perBoard: 1 },
  })
  assert.deepEqual(await runTool("build_design", { name: "demo" }, ctx), { ok: true, mode: "quick", durationMs: 9, errors: [], warnings: [{ message: "w" }], checks: { error: 2 }, elements: 400 })
  assert.equal(calls[0].body.mode, "quick")
  assert.deepEqual(await runTool("run_checks", { name: "demo" }, ctx), { counts: { error: 2 } })
  assert.deepEqual(await runTool("search_parts", { query: "10k 0603" }, ctx), [{ lcsc: "C1" }])
  assert.deepEqual(await runTool("list_palette", { query: "buck" }, ctx), { primitives: [], lib: [{ id: "lib:Buck5V", label: "Buck 5 V", description: undefined, props: [] }] })
  assert.deepEqual(await runTool("cost_summary", { name: "demo", qty: 25 }, ctx), { perBoard: 1 })
})

test("order tools record locally, send the documented bodies and return a trimmed order", async () => {
  const order = { id: "20260101-000000", design: "demo", revision: "A", status: "draft", qty: 5, options: { assembly: "top" }, stale: false, packageOnDisk: true,
    package: { file: "demo.zip", bytes: 10, builtAt: "t", sha256: "x", sourceHash: "y", files: [{ name: "bom.csv", bytes: 1, sha256: "z" }], cpl: { total: 1, verified: 1, override: 0, unverified: [] } },
    preflight: { ok: true, checkedAt: "t", gates: [{ id: "build", level: "pass", text: "ok" }], stock: [{ lcsc: "C1", state: "unknown" }, { lcsc: "C2", state: "short" }, { lcsc: "C3", state: "ok" }] },
    quote: { total: 12 }, costBasis: { qty: 5 }, vendor: { orderNumber: "" }, tracking: { number: "" }, note: "", history: [] }
  const { ctx, calls } = fake({
    "POST /api/designs/demo/orders": order,
    "PATCH /api/designs/demo/orders/20260101-000000": { ...order, status: "quoted" },
    "GET /api/orders": [],
  })
  const made = await runTool("create_draft_order", { name: "demo", qty: 5, handFit: ["J1"], shippingAmount: 20 }, ctx)
  assert.deepEqual(calls[0].body, { qty: 5, options: { assembly: undefined, handFit: ["J1"] }, shipping: { method: undefined, amount: 20 }, tax: undefined, note: undefined })
  assert.deepEqual(made.package.files, ["bom.csv"])
  assert.deepEqual(made.preflight.stockProblems, { lines: [{ lcsc: "C2", state: "short" }], unknown: 1, checked: 3 })
  assert.equal(made.costBasis, undefined)
  const upd = await runTool("update_order", { name: "demo", id: order.id, status: "quoted", vendor: { quotedTotal: 31.5 } }, ctx)
  assert.equal(upd.status, "quoted")
  assert.deepEqual(calls[1].body.vendor, { quotedTotal: 31.5 })
  assert.deepEqual(await runTool("list_orders", {}, ctx), [])
  await assert.rejects(runTool("update_order", { name: "demo", id: order.id, status: "draft" }, ctx), /one of quoted/)
  await assert.rejects(runTool("create_draft_order", { name: "demo" }, ctx), /"qty" is required/)
})
