import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { AI_TOOLS, LIMITS, complete, listModels, parseEnvFile, registerAiRoutes, startChat, validateFiles } from "./ai.js"
import { TOOLS } from "../shared/tools.js"

test("model lists use provider credentials, paginate Claude and omit non-text OpenAI models", async () => {
  const original = globalThis.fetch
  try {
    let calls = 0
    globalThis.fetch = (async (url, init) => {
      assert.equal((init?.headers as Record<string, string>)["x-api-key"], "test-secret")
      if (calls++ === 0) return Response.json({ data: [{ id: "model-a", display_name: "Model A" }], has_more: true, last_id: "model-a" })
      assert.match(String(url), /after_id=model-a/)
      return Response.json({ data: [{ id: "model-b", display_name: "Model B" }], has_more: false })
    }) as typeof fetch
    assert.deepEqual((await listModels("anthropic", "test-secret")).map((m) => m.id), ["model-a", "model-b"])
    globalThis.fetch = (async () => Response.json({ data: [{ id: "gpt-text" }, { id: "gpt-image" }, { id: "text-embedding" }, { id: "gpt-text" }] })) as typeof fetch
    assert.deepEqual(await listModels("openai", "test-secret"), [{ id: "gpt-text", label: "gpt-text" }])
    globalThis.fetch = (async () => Response.json({ error: "test-secret" }, { status: 401 })) as typeof fetch
    await assert.rejects(listModels("nous", "test-secret"), (e: any) => /401/.test(e.message) && !e.message.includes("test-secret"))
  } finally { globalThis.fetch = original }
})

test("provider adapters use the correct endpoint, authentication and text extraction", async () => {
  const original = globalThis.fetch
  try {
    for (const provider of ["openai", "anthropic", "nous"] as const) {
      let request: any
      globalThis.fetch = (async (url, init) => {
        request = { url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) }
        return Response.json(provider === "openai" ? { output: [{ content: [{ type: "output_text", text: "answer" }] }] } : provider === "anthropic" ? { content: [{ type: "text", text: "answer" }] } : { choices: [{ message: { content: "answer" } }] })
      }) as typeof fetch
      assert.equal(await complete(provider, { key: "test-secret", model: "test-model" }, "instructions", [{ role: "user", content: "question" }], AbortSignal.timeout(1000)), "answer")
      assert.equal(request.body.model, "test-model")
      if (provider === "anthropic") { assert.match(request.url, /anthropic.com\/v1\/messages$/); assert.equal(request.headers["x-api-key"], "test-secret") }
      if (provider === "openai") { assert.match(request.url, /openai.com\/v1\/responses$/); assert.equal(request.body.store, false) }
      if (provider === "nous") assert.match(request.url, /nousresearch.com\/v1\/chat\/completions$/)
    }
    globalThis.fetch = (async () => Response.json({ error: { message: "test-secret" } }, { status: 401 })) as typeof fetch
    await assert.rejects(complete("openai", { key: "test-secret", model: "test" }, "", [], AbortSignal.timeout(1000)), (e: any) => /401/.test(e.message) && !e.message.includes("test-secret"))
    globalThis.fetch = (async () => Response.json({ status: "incomplete" })) as typeof fetch
    await assert.rejects(complete("openai", { key: "test", model: "test" }, "", [], AbortSignal.timeout(1000)), /cut short/)
  } finally { globalThis.fetch = original }
})

test("whole-file proposals reject path escapes, shared files, deletions and invalid TSX", () => {
  for (const files of [{ "../outside.tsx": "" }, { "lib/shared.tsx": null }, { "board.json": "{}" }, { "index.tsx": null }, { "index.tsx": "const x = <board>" }])
    assert.throws(() => validateFiles("test", files))
  assert.deepEqual(validateFiles("test", { "index.tsx": "export default () => <board />" }), { "index.tsx": "export default () => <board />" })
})

