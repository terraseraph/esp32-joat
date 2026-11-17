// The one tool registry for hardware-design agents.
// The MCP server (hardware/mcp/server.ts) and the in-app AI (hardware/api/ai.ts) both list and run
// tools from here, so an agent in chat and the assistant in the app call exactly the same functions.
// Every tool goes through the designer's HTTP API via `ctx.call`: the MCP server passes a fetch-based
// transport, the API passes `app.inject`. Nothing here imports Node or API modules.
//
// Results are kept small on purpose (no full source text, no circuit JSON): an agent that needs the
// source calls read_design; everything else returns the few fields needed to decide the next step.

export type ToolResponse = { status: number; type: string; body: Uint8Array }
export type ToolCtx = { call: (method: string, path: string, body?: unknown) => Promise<ToolResponse> }

export type Tool = {
  name: string
  description: string
  /** read: no change. edit: changes design files (recorded on the working-draft run). run: decides a run. */
  kind: "read" | "edit" | "run"
  properties: Record<string, any>
  required?: string[]
  /** returns a PNG; hosts that cannot pass images to the model leave these tools out */
  image?: boolean
  run: (a: any, ctx: ToolCtx) => Promise<any>
}

const enc = encodeURIComponent
const text = (b: Uint8Array) => new TextDecoder().decode(b)

export class ToolError extends Error {}

async function json(ctx: ToolCtx, method: string, path: string, body?: unknown) {
  const r = await ctx.call(method, path, body)
  const t = text(r.body)
  let data: any = t
  try { data = JSON.parse(t) } catch {}
  if (r.status >= 400) throw new ToolError(`${r.status}: ${data?.error ?? data?.message ?? t}`)
  return data
}

const d = (a: any) => `/api/designs/${enc(a.name)}`

/** Run one edit on the working draft: a run (with its automatic "before" snapshot) is opened first if
 *  none is open, and the edit is recorded on it once it has succeeded. */
async function edit<T extends object>(ctx: ToolCtx, a: any, tool: string, fn: () => Promise<T & { summary: string }>) {
  const run = await json(ctx, "POST", `${d(a)}/run/begin`, { label: tool })
  const { summary, ...out } = await fn()
  await json(ctx, "POST", `${d(a)}/run/log`, { tool, summary })
  return { ...out, summary, run: { id: run.id, snapshotId: run.snapshotId, edits: run.edits.length + 1 } }
}

const name = { type: "string", description: "Design folder name, e.g. relay-8 (see list_designs)" }
const mode = { type: "string", enum: ["quick", "full"], description: "quick (default): place parts, seconds. full: autoroute, can take minutes." }
const pin = (what: string) => ({ type: "object", description: `${what}: {ref, pin}, e.g. {"ref":"R1","pin":"pin1"}`, properties: { ref: { type: "string" }, pin: { type: "string" } }, required: ["ref", "pin"] })
const qty = { type: "number", description: "boards, default 10" }
const modeOf = (a: any) => (a.mode === "full" ? "full" : "quick")
const ASSEMBLY = { type: "string", enum: ["none", "top", "both"], description: "sides JLCPCB assembles (default top); none orders bare boards" }
const ORDER_ID = { type: "string", description: "order id from list_orders" }
/** Stock lines worth an agent's attention: short and tight lines in full, and how many parts had no stock figure. */
const stockProblems = (p: any) => {
  const lines: any[] = p?.stock ?? []
  return { lines: lines.filter((s) => s.state === "short" || s.state === "tight"), unknown: lines.filter((s) => s.state === "unknown").length, checked: lines.length }
}
/** An order without the bulky parts: per-file hashes, every stock line and the cost basis. */
const orderOut = (o: any) => ({
  id: o.id, design: o.design, revision: o.revision, status: o.status, qty: o.qty, options: o.options, board: o.board, git: o.git,
  stale: o.stale, packageOnDisk: o.packageOnDisk,
  package: o.package && { file: o.package.file, bytes: o.package.bytes, builtAt: o.package.builtAt, files: (o.package.files ?? []).map((f: any) => f.name), cpl: o.package.cpl },
  preflight: o.preflight && { ok: o.preflight.ok, checkedAt: o.preflight.checkedAt, gates: o.preflight.gates, stockProblems: stockProblems(o.preflight) },
  quote: o.quote, vendor: o.vendor, tracking: o.tracking, note: o.note, history: o.history,
})

