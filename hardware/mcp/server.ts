// MCP server (stdio) exposing the hardware designer API to Claude Code.
// Dependency-free: implements the small slice of MCP it needs (initialize, tools/list, tools/call) as
// newline-delimited JSON-RPC, so no `@modelcontextprotocol/sdk` install is required.
// The designer API must be running (`npm run dev` in hardware/); override the URL with HW_API_URL.
const BASE = (process.env.HW_API_URL ?? `http://127.0.0.1:${process.env.HW_API_PORT ?? 3101}`).replace(/\/$/, "")
const enc = encodeURIComponent

type Tool = {
  name: string
  description: string
  properties: Record<string, any>
  required?: string[]
  run: (a: any) => Promise<any>
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; type: string; buf: Buffer }> {
  const res = await fetch(BASE + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, type: res.headers.get("content-type") ?? "", buf: Buffer.from(await res.arrayBuffer()) }
}
async function json(method: string, path: string, body?: unknown) {
  const r = await call(method, path, body)
  const text = r.buf.toString("utf8")
  let data: any = text
  try { data = JSON.parse(text) } catch {}
  if (r.status >= 400) throw new Error(`${r.status}: ${data?.error ?? data?.message ?? text}`)
  return data
}

const name = { type: "string", description: "Design folder name, e.g. relay-8 (see list_designs)" }
const TOOLS: Tool[] = [
  { name: "list_designs", description: "List board designs with their board.json metadata.", properties: {}, run: () => json("GET", "/api/designs") },
  { name: "read_design", description: "Read a design: metadata and all source files (index.tsx, board.json, ...). Lib blocks live in hardware/lib and are read from disk.", properties: { name }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}`) },
  { name: "build_design", description: "Build a design. mode \"quick\" (default) places parts without autorouting and takes seconds; \"full\" autoroutes and can take minutes on large boards. Returns ok, errors, warnings, duration and a design-rule check summary, not the full circuit JSON. Optional unsaved file overrides.", properties: { name, mode: { type: "string", enum: ["quick", "full"] }, files: { type: "object", description: "Optional {path: content} overrides, not saved" } }, required: ["name"],
    run: async (a) => { const r = await json("POST", `/api/designs/${enc(a.name)}/build`, { files: a.files, mode: a.mode === "full" ? "full" : "quick" }); return { ok: r.ok, mode: r.mode, durationMs: r.durationMs, errors: r.errors, warnings: r.warnings, checks: r.checks?.counts, elements: r.circuitJson?.length ?? 0 } } },
  { name: "run_checks", description: "Design-rule checks with plain-English title, why and fix for each issue (clearances, overlaps, antenna keep-out, decoupling; trace width/current only in full mode). mode quick (default, seconds) or full (routes first).", properties: { name, mode: { type: "string", enum: ["quick", "full"] } }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/checks?mode=${a.mode === "full" ? "full" : "quick"}`) },
  { name: "cost_summary", description: "Estimated per-board cost at a quantity: parts, JLC extended-part fees, fab and assembly estimate, unpriced part count.", properties: { name, qty: { type: "number" } }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/cost?qty=${a.qty ?? 10}`) },
  { name: "gpio_map", description: "ESP32-S3 module pin map: each IO pin's net and notes (strapping, PSRAM, USB, ADC2) plus clashes.", properties: { name }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/gpio`) },
  { name: "list_components", description: "Components of the last build: ref, type, value, MPN, footprint, LCSC, position, rotation, pin->net map and the source file/line (or lib block) that places each part.", properties: { name }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/components`) },
  { name: "list_nets", description: "Nets of the last build with kind (ground/power/signal) and the ports on each.", properties: { name }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/nets`) },
  { name: "explain_design", description: "Deterministic plain-English walkthrough of the board grouped by function, with the parts each sentence mentions.", properties: { name }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/explain`) },
  { name: "get_bom", description: "Priced BOM (jlcsearch) for a design at a build quantity.", properties: { name, qty: { type: "number", description: "boards, default 10" } }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/bom?qty=${a.qty ?? 10}`) },
  { name: "get_snapshot", description: "PNG image of the PCB or schematic from the last build.", properties: { name, view: { type: "string", enum: ["pcb", "schematic"] }, width: { type: "number" } }, required: ["name"],
    run: async (a) => {
      const r = await call("GET", `/api/designs/${enc(a.name)}/snapshot.png?view=${a.view ?? "pcb"}&width=${a.width ?? 1200}`)
      if (r.status >= 400) throw new Error(`${r.status}: ${r.buf.toString("utf8")}`)
      return { __image: r.buf.toString("base64") }
    } },
  { name: "list_requests", description: "Change requests the user typed in the designer (open ones are what to work on).", properties: { name, status: { type: "string", enum: ["open", "resolved", "dismissed"] } }, required: ["name"],
    run: async (a) => { const r = await json("GET", `/api/designs/${enc(a.name)}/requests`); return a.status ? r.filter((x: any) => x.status === a.status) : r } },
  { name: "propose_change", description: "Submit a proposed change for the user to review. NOTHING is written until the user clicks Accept in the designer. files maps design-relative paths (or lib/<block>.tsx) to full new content, or null to delete. Link requestId when answering a request.", properties: { name, summary: { type: "string", description: "One-line description shown above the diff" }, files: { type: "object" }, requestId: { type: "string" } }, required: ["name", "summary", "files"],
    run: (a) => json("POST", `/api/designs/${enc(a.name)}/proposals`, { summary: a.summary, files: a.files, requestId: a.requestId }) },
  { name: "list_proposals", description: "Proposals with diffs and status (pending/accepted/rejected).", properties: { name, status: { type: "string", enum: ["pending", "accepted", "rejected"] } }, required: ["name"], run: (a) => json("GET", `/api/designs/${enc(a.name)}/proposals${a.status ? `?status=${a.status}` : ""}`) },
]

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n")

async function handle(msg: any) {
  const { id, method, params } = msg
  if (id === undefined) return // notification
  try {
    if (method === "initialize")
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hardware-designer", version: "0.1.0" } } })
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} })
    if (method === "tools/list")
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required ?? [] } })) } })
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } })
      try {
        const out = await tool.run(params.arguments ?? {})
        const content = out?.__image ? [{ type: "image", data: out.__image, mimeType: "image/png" }] : [{ type: "text", text: JSON.stringify(out, null, 2) }]
        return send({ jsonrpc: "2.0", id, result: { content } })
      } catch (e: any) {
        const hint = /fetch failed|ECONNREFUSED/.test(String(e?.message) + String(e?.cause)) ? ` (is the designer running at ${BASE}? run 'npm run dev' in hardware/)` : ""
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e?.message ?? e) + hint }] } })
      }
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (e: any) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } })
  }
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) { try { handle(JSON.parse(line)) } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) } }
  }
})
