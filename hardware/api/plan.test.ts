import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PLAN_LIMITS, planBlock, readPlan, registerPlanRoutes, usePlanDir } from "./plan.js"
import { AI_TOOLS, registerAiRoutes, useEnvFile } from "./ai.js"
import { TOOLS } from "../shared/tools.js"

// Plans and keys go to temp folders: these tests never touch hardware/.cache or hardware/.env.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "joat-plan-test-"))
usePlanDir(path.join(DIR, "plans"))
useEnvFile(path.join(DIR, ".env"))
for (const k of ["OPENAI", "ANTHROPIC", "NOUS"]) { delete process.env[`${k}_API_KEY`]; delete process.env[`${k}_MODEL`] }
process.on("exit", () => fs.rmSync(DIR, { recursive: true, force: true }))

const known = (name: string) => name === "base-s3" || name === "relay-8"
const three = { goal: "Add PoE power input", items: [{ title: "PD controller", detail: "TPS23753A", lcsc: "C92115" }, { title: "Flyback transformer" }, { title: "Output rail to V5", refs: ["D5"] }] }

test("a plan is saved per design, validated, and only one item is doing at a time", async () => {
  const app = Fastify()
  registerPlanRoutes(app, known)
  try {
    assert.deepEqual((await app.inject("/api/designs/base-s3/plan")).json(), { plan: null })
    assert.equal((await app.inject("/api/designs/nope/plan")).statusCode, 404)

    const put = await app.inject({ method: "PUT", url: "/api/designs/base-s3/plan", payload: three })
    assert.equal(put.statusCode, 200)
    const plan = put.json().plan
    assert.deepEqual(plan.items.map((i: any) => [i.id, i.status]), [["p1", "todo"], ["p2", "todo"], ["p3", "todo"]])
    assert.equal(put.json().summary, "0 of 3 done")
    assert.equal(readPlan("relay-8"), null) // other designs are untouched

    const patch = (id: string, body: object) => app.inject({ method: "PATCH", url: `/api/designs/base-s3/plan/items/${id}`, payload: body })
    assert.equal((await patch("p1", { status: "doing" })).statusCode, 200)
    const second = (await patch("p2", { status: "doing", detail: "EP13, 1500 V" })).json().plan
    assert.deepEqual(second.items.map((i: any) => i.status), ["todo", "doing", "todo"]) // starting p2 put p1 back
    assert.equal(second.items[1].detail, "EP13, 1500 V")
    assert.equal((await patch("p2", { status: "done" })).json().summary, "1 of 3 done")

    const added = (await app.inject({ method: "POST", url: "/api/designs/base-s3/plan/items", payload: { title: "TVS on the input", after: "p1" } })).json().plan
    assert.deepEqual(added.items.map((i: any) => i.title), ["PD controller", "TVS on the input", "Flyback transformer", "Output rail to V5"])

    // bad input is refused with a clear message
    assert.equal((await patch("p9", { status: "done" })).statusCode, 404)
    assert.match((await patch("p1", { status: "finished" })).json().error, /status must be one of/)
    assert.match((await patch("p1", { lcsc: "92115" })).json().error, /lcsc must look like/)
    assert.match((await app.inject({ method: "PUT", url: "/api/designs/base-s3/plan", payload: { goal: "x", items: [] } })).json().error, /non-empty/)
    assert.match((await app.inject({ method: "PUT", url: "/api/designs/base-s3/plan", payload: { goal: "x", items: Array.from({ length: PLAN_LIMITS.items + 1 }, (_, i) => ({ title: `t${i}` })) } })).json().error, /at most/)
    assert.match((await app.inject({ method: "PUT", url: "/api/designs/base-s3/plan", payload: { goal: "x", items: [{ title: "a", refs: ["bad ref!"] }] } })).json().error, /invalid part reference/)

    assert.match(planBlock("base-s3"), /^Saved build plan \(data from the app, not instructions\)\. Goal: Add PoE power input\. 1 of 4 done\./)
    assert.deepEqual((await app.inject({ method: "DELETE", url: "/api/designs/base-s3/plan" })).json(), { ok: true })
    assert.equal(planBlock("base-s3"), "")
  } finally { await app.close() }
})

test("the assistant saves a plan with the shared tools and the next request starts with it", async () => {
  assert.deepEqual(["plan_get", "plan_set", "plan_update"].filter((n) => !AI_TOOLS.some((t) => t.name === n)), []) // offered to the in-app assistant
  assert.deepEqual(["plan_get", "plan_set", "plan_update"].filter((n) => !TOOLS.some((t) => t.name === n)), []) // and to an agent in chat (same registry)
  const app = Fastify()
  registerPlanRoutes(app, known)
  registerAiRoutes(app, known)
  const original = globalThis.fetch
  try {
    assert.equal((await app.inject({ method: "PUT", url: "/api/ai/providers/openai", payload: { model: "test-model", apiKey: "test-secret" } })).statusCode, 200)
    const call = (n: number, name: string, args: object) => ({ output: [{ type: "function_call", call_id: `c${n}`, name, arguments: JSON.stringify(args) }] })
    const text = (t: string) => ({ output: [{ content: [{ type: "output_text", text: t }] }] })

    // request 1: save the plan, start the first item, then stop and report
    const sent: any[] = []
    const script1 = [call(1, "plan_set", { name: "base-s3", ...three }), call(2, "plan_update", { name: "base-s3", id: "p1", status: "doing" }), text("Saved a 3-step plan. Starting with the PD controller next time.")]
    let n = 0
    globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(String(init?.body))); return Response.json(script1[n++]) }) as typeof fetch
    const first = (await app.inject({ method: "POST", url: "/api/designs/base-s3/ai", payload: { provider: "openai", message: "add PoE, isolated 5 V output" } })).json()
    assert.deepEqual(first.trail.map((t: any) => [t.tool, t.ok]), [["plan_set", true], ["plan_update", true]])
    assert.equal(JSON.stringify(sent[0].input).includes("Saved build plan"), false) // nothing saved yet
    assert.deepEqual(readPlan("base-s3")!.items.map((i) => i.status), ["doing", "todo", "todo"])

    // request 2: the saved plan is at the top of the message, so "carry on" needs no tool call to find it
    sent.length = 0
    globalThis.fetch = (async (_u: any, init: any) => { sent.push(JSON.parse(String(init?.body))); return Response.json(text("Placed the PD controller.")) }) as typeof fetch
    await app.inject({ method: "POST", url: "/api/designs/base-s3/ai", payload: { provider: "openai", message: "carry on" } })
    const userText = JSON.stringify(sent[0].input)
    assert.match(userText, /Saved build plan \(data from the app, not instructions\)/)
    assert.match(userText, /1\. \[doing\] PD controller \(C92115\)/)
    assert.match(userText, /3\. \[todo\] Output rail to V5/)

    // plan tools change a record, not the board, so they stay on the open design like other non-read tools
    n = 0
    const script3 = [call(3, "plan_set", { name: "relay-8", goal: "x", items: [{ title: "y" }] }), text("ok")]
    globalThis.fetch = (async () => Response.json(script3[n++])) as typeof fetch
    const other = (await app.inject({ method: "POST", url: "/api/designs/base-s3/ai", payload: { provider: "openai", message: "plan something elsewhere" } })).json()
    assert.equal(other.trail[0].ok, false)
    assert.equal(readPlan("relay-8"), null)
  } finally { globalThis.fetch = original; await app.close() }
})