export const TOOLS: Tool[] = [
  // ---- read ----
  { name: "list_designs", kind: "read", description: "List board designs with their board.json metadata.", properties: {}, run: (_a, c) => json(c, "GET", "/api/designs") },
  { name: "read_design", kind: "read", description: "Read a design: metadata and all source files (index.tsx, board.json, ...). The largest read; prefer list_components / list_nets when they answer the question.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", d(a)) },
  { name: "list_components", kind: "read", description: "Components of the last build: ref, type, value, MPN, footprint, LCSC, position, rotation, pin->net map and the source file/line (or lib block) that places each part.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/components`) },
  { name: "list_source_components", kind: "read", description: "Elements with a literal name=\"...\" in the design source, with their literal props. These are the parts patch_component can edit.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/components/source`) },
  { name: "list_nets", kind: "read", description: "Nets of the last build with kind (ground/power/signal) and the ports on each.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/nets`) },
  { name: "gpio_map", kind: "read", description: "ESP32-S3 module pin map: each IO pin's net and notes (strapping, PSRAM, USB, ADC2) plus clashes.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/gpio`) },
  { name: "explain_design", kind: "read", description: "Deterministic plain-English walkthrough of the board grouped by function, with the parts each sentence mentions.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/explain`) },
  { name: "build_design", kind: "read", description: "Build the saved design. Returns ok, errors, warnings, duration and a design-rule check count summary, not the circuit JSON. Optional unsaved file overrides.", properties: { name, mode, files: { type: "object", description: "Optional {path: content} overrides, not saved" } }, required: ["name"],
    run: async (a, c) => {
      const r = await json(c, "POST", `${d(a)}/build`, { files: a.files, mode: modeOf(a) })
      return { ok: r.ok, mode: r.mode, durationMs: r.durationMs, errors: r.errors, warnings: r.warnings, checks: r.checks?.counts, elements: r.circuitJson?.length ?? 0 }
    } },
  { name: "run_checks", kind: "read", description: "Design-rule checks with plain-English title, why and fix for each issue (clearances, overlaps, antenna keep-out, decoupling; trace width/current only in full mode).", properties: { name, mode }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/checks?mode=${modeOf(a)}`) },
  { name: "get_bom", kind: "read", description: "Priced BOM (jlcsearch) for a design at a build quantity.", properties: { name, qty }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/bom?qty=${a.qty ?? 10}`) },
  { name: "cost_summary", kind: "read", description: "Estimated per-board cost at a quantity: parts, JLC extended-part fees, fab and assembly estimate, unpriced part count.", properties: { name, qty }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/cost?qty=${a.qty ?? 10}`) },
  { name: "list_swaps", kind: "read", description: "Basic/Preferred JLC replacements for Extended parts in the design, with the saving of each. Apply one with apply_swap.", properties: { name, qty }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/swaps?qty=${a.qty ?? 10}`) },
  { name: "get_snapshot", kind: "read", image: true, description: "PNG image of the PCB or schematic from the last build.", properties: { name, view: { type: "string", enum: ["pcb", "schematic"] }, width: { type: "number" } }, required: ["name"],
    run: async (a, c) => {
      const r = await c.call("GET", `${d(a)}/snapshot.png?view=${a.view === "schematic" ? "schematic" : "pcb"}&width=${Number(a.width) || 1200}`)
      if (r.status >= 400) throw new ToolError(`${r.status}: ${text(r.body)}`)
      return { __image: r.body }
    } },
  { name: "list_palette", kind: "read", description: "Parts that add_part can place: primitives (resistor, capacitor, chip, ...) and the shared lib blocks. Each has an id and its props (name, type, required, default). Pass query to filter by id/label.", properties: { query: { type: "string" } },
    run: async (a, c) => {
      const p = await json(c, "GET", "/api/palette")
      const q = String(a.query ?? "").toLowerCase()
      const slim = (i: any) => ({ id: i.id, label: i.label, description: i.description, props: (i.props ?? []).map((s: any) => ({ name: s.name, type: s.type, ...(s.required ? { required: true } : {}), ...(s.default !== undefined ? { default: s.default } : {}), ...(s.options ? { options: s.options } : {}) })) })
      const keep = (i: any) => !q || `${i.id} ${i.label} ${i.tag}`.toLowerCase().includes(q)
      return { primitives: p.primitives.filter(keep).map(slim), lib: p.lib.filter(keep).map(slim) }
    } },
  { name: "search_parts", kind: "read", description: "Search the JLCPCB catalogue (jlcsearch): LCSC number, manufacturer part, package, stock, price, tier (basic/preferred/extended) and a footprint guess. Matches are candidates, not proof of suitability.", properties: { query: { type: "string", description: "e.g. \"10k 0603\" or \"AO3400A\"" }, limit: { type: "number", description: "default 8, max 50" } }, required: ["query"],
    run: (a, c) => json(c, "GET", `/api/parts/search?q=${enc(a.query)}&limit=${Math.min(50, Math.max(1, Number(a.limit) || 8))}`) },
  { name: "list_requests", kind: "read", description: "Change requests the user typed in the designer (open ones are what to work on).", properties: { name, status: { type: "string", enum: ["open", "resolved", "dismissed"] } }, required: ["name"],
    run: async (a, c) => { const r = await json(c, "GET", `${d(a)}/requests`); return a.status ? r.filter((x: any) => x.status === a.status) : r } },
  { name: "list_proposals", kind: "read", description: "Proposals with diffs and status (pending/accepted/rejected).", properties: { name, status: { type: "string", enum: ["pending", "accepted", "rejected"] } }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/proposals${a.status ? `?status=${enc(a.status)}` : ""}`) },
  { name: "list_snapshots", kind: "read", description: "Saved snapshots of a design's files, newest first (auto ones are taken before each run and before each restore).", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/snapshots`) },
  { name: "run_status", kind: "read", description: "The open working-draft run of a design, if any: its \"before\" snapshot and the edits made so far.", properties: { name }, required: ["name"], run: (a, c) => json(c, "GET", `${d(a)}/run`) },

  // ---- structured edits: small, source-level, written to the working draft ----
  { name: "add_part", kind: "edit", description: "Add one palette item (primitive or lib block) to index.tsx. item is a list_palette id. props are that item's props; name is generated when omitted, lcsc sets the JLC part and footprint. Returns the new part's name and the JSX that was inserted.", properties: { name, item: { type: "string", description: "palette id or tag, e.g. \"resistor\" or \"lib:MosfetOutput\"" }, props: { type: "object", description: "e.g. {\"resistance\":\"10k\",\"footprint\":\"0603\",\"pcbX\":5,\"pcbY\":-3,\"lcsc\":\"C25804\"}" } }, required: ["name", "item"],
    run: (a, c) => edit(c, a, "add_part", async () => {
      const r = await json(c, "POST", `${d(a)}/components`, { item: a.item, props: a.props ?? {} })
      return { part: r.name, snippet: r.snippet, summary: `added ${r.name ?? a.item}` }
    }) },
  { name: "patch_component", kind: "edit", description: "Change props of one named element: props sets literal values (null removes a prop), delta moves numeric props relative to their current value. Use it to move (pcbX, pcbY), rotate (pcbRotation), revalue or rename a part.", properties: { name, component: { type: "string", description: "the element's name, e.g. R1" }, props: { type: "object", description: "e.g. {\"pcbX\":12.5,\"resistance\":\"4.7k\"}" }, delta: { type: "object", description: "e.g. {\"pcbX\":-2,\"pcbRotation\":90}" }, file: { type: "string", description: "only when the name appears in several design files" } }, required: ["name", "component"],
    run: (a, c) => edit(c, a, "patch_component", async () => {
      const r = await json(c, "PATCH", `${d(a)}/components/${enc(a.component)}`, { props: a.props ?? {}, delta: a.delta, file: a.file })
      return { file: r.file, warnings: r.warnings, summary: `patched ${a.component}: ${Object.keys({ ...a.props, ...a.delta }).join(", ")}` }
    }) },
  { name: "connect_pins", kind: "edit", description: "Put pin a (and pin b) on one net. net names the net; when omitted a name is suggested from the pins.", properties: { name, a: pin("first pin"), b: pin("optional second pin"), net: { type: "string", description: "e.g. GND, V3V3, SDA" } }, required: ["name", "a"],
    run: (a, c) => edit(c, a, "connect_pins", async () => {
      const r = await json(c, "POST", `${d(a)}/connect`, { a: a.a, b: a.b, net: a.net })
      return { changed: r.changed, net: r.net, how: r.how, summary: `${a.a.ref}.${a.a.pin}${a.b ? ` + ${a.b.ref}.${a.b.pin}` : ""} -> ${r.net}` }
    }) },
  { name: "set_pin_net", kind: "edit", description: "Set the net of one pin, or disconnect it with net null.", properties: { name, ref: { type: "string" }, pin: { type: "string" }, net: { type: ["string", "null"], description: "net name, or null to disconnect" } }, required: ["name", "ref", "pin", "net"],
    run: (a, c) => edit(c, a, "set_pin_net", async () => {
      const r = await json(c, "POST", `${d(a)}/pin-net`, { ref: a.ref, pin: a.pin, net: a.net })
      return { changed: r.changed, how: r.how, summary: `${a.ref}.${a.pin} -> ${a.net ?? "(disconnected)"}` }
    }) },
  { name: "rename_net", kind: "edit", description: "Rename a net in every design file. Refused when the net is also used inside a lib block, or when the new name exists (pass merge true to join the two nets).", properties: { name, from: { type: "string" }, to: { type: "string" }, merge: { type: "boolean" } }, required: ["name", "from", "to"],
    run: (a, c) => edit(c, a, "rename_net", async () => {
      const r = await json(c, "POST", `${d(a)}/rename-net`, { from: a.from, to: a.to, merge: a.merge })
      return { count: r.count, how: r.how, summary: `net ${a.from} -> ${a.to}` }
    }) },
  { name: "assign_gpio", kind: "edit", description: "Assign a net to an ESP32-S3 module IO pin (or clear it with net null). Returns the clashes and notes for that pin.", properties: { name, pin: { type: "string", description: "module pin label, e.g. IO4" }, net: { type: ["string", "null"] } }, required: ["name", "pin", "net"],
    run: (a, c) => edit(c, a, "assign_gpio", async () => {
      const r = await json(c, "POST", `${d(a)}/gpio/assign`, { pin: a.pin, net: a.net })
      return { changed: r.changed, how: r.how, clashes: r.map?.clashes, summary: `${a.pin} -> ${a.net ?? "(cleared)"}` }
    }) },
  { name: "apply_swap", kind: "edit", description: "Replace one LCSC part number with another in the design's own files (see list_swaps). Lib files are reported, not changed.", properties: { name, from: { type: "string", description: "LCSC number in the design, e.g. C123456" }, to: { type: "string" } }, required: ["name", "from", "to"],
    run: (a, c) => edit(c, a, "apply_swap", async () => {
      const r = await json(c, "POST", `${d(a)}/swaps/apply`, { from: a.from, to: a.to })
      return { changed: Object.keys(r.changed ?? {}), libFiles: r.libFiles, summary: `swapped ${a.from} -> ${a.to}` }
    }) },

  // ---- snapshots, runs and whole-file proposals ----
  { name: "create_snapshot", kind: "run", description: "Save a labelled snapshot of the design's files as they are on disk.", properties: { name, label: { type: "string" } }, required: ["name"], run: (a, c) => json(c, "POST", `${d(a)}/snapshots`, { label: a.label }) },
  { name: "restore_snapshot", kind: "run", description: "Write a snapshot's files back to disk. The current files are snapshotted first, so a restore can itself be undone.", properties: { name, id: { type: "string", description: "snapshot id from list_snapshots" } }, required: ["name", "id"],
    run: async (a, c) => { const r = await json(c, "POST", `${d(a)}/snapshots/${enc(a.id)}/restore`); return { ok: r.ok, backup: r.backup, files: Object.keys(r.files ?? {}) } } },
  { name: "accept_run", kind: "run", description: "Keep the open run's edits and close the run. Only when the user has said to keep them.", properties: { name }, required: ["name"], run: (a, c) => json(c, "POST", `${d(a)}/run/accept`) },
  { name: "rollback_run", kind: "run", description: "Undo every edit of the open run by restoring its \"before\" snapshot, then close the run.", properties: { name }, required: ["name"],
    run: async (a, c) => { const r = await json(c, "POST", `${d(a)}/run/rollback`); return { ok: r.ok, undone: r.undone, restored: r.restored, backup: r.backup } } },
  { name: "propose_change", kind: "run", description: "For changes the structured edit tools cannot express: submit full replacement files for the user to review. NOTHING is written until the user clicks Accept in the designer. files maps design-relative paths (or lib/<block>.tsx) to full new content, or null to delete. Link requestId when answering a request.", properties: { name, summary: { type: "string", description: "One-line description shown above the diff" }, files: { type: "object" }, requestId: { type: "string" } }, required: ["name", "summary", "files"],
    run: async (a, c) => { const r = await json(c, "POST", `${d(a)}/proposals`, { summary: a.summary, files: a.files, requestId: a.requestId }); return { id: r.id, status: r.status, summary: r.summary, files: (r.diffs ?? []).map((x: any) => ({ file: x.file, status: x.status, added: x.added, removed: x.removed })) } } },

  // ---- orders: local records only. No tool here contacts a manufacturer, places an order or pays. ----
  { name: "order_preflight", kind: "read", description: "Order gate and estimate for a design without saving anything: runs a full build (can take minutes), then returns ok, each gate (build, checks, lcsc, catalogue, stock, rotation, review) with pass/warn/block, the labelled local estimate and the number of placement rows.", properties: { name, qty, assembly: ASSEMBLY }, required: ["name"],
    run: async (a, c) => { const r = await json(c, "GET", `${d(a)}/order-preflight?qty=${a.qty ?? 10}${a.assembly ? `&assembly=${enc(a.assembly)}` : ""}`); return { ok: r.preflight.ok, gates: r.preflight.gates, stockProblems: stockProblems(r.preflight), quote: r.quote, cplRows: Array.isArray(r.cpl) ? r.cpl.length : r.cpl?.total, files: (r.files ?? []).map((f: any) => f.name) } } },
  { name: "list_orders", kind: "read", description: "Saved orders, newest first: id, design, revision, status, qty, total (estimate or the vendor's quoted total), vendor order number and tracking number. One design, or every design when name is omitted.", properties: { name: { ...name, description: "Design folder name; omit for every design" } },
    run: (a, c) => json(c, "GET", a.name ? `${d(a)}/orders` : "/api/orders") },
  { name: "get_order", kind: "read", description: "One saved order: status, options, gates, quote, vendor and tracking fields, history, whether the design changed since its package was built (stale) and the package file names.", properties: { name, id: ORDER_ID }, required: ["name", "id"],
    run: async (a, c) => orderOut(await json(c, "GET", `${d(a)}/orders/${enc(a.id)}`)) },
  { name: "create_draft_order", kind: "run", description: "Save a draft order for a design: runs a full build (can take minutes), writes the fab package (Gerber zip, bom.csv, cpl.csv, order-options.txt), the pre-flight result and the labelled estimate. Stored locally only; nothing is sent to a manufacturer. The user uploads the package and pays on the vendor's site.", properties: { name, qty, assembly: ASSEMBLY, handFit: { type: "array", description: "refs fitted by hand, left out of the BOM and CPL, e.g. [\"J1\",\"J2\"]", items: { type: "string" } }, shippingMethod: { type: "string" }, shippingAmount: { type: "number", description: "USD, from the vendor" }, taxPct: { type: "number" }, note: { type: "string" } }, required: ["name", "qty"],
    run: async (a, c) => orderOut(await json(c, "POST", `${d(a)}/orders`, { qty: a.qty, options: { assembly: a.assembly, handFit: a.handFit }, shipping: a.shippingMethod !== undefined || a.shippingAmount !== undefined ? { method: a.shippingMethod, amount: a.shippingAmount } : undefined, tax: a.taxPct !== undefined ? { ratePct: a.taxPct } : undefined, note: a.note })) },
  { name: "refresh_order", kind: "run", description: "Rebuild a draft order's package, pre-flight and estimate from the design as it is now (full build). Use when get_order reports stale.", properties: { name, id: ORDER_ID, qty }, required: ["name", "id"],
    run: async (a, c) => orderOut(await json(c, "POST", `${d(a)}/orders/${enc(a.id)}/refresh`, a.qty === undefined ? {} : { qty: a.qty })) },
  { name: "update_order", kind: "run", description: "Record on a saved order what the user reports from the vendor's site: quoted total, order number, order link, tracking, shipping, tax, a note, or the next status (quoted, submitted, in_fab, shipped, delivered, cancelled). A record only: it never contacts the vendor. Use only values the user gave; never invent an order number, total or tracking number.", properties: { name, id: ORDER_ID, status: { type: "string", enum: ["quoted", "submitted", "in_fab", "shipped", "delivered", "cancelled"] }, note: { type: "string" }, vendor: { type: "object", description: "{name, orderNumber, orderUrl (https), quotedTotal, currency}" }, tracking: { type: "object", description: "{carrier, number, url (https)}" }, shippingMethod: { type: "string" }, shippingAmount: { type: "number" }, taxPct: { type: "number" } }, required: ["name", "id"],
    run: async (a, c) => orderOut(await json(c, "PATCH", `${d(a)}/orders/${enc(a.id)}`, { status: a.status, note: a.note, vendor: a.vendor, tracking: a.tracking, shipping: a.shippingMethod !== undefined || a.shippingAmount !== undefined ? { method: a.shippingMethod, amount: a.shippingAmount } : undefined, tax: a.taxPct !== undefined ? { ratePct: a.taxPct } : undefined })) },
]

export const findTool =(n: string) => TOOLS.find((t) => t.name === n)
export const inputSchema = (t: Tool) => ({ type: "object", properties: t.properties, required: t.required ?? [] })

const typeOk = (v: unknown, type: string) =>
  type === "null" ? v === null : type === "array" ? Array.isArray(v) : type === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : type === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === type

/** Check arguments against the tool's schema (required, top-level types, enums). Throws ToolError. */
export function checkArgs(t: Tool, a: any) {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new ToolError(`${t.name}: arguments must be an object`)
  for (const r of t.required ?? []) if (a[r] === undefined) throw new ToolError(`${t.name}: "${r}" is required`)
  for (const [k, v] of Object.entries(a)) {
    const spec = t.properties[k]
    if (!spec) throw new ToolError(`${t.name}: unknown argument "${k}" (expected: ${Object.keys(t.properties).join(", ") || "none"})`)
    if (v === undefined) continue
    const types: string[] = Array.isArray(spec.type) ? spec.type : [spec.type]
    if (!types.some((x) => typeOk(v, x))) throw new ToolError(`${t.name}: "${k}" must be ${types.join(" or ")}`)
    if (spec.enum && !spec.enum.includes(v)) throw new ToolError(`${t.name}: "${k}" must be one of ${spec.enum.join(", ")}`)
    for (const r of spec.required ?? []) if ((v as any)?.[r] === undefined) throw new ToolError(`${t.name}: "${k}.${r}" is required`)
  }
}

/** Validate and run one tool by name. */
export async function runTool(toolName: string, args: any, ctx: ToolCtx) {
  const t = findTool(toolName)
  if (!t) throw new ToolError(`unknown tool ${toolName}`)
  const a = args ?? {}
  checkArgs(t, a)
  return t.run(a, ctx)
}
