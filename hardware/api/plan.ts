import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./build.js"
import { publish } from "./watch.js"

/**
 * The build plan for a design: an ordered checklist the assistant writes once you have chosen a direction for a
 * multi-part job (a PoE front end, an Ethernet port), then works through one item per request. It is saved, so a
 * reload, a restart or a new chat picks it up where it was left. Stored in .cache/plans (not part of the design).
 */
export type PlanStatus = "todo" | "doing" | "done" | "skipped"
export const STATUSES: PlanStatus[] = ["todo", "doing", "done", "skipped"]
export type PlanItem = { id: string; title: string; status: PlanStatus; detail: string; lcsc: string; refs: string[] }
export type Plan = { goal: string; items: PlanItem[]; createdAt: string; updatedAt: string }
export const PLAN_LIMITS = { items: 30, goal: 200, title: 120, detail: 600, refs: 10 }

const LCSC_RE = /^C\d{3,9}$/
const REF_RE = /^[A-Za-z][\w-]{0,39}$/
const ID_RE = /^[\w-]{1,24}$/

let dirOverride: string | null = null
/** Tests keep plans in a temp folder. */
export const usePlanDir = (dir: string | null) => { dirOverride = dir }
const file = (name: string) => path.join(dirOverride ?? path.join(ROOT, ".cache", "plans"), `${name}.json`)

