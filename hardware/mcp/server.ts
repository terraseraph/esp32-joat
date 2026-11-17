// MCP server (stdio) exposing the hardware designer API to Claude Code.
// Dependency-free: implements the small slice of MCP it needs (initialize, tools/list, tools/call) as
// newline-delimited JSON-RPC, so no `@modelcontextprotocol/sdk` install is required.
// The designer API must be running (`npm run dev` in hardware/); override the URL with HW_API_URL.
const BASE = (process.env.HW_API_URL ?? `http://127.0.0.1:${process.env.HW_API_PORT ?? 3101}`).replace(/\/$/, "")

import { TOOLS, inputSchema, runTool, type ToolCtx } from "../shared/tools.js"

// The tools live in hardware/shared/tools.ts, the registry the in-app AI also uses. This file is only
// the stdio transport: it lists that registry and runs its tools against the designer API over HTTP.
const ctx: ToolCtx = {
  call: async (method, path, body) => {
    const res = await fetch(BASE + path, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined })
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: new Uint8Array(await res.arrayBuffer()) }
  },
}

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n")

async function handle(msg: any) {
  const { id, method, params } = msg
  if (id === undefined) return // notification
  try {
    if (method === "initialize")
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hardware-designer", version: "0.2.0" } } })
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} })
    if (method === "tools/list")
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) })) } })
    if (method === "tools/call") {
      if (!TOOLS.some((t) => t.name === params?.name)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } })
      try {
        const out = await runTool(params.name, params.arguments ?? {}, ctx)
        const content = out?.__image ? [{ type: "image", data: Buffer.from(out.__image).toString("base64"), mimeType: "image/png" }] : [{ type: "text", text: JSON.stringify(out, null, 2) }]
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