test(".env parsing keeps only provider keys and models", () => {
  assert.deepEqual(parseEnvFile('# c\nANTHROPIC_API_KEY="sk-a"\nexport OPENAI_MODEL=gpt-x\nPATH=/bin\nNOUS_API_KEY=\n'), { ANTHROPIC_API_KEY: "sk-a", OPENAI_MODEL: "gpt-x" })
})

test("the assistant uses the shared registry, minus image tools and the user's own decisions", () => {
  const hidden = TOOLS.filter((t) => !AI_TOOLS.includes(t)).map((t) => t.name).sort()
  assert.deepEqual(hidden, ["accept_run", "get_snapshot", "restore_snapshot", "rollback_run"])
  for (const t of AI_TOOLS) assert.equal(t, TOOLS.find((x) => x.name === t.name)) // the same objects, not copies
})

// What each provider sends back for one tool call, then for a final text answer.
const toolCallReply = (provider: string, name: string, args: object) =>
  provider === "anthropic" ? { content: [{ type: "tool_use", id: "c1", name, input: args }] }
  : provider === "openai" ? { output: [{ type: "function_call", call_id: "c1", name, arguments: JSON.stringify(args) }] }
  : { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }
const textReply = (provider: string, text: string) =>
  provider === "anthropic" ? { content: [{ type: "text", text }] } : provider === "openai" ? { output: [{ content: [{ type: "output_text", text }] }] } : { choices: [{ message: { content: text } }] }

test("each provider gets the registry as native tools and receives tool results in its own format", async () => {
  const original = globalThis.fetch
  try {
    for (const provider of ["openai", "anthropic", "nous"] as const) {
      const bodies: any[] = []
      globalThis.fetch = (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json(bodies.length === 1 ? toolCallReply(provider, "list_nets", { name: "x" }) : textReply(provider, "done"))
      }) as typeof fetch
      const chat = startChat(provider, { key: "test-secret", model: "m" }, "sys", [{ role: "user", content: "hi" }], AI_TOOLS)
      const first = await chat.step(AbortSignal.timeout(1000))
      assert.deepEqual(first.calls, [{ id: "c1", name: "list_nets", args: { name: "x" } }])
      chat.results([{ id: "c1", content: "[]" }])
      assert.equal((await chat.step(AbortSignal.timeout(1000))).text, "done")
      const sent = bodies[0].tools
      assert.equal(sent.length, AI_TOOLS.length)
      const def = provider === "nous" ? sent[0].function : sent[0]
      assert.equal(def.name, AI_TOOLS[0].name)
      assert.ok((provider === "anthropic" ? def.input_schema : def.parameters).properties)
      const back = JSON.stringify(provider === "openai" ? bodies[1].input : bodies[1].messages)
      assert.match(back, provider === "anthropic" ? /"tool_result","tool_use_id":"c1"/ : provider === "openai" ? /"function_call_output","call_id":"c1"/ : /"role":"tool","tool_call_id":"c1"/)
    }
  } finally { globalThis.fetch = original }
})