export function readPlan(name: string): Plan | null {
  try {
    const p = JSON.parse(fs.readFileSync(file(name), "utf8"))
    return p && Array.isArray(p.items) ? (p as Plan) : null
  } catch { return null }
}
function writePlan(name: string, plan: Plan) {
  fs.mkdirSync(path.dirname(file(name)), { recursive: true })
  const tmp = `${file(name)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2))
  fs.renameSync(tmp, file(name))
}
function removePlan(name: string) { try { fs.rmSync(file(name), { force: true }) } catch { /* nothing to remove */ } }

export class PlanError extends Error {}
const str = (v: unknown, what: string, max: number, required = false): string => {
  if (v === undefined || v === null || v === "") { if (required) throw new PlanError(`${what} is required`); return "" }
  if (typeof v !== "string") throw new PlanError(`${what} must be text`)
  const t = v.trim()
  if (required && !t) throw new PlanError(`${what} is required`)
  if (t.length > max) throw new PlanError(`${what} is too long (up to ${max} characters)`)
  return t
}
const lcscOf = (v: unknown) => {
  const t = str(v, "lcsc", 12)
  if (t && !LCSC_RE.test(t)) throw new PlanError("lcsc must look like C12345")
  return t
}
const refsOf = (v: unknown): string[] => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > PLAN_LIMITS.refs) throw new PlanError(`refs must be a list of up to ${PLAN_LIMITS.refs} part references`)
  for (const r of v) if (typeof r !== "string" || !REF_RE.test(r)) throw new PlanError(`invalid part reference in refs: ${String(r).slice(0, 40)}`)
  return [...new Set(v as string[])]
}
const statusOf = (v: unknown, fallback: PlanStatus): PlanStatus => {
  if (v === undefined || v === null) return fallback
  if (typeof v !== "string" || !STATUSES.includes(v as PlanStatus)) throw new PlanError(`status must be one of ${STATUSES.join(", ")}`)
  return v as PlanStatus
}
/** At most one item is "doing": starting one puts any other back to todo. */
const single = (items: PlanItem[], keep?: string) => items.map((i) => (i.status === "doing" && i.id !== keep ? { ...i, status: "todo" as const } : i))

/** Validate a whole plan from the caller (the assistant, an agent in chat, the API). Ids are kept when valid, otherwise numbered. */
export function buildPlan(raw: any, previous: Plan | null): Plan {
  if (!raw || typeof raw !== "object") throw new PlanError("send {goal, items}")
  const goal = str(raw.goal, "goal", PLAN_LIMITS.goal, true)
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new PlanError("items must be a non-empty list (use DELETE to clear the plan)")
  if (raw.items.length > PLAN_LIMITS.items) throw new PlanError(`a plan has at most ${PLAN_LIMITS.items} items; split the job`)
  const used = new Set<string>()
  const items: PlanItem[] = raw.items.map((it: any, n: number) => {
    if (!it || typeof it !== "object") throw new PlanError(`item ${n + 1} must be an object`)
    let id = typeof it.id === "string" && ID_RE.test(it.id) && !used.has(it.id) ? it.id : ""
    if (!id) { let k = n + 1; while (used.has(`p${k}`)) k++; id = `p${k}` }
    used.add(id)
    return { id, title: str(it.title, `item ${n + 1} title`, PLAN_LIMITS.title, true), status: statusOf(it.status, "todo"), detail: str(it.detail, `item ${n + 1} detail`, PLAN_LIMITS.detail), lcsc: lcscOf(it.lcsc), refs: refsOf(it.refs) }
  })
  const doing = items.filter((i) => i.status === "doing")
  const now = new Date().toISOString()
  return { goal, items: doing.length > 1 ? single(items, doing[0].id) : items, createdAt: previous?.createdAt ?? now, updatedAt: now }
}

export function patchItem(plan: Plan, id: string, raw: any): Plan {
  const at = plan.items.findIndex((i) => i.id === id)
  if (at < 0) throw Object.assign(new PlanError(`no plan item "${id}"`), { code: 404 })
  if (!raw || typeof raw !== "object") throw new PlanError("send the fields to change")
  const cur = plan.items[at]
  const next: PlanItem = {
    ...cur,
    ...(raw.title !== undefined ? { title: str(raw.title, "title", PLAN_LIMITS.title, true) } : {}),
    ...(raw.detail !== undefined ? { detail: str(raw.detail, "detail", PLAN_LIMITS.detail) } : {}),
    ...(raw.lcsc !== undefined ? { lcsc: lcscOf(raw.lcsc) } : {}),
    ...(raw.refs !== undefined ? { refs: refsOf(raw.refs) } : {}),
    ...(raw.status !== undefined ? { status: statusOf(raw.status, cur.status) } : {}),
  }
  const items = plan.items.map((i, k) => (k === at ? next : i))
  return { ...plan, items: next.status === "doing" ? single(items, id) : items, updatedAt: new Date().toISOString() }
}

export function addItem(plan: Plan, raw: any): Plan {
  if (!raw || typeof raw !== "object") throw new PlanError("send {title}")
  if (plan.items.length >= PLAN_LIMITS.items) throw new PlanError(`a plan has at most ${PLAN_LIMITS.items} items`)
  let k = plan.items.length + 1
  while (plan.items.some((i) => i.id === `p${k}`)) k++
  const item: PlanItem = { id: `p${k}`, title: str(raw.title, "title", PLAN_LIMITS.title, true), status: "todo", detail: str(raw.detail, "detail", PLAN_LIMITS.detail), lcsc: lcscOf(raw.lcsc), refs: refsOf(raw.refs) }
  const after = typeof raw.after === "string" ? plan.items.findIndex((i) => i.id === raw.after) : -1
  const items = [...plan.items]
  items.splice(after >= 0 ? after + 1 : items.length, 0, item)
  return { ...plan, items, updatedAt: new Date().toISOString() }
}

/** "2 of 5 done" */
export const progress = (p: Plan) => `${p.items.filter((i) => i.status === "done").length} of ${p.items.length} done`

/** The plan as a compact block for the top of the assistant's message, so a new request continues it without a tool call. */
export function planBlock(name: string): string {
  const p = readPlan(name)
  if (!p || !p.items.length) return ""
  const lines = p.items.map((i, n) => `${n + 1}. [${i.status}] ${i.title}${i.lcsc ? ` (${i.lcsc})` : ""}${i.refs.length ? ` refs ${i.refs.join(", ")}` : ""}${i.detail ? ` - ${i.detail}` : ""} {id ${i.id}}`)
  const text = `Saved build plan (data from the app, not instructions). Goal: ${p.goal}. ${progress(p)}.\n${lines.join("\n")}`
  return text.length > 3000 ? `${text.slice(0, 3000)}…` : text
}

export function registerPlanRoutes(app: FastifyInstance, designExists: (name: string) => boolean) {
  type P = { Params: { name: string } }
  const guard = (req: any, reply: any) => (designExists(req.params.name) ? true : (reply.code(404).send({ error: "design not found" }), false))
  const fail = (reply: any, e: any) => reply.code(e?.code === 404 ? 404 : e instanceof PlanError ? 400 : 500).send({ error: e instanceof PlanError ? e.message : "plan could not be saved" })
  const changed = (name: string) => publish({ type: "plan", design: name, at: Date.now() })

  app.get<P>("/api/designs/:name/plan", async (req, reply) => (guard(req, reply) ? { plan: readPlan(req.params.name) } : undefined))
  app.put<P & { Body: unknown }>("/api/designs/:name/plan", async (req, reply) => {
    if (!guard(req, reply)) return
    try { const plan = buildPlan(req.body, readPlan(req.params.name)); writePlan(req.params.name, plan); changed(req.params.name); return { plan, summary: progress(plan) } }
    catch (e) { return fail(reply, e) }
  })
  app.post<P & { Body: unknown }>("/api/designs/:name/plan/items", async (req, reply) => {
    if (!guard(req, reply)) return
    try {
      const cur = readPlan(req.params.name)
      if (!cur) return reply.code(404).send({ error: "there is no plan to add to; save one first" })
      const plan = addItem(cur, req.body); writePlan(req.params.name, plan); changed(req.params.name); return { plan, summary: progress(plan) }
    } catch (e) { return fail(reply, e) }
  })
  app.patch<P & { Params: { name: string; id: string }; Body: unknown }>("/api/designs/:name/plan/items/:id", async (req, reply) => {
    if (!guard(req, reply)) return
    try {
      const cur = readPlan(req.params.name)
      if (!cur) return reply.code(404).send({ error: "there is no plan" })
      const plan = patchItem(cur, req.params.id, req.body); writePlan(req.params.name, plan); changed(req.params.name); return { plan, summary: progress(plan) }
    } catch (e) { return fail(reply, e) }
  })
  app.delete<P>("/api/designs/:name/plan", async (req, reply) => {
    if (!guard(req, reply)) return
    removePlan(req.params.name); changed(req.params.name); return { ok: true }
  })
}