test("AI route runs registry tools against the API, records the trail, bounds the loop and never returns credentials", async () => {
  const app = Fastify()
  registerAiRoutes(app, (name) => name === "base-s3")
  // stand-ins for the designer routes the tools call
  const hits: string[] = []
  let proposal: any
  const run = { id: "r1", snapshotId: "s1", edits: [] as any[] }
  app.get("/api/parts/search", async (req: any) => { hits.push(`search ${req.query.q}`); return [{ lcsc: "C123", mfr: "Test", package: "0603", description: "10k", stock: 100, price: 0.01, tier: "basic", footprint: "0603" }] })
  app.post("/api/designs/:name/run/begin", async () => run)
  app.post("/api/designs/:name/run/log", async (req: any) => { run.edits.push(req.body); return { ok: true } })
  app.post("/api/designs/:name/components", async (req: any) => { hits.push(`add ${req.body.item}`); return { ok: true, name: "R2", snippet: "<resistor />", source: "SOURCE-NOT-FOR-THE-MODEL" } })
  app.post("/api/designs/:name/build", async () => { hits.push("build"); return { ok: true, mode: "quick", errors: [], warnings: [], durationMs: 5, circuitJson: [1, 2], checks: { counts: { error: 0 } } } })
  app.post("/api/designs/:name/proposals", async (req: any) => { proposal = req.body; return { id: "review-me", status: "pending", summary: req.body.summary, diffs: [] } })
  const original = globalThis.fetch
  try {
    const ask = (message = "Add a 10k resistor") => app.inject({ method: "POST", url: "/api/designs/base-s3/ai", payload: { provider: "openai", message } })
    assert.equal((await ask()).statusCode, 400)
    assert.equal((await app.inject({ method: "PUT", url: "/api/ai/providers/openai", payload: { model: "test-model", apiKey: "test-secret" } })).statusCode, 200)
    assert.equal((await app.inject("/api/ai/providers")).body.includes("test-secret"), false)
    assert.deepEqual((await app.inject("/api/ai/tools")).json().map((t: any) => t.name), AI_TOOLS.map((t) => t.name))

    const script = [
      ["search_parts", { query: "10k 0603" }],
      ["add_part", { name: "base-s3", item: "resistor", props: { resistance: "10k", lcsc: "C123" } }],
      ["add_part", { name: "relay-8", item: "resistor" }], // another design: refused
      ["rollback_run", { name: "base-s3" }], // the user's decision: not offered
      ["build_design", { name: "base-s3" }],
      ["propose_change", { name: "base-s3", summary: "bad", files: { "lib/x.tsx": "x" } }], // shared lib: refused
      ["propose_change", { name: "base-s3", summary: "Rework", files: { "index.tsx": "export default () => <board />" } }],
    ] as const
    let calls = 0
    const outputs: string[] = []
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(JSON.stringify(body).includes("Saved design context"), false) // no up-front paste
      for (const item of body.input) if (item.type === "function_call_output") outputs.push(item.output)
      const next = script[calls++]
      return Response.json(next ? toolCallReply("openai", next[0], next[1]) : textReply("openai", "Added R2 and built it."))
    }) as typeof fetch
    const result = await ask()
    assert.equal(result.statusCode, 200, result.body)
    const r = result.json()
    assert.equal(r.message, "Added R2 and built it.")
    assert.deepEqual(r.trail.map((t: any) => [t.tool, t.ok]), [["search_parts", true], ["add_part", true], ["add_part", false], ["rollback_run", false], ["build_design", true], ["propose_change", false], ["propose_change", true]])
    assert.deepEqual(hits, ["search 10k 0603", "add resistor", "build"])
    assert.equal(r.searches[0].parts[0].lcsc, "C123")
    assert.equal(r.proposalId, "review-me")
    assert.equal(proposal.summary, "Rework")
    assert.equal(run.edits.length, 1) // only the successful edit is on the run
    assert.equal(outputs.some((o) => o.includes("SOURCE-NOT-FOR-THE-MODEL")), false) // results stay small
    assert.equal(result.body.includes("test-secret"), false)

    // a model that never stops calling tools is cut off, and builds are budgeted
    calls = 0
    globalThis.fetch = (async () => { calls++; return Response.json(toolCallReply("openai", "build_design", { name: "base-s3" })) }) as typeof fetch
    hits.length = 0
    const looped = (await ask()).json()
    assert.equal(looped.stopped, true)
    assert.equal(calls, LIMITS.steps)
    assert.equal(hits.length, LIMITS.builds)

    await app.inject({ method: "DELETE", url: "/api/ai/providers/openai" })
    assert.equal((await ask()).statusCode, 400)
  } finally { globalThis.fetch = original; await app.close() }
})
