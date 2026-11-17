// Orders: turn a full build into a fab package, gate it, estimate it and keep a record per order.
// Nothing here talks to a manufacturer. The record tracks what the user did on the vendor's site
// (quote, order number, tracking); payment is always done by the user there.
import type { FastifyInstance } from "fastify"
import JSZip from "jszip"
import { convertCircuitJsonToGerberFiles } from "circuit-json-to-gerber"
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { bomCsv, computeBom } from "./bom.js"
import { buildDesign, NAME_RE, readDesignFiles, readMeta, ROOT } from "./build.js"
import { runChecks } from "./checks.js"
import { boardInfo, estimateFab, jlcCplCsv, jlcCplRows, makeQuote, stockCheck, suggestAlternates, type CplRow, type Quote, type QuoteExtras, type StockLine } from "./cost.js"

// Records are small JSON files meant to be committed (they answer "which revision did I order?").
// Package zips are large and reproducible, so they sit in the gitignored cache; the record keeps their hash.
const ordersDir = () => process.env.HW_ORDERS_DIR ?? path.join(ROOT, "orders")
const packageDir = () => process.env.HW_ORDER_PKG_DIR ?? path.join(ROOT, ".cache", "orders")
const ID_RE = /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/
const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex")
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode })

export const STATUSES = ["draft", "quoted", "submitted", "in_fab", "shipped", "delivered", "cancelled"] as const
export type OrderStatus = (typeof STATUSES)[number]

export type OrderOptions = {
  /** which sides JLCPCB assembles; "none" orders bare boards and skips the BOM, CPL and parts gates */
  assembly: "none" | "top" | "both"
  thicknessMm: number
  copperOz: number
  finish: string
  colour: string
  /** refs you fit by hand: left out of bom.csv and cpl.csv and not required to have an LCSC number */
  handFit: string[]
  /** ref -> exact CPL rotation, for parts corrected after a JLCPCB placement review */
  rotationOverrides: Record<string, number>
}
export const DEFAULT_OPTIONS: OrderOptions = { assembly: "top", thicknessMm: 1.6, copperOz: 1, finish: "HASL lead-free", colour: "green", handFit: [], rotationOverrides: {} }

export type Gate = { id: "build" | "checks" | "lcsc" | "catalogue" | "stock" | "rotation" | "review"; level: "pass" | "warn" | "block"; text: string; refs?: string[] }
export type OrderPreflight = { ok: boolean; checkedAt: string; gates: Gate[]; stock: StockLine[] }
export type PackageFile = { name: string; bytes: number; sha256: string }
/** `sha256` covers the file contents, ignoring the generation time in Gerber headers */
export type OrderPackage = { file: string; bytes: number; sha256: string; files: PackageFile[]; builtAt: string; sourceHash: string; cpl: { total: number; verified: number; override: number; unverified: string[] } }

export type Order = {
  id: string
  design: string
  revision: string
  createdAt: string
  updatedAt: string
  status: OrderStatus
  qty: number
  options: OrderOptions
  board: { layers: number; widthMm: number; heightMm: number }
  git: { commit: string | null; dirty: boolean | null }
  package: OrderPackage
  preflight: OrderPreflight
  quote: Quote
  /** numbers the quote is rebuilt from when shipping or tax change */
  costBasis: { qty: number; partsCostPerBoard: number; extendedFeesPerBoard: number; missingCount: number; fab: { fabTotal: number; assemblyTotal: number } }
  /** filled in by the user from the vendor's site */
  vendor: { name: string; orderNumber: string; orderUrl: string; quotedTotal: number | null; currency: string }
  tracking: { carrier: string; number: string; url: string }
  note: string
  history: { at: string; status: OrderStatus; note: string }[]
}

// ---------------------------------------------------------------- inputs

function normalizeOptions(o: any, base: OrderOptions = DEFAULT_OPTIONS): OrderOptions {
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : d)
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && v >= lo && v <= hi ? v : d)
  const refs = Array.isArray(o?.handFit) ? o.handFit.filter((r: unknown) => typeof r === "string" && r.length <= 60).slice(0, 500) : base.handFit
  const overrides: Record<string, number> = {}
  const src = o?.rotationOverrides && typeof o.rotationOverrides === "object" ? o.rotationOverrides : base.rotationOverrides
  for (const [ref, deg] of Object.entries(src)) if (ref.length <= 60 && typeof deg === "number" && Number.isFinite(deg)) overrides[ref] = deg
  return {
    assembly: ["none", "top", "both"].includes(o?.assembly) ? o.assembly : base.assembly,
    thicknessMm: num(o?.thicknessMm, base.thicknessMm, 0.4, 3.2),
    copperOz: num(o?.copperOz, base.copperOz, 0.5, 4),
    finish: str(o?.finish, base.finish),
    colour: str(o?.colour, base.colour),
    handFit: [...new Set<string>(refs)],
    rotationOverrides: overrides,
  }
}

const qtyOf = (q: unknown) => {
  const n = Math.floor(Number(q))
  if (!Number.isFinite(n) || n < 1 || n > 100000) throw fail(400, "qty must be a whole number from 1 to 100000")
  return n
}

/** Hash of everything the build reads: the design's files and every lib block. */
export function sourceHash(name: string): string {
  const h = crypto.createHash("sha256")
  let files: Record<string, string> = {}
  try { files = readDesignFiles(name) } catch {}
  for (const f of Object.keys(files).sort()) h.update(`designs/${f}\0${files[f]}\0`)
  const lib = path.join(ROOT, "lib")
  if (fs.existsSync(lib)) for (const f of fs.readdirSync(lib).sort()) if (/\.tsx?$/.test(f)) h.update(`lib/${f}\0${fs.readFileSync(path.join(lib, f), "utf8")}\0`)
  return h.digest("hex")
}

function gitInfo(name: string): Order["git"] {
  const run = (args: string[]) => execFileSync("git", args, { cwd: ROOT, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  try { return { commit: run(["rev-parse", "HEAD"]), dirty: run(["status", "--porcelain", "--", `designs/${name}`, "lib"]).length > 0 } }
  catch { return { commit: null, dirty: null } }
}

/** Circuit without the hand-fitted parts' placements, so they drop out of the BOM, CPL and assembly estimate. */
function withoutRefs(circuitJson: any[], refs: string[]) {
  if (!refs.length) return circuitJson
  const drop = new Set(circuitJson.filter((e) => e.type === "source_component" && refs.includes(e.name)).map((e) => e.source_component_id))
  return circuitJson.filter((e) => !(e.type === "pcb_component" && drop.has(e.source_component_id)))
}

// ---------------------------------------------------------------- package

// Protel-style extensions, which the JLCPCB uploader recognises reliably (same as the export route).
const GERBER_EXT: Record<string, string> = {
  F_Cu: "gtl", B_Cu: "gbl", F_Mask: "gts", B_Mask: "gbs",
  F_SilkScreen: "gto", B_SilkScreen: "gbo", F_Paste: "gtp", B_Paste: "gbp", Edge_Cuts: "gm1",
}

function optionsText(o: { design: string; revision: string; qty: number; options: OrderOptions; board: Order["board"]; cpl: CplRow[] }): string {
  const a = o.options.assembly
  const lines = [
    `${o.design} revision ${o.revision}`,
    "",
    "Enter these on the manufacturer's order form:",
    `  Quantity:        ${o.qty}`,
    `  Layers:          ${o.board.layers}`,
    `  Board size:      ${o.board.widthMm} x ${o.board.heightMm} mm`,
    `  Thickness:       ${o.options.thicknessMm} mm`,
    `  Outer copper:    ${o.options.copperOz} oz`,
    `  Surface finish:  ${o.options.finish}`,
    `  Solder mask:     ${o.options.colour}`,
    `  Assembly:        ${a === "none" ? "none (bare boards)" : a === "top" ? "top side" : "both sides"}`,
  ]
  if (a !== "none") {
    lines.push("", "Files: upload the Gerber files as one zip, then bom.csv and cpl.csv on the assembly step.")
    if (o.options.handFit.length) lines.push(`Fitted by hand, not in bom.csv or cpl.csv: ${o.options.handFit.join(", ")}`)
    const bad = o.cpl.filter((r) => r.status === "unverified")
    lines.push("", `cpl.csv rotations: ${o.cpl.length - bad.length} of ${o.cpl.length} corrected to JLCPCB's footprint orientation.`)
    if (bad.length) lines.push(`Not verified (check these on the placement preview): ${bad.map((r) => r.ref).join(", ")}`)
  }
  return lines.join("\r\n") + "\r\n"
}

// Gerber and drill headers carry the time they were generated; leave that out of hashes so the same build hashes the same.
const stable = (name: string, data: string | Buffer) => (/\.(csv|txt)$/.test(name) ? data : String(data).replace(/^.*(?:CreationDate|Created by tscircuit|DRILL file .* date ).*$/gm, ""))

/** Gerbers, drill, bom.csv, cpl.csv and order-options.txt. `hash` is the same for the same build and options. */
export async function buildPackage(circuitJson: any[], o: { design: string; revision: string; qty: number; options: OrderOptions }) {
  const info = boardInfo(circuitJson)
  const board = { layers: info.layers, widthMm: info.width, heightMm: info.height }
  const placed = withoutRefs(circuitJson, o.options.handFit)
  const cpl = o.options.assembly === "none" ? [] : jlcCplRows(placed, o.options.rotationOverrides).filter((r) => o.options.assembly === "both" || r.layer === "top")
  const files: Record<string, string | Buffer> = {}
  for (const [file, content] of Object.entries(convertCircuitJsonToGerberFiles(circuitJson as any))) {
    const base = file.replace(/\.gbr$/, "")
    files[GERBER_EXT[base] ? `${base}.${GERBER_EXT[base]}` : file] = content as string
  }
  if (o.options.assembly !== "none") {
    files["bom.csv"] = await bomCsv(placed)
    files["cpl.csv"] = jlcCplCsv(cpl)
  }
  files["order-options.txt"] = optionsText({ ...o, board, cpl })
  const zip = new JSZip()
  const date = new Date(0)
  const names = Object.keys(files).sort()
  for (const n of names) zip.file(n, files[n], { date })
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  const meta = names.map((n) => ({ name: n, bytes: Buffer.byteLength(files[n]), sha256: sha256(stable(n, files[n])) }))
  return { buffer, board, cpl, files: meta, hash: sha256(meta.map((f) => f.name + ":" + f.sha256).join("\n")) }
}

// ---------------------------------------------------------------- pre-flight gate

type BomLike = { rows: { refs: string[]; lcsc: string | null; qtyPerBoard: number; stock: number | null; missing: boolean }[] }

/** Blocks on anything that would make the order wrong; warns on what the user should look at. */
export function gate(input: {
  buildErrors: { message: string }[]
  checks: { counts: { error: number; warning: number } } | null
  bom: BomLike
  stock: StockLine[]
  cpl: CplRow[]
  openReviewItems: number
  assembly: OrderOptions["assembly"]
  qty: number
}): Gate[] {
  const gates: Gate[] = []
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  gates.push(input.buildErrors.length
    ? { id: "build", level: "block", text: `${n(input.buildErrors.length, "build error")}: ${input.buildErrors.slice(0, 3).map((e) => e.message).join("; ")}` }
    : { id: "build", level: "pass", text: "Full build has no errors" })
  if (!input.checks) gates.push({ id: "checks", level: "block", text: "Design-rule checks could not run" })
  else if (input.checks.counts.error) gates.push({ id: "checks", level: "block", text: `${n(input.checks.counts.error, "design-rule error")}; see the Problems tab` })
  else if (input.checks.counts.warning) gates.push({ id: "checks", level: "warn", text: `No design-rule errors, ${n(input.checks.counts.warning, "warning")}` })
  else gates.push({ id: "checks", level: "pass", text: "Design-rule checks are clean" })

  if (input.assembly !== "none") {
    const noLcsc = input.bom.rows.filter((r) => !r.lcsc).flatMap((r) => r.refs)
    gates.push(noLcsc.length
      ? { id: "lcsc", level: "block", text: `${n(noLcsc.length, "part")} without an LCSC number. Give each one a number or mark it as fitted by hand.`, refs: noLcsc }
      : { id: "lcsc", level: "pass", text: "Every assembled part has an LCSC number" })
    const unknown = input.bom.rows.filter((r) => r.lcsc && r.missing)
    if (unknown.length) gates.push({ id: "catalogue", level: "block", text: `${n(unknown.length, "LCSC number")} not found in the catalogue (wrong number, or the lookup failed): ${unknown.map((r) => r.lcsc).join(", ")}`, refs: unknown.flatMap((r) => r.refs) })
    const short = input.stock.filter((l) => l.state === "short")
    const tight = input.stock.filter((l) => l.state === "tight")
    const blind = input.stock.filter((l) => l.state === "unknown")
    if (short.length) gates.push({ id: "stock", level: "block", text: `${n(short.length, "BOM line")} short of stock for ${n(input.qty, "board")}: ${short.map((l) => `${l.lcsc} (${l.stock} of ${l.needed})`).join(", ")}`, refs: short.flatMap((l) => l.refs) })
    // "unknown" is a warning, not a pass: the catalogue often has no stock figure, and that must not read as "in stock"
    if (blind.length) gates.push({ id: "stock", level: "warn", text: `Stock not checked for ${blind.length} of ${n(input.stock.length, "BOM line")}: the catalogue has no figure for them. Confirm on JLCPCB's parts page: ${blind.map((l) => l.lcsc).join(", ")}`, refs: blind.flatMap((l) => l.refs) })
    if (tight.length) gates.push({ id: "stock", level: "warn", text: `${n(tight.length, "line")} with less than twice the stock needed: ${tight.map((l) => `${l.lcsc} (${l.stock} for ${l.needed})`).join(", ")}`, refs: tight.flatMap((l) => l.refs) })
    if (!short.length && !blind.length && !tight.length) gates.push({ id: "stock", level: "pass", text: `Every line has at least twice the stock needed for ${n(input.qty, "board")}` })
    const unverified = input.cpl.filter((r) => r.status === "unverified")
    gates.push(unverified.length
      ? { id: "rotation", level: "warn", text: `${n(unverified.length, "placement rotation")} could not be checked against JLCPCB's footprint; check them on the placement preview`, refs: unverified.map((r) => r.ref) }
      : { id: "rotation", level: "pass", text: "Every placement rotation is matched to JLCPCB's footprint" })
  }
  if (input.openReviewItems) gates.push({ id: "review", level: "warn", text: `${n(input.openReviewItems, "review item")} still open on the Review tab` })
  return gates
}

// ---------------------------------------------------------------- assemble, store

export type OrderInput = { qty: unknown; options?: unknown; shipping?: QuoteExtras["shipping"]; tax?: QuoteExtras["tax"]; note?: unknown }
type BuildLike = { circuitJson: any[]; errors: { message: string }[] }

/** Package, pre-flight and estimate for one build. Pure apart from part lookups. */
export async function assemble(name: string, build: BuildLike, input: { qty: number; options: OrderOptions; shipping?: QuoteExtras["shipping"]; tax?: QuoteExtras["tax"] }, meta: any) {
  const revision = String(meta?.revision ?? "0")
  const { qty, options } = input
  const pkg = await buildPackage(build.circuitJson, { design: name, revision, qty, options })
  const placed = withoutRefs(build.circuitJson, options.handFit)
  const bom = await computeBom(placed, qty, false)
  let checks: Awaited<ReturnType<typeof runChecks>> | null = null
  try { checks = await runChecks(build.circuitJson, meta?.rules) } catch {}
  const stock = options.assembly === "none" ? [] : await suggestAlternates(placed, stockCheck(bom.rows, qty))
  const openReviewItems = Array.isArray(meta?.checklist) ? meta.checklist.filter((c: any) => c?.status === "open").length : 0
  const gates = gate({ buildErrors: build.errors, checks, bom, stock, cpl: pkg.cpl, openReviewItems, assembly: options.assembly, qty })
  const costBasis = { qty, partsCostPerBoard: bom.summary.partsCostPerBoard, extendedFeesPerBoard: bom.summary.setupFeesPerBoard, missingCount: bom.summary.missingCount, fab: (({ fabTotal, assemblyTotal }) => ({ fabTotal, assemblyTotal }))(estimateFab(placed, qty)) }
  return {
    revision, pkg, costBasis,
    preflight: { ok: !gates.some((g) => g.level === "block"), checkedAt: new Date().toISOString(), gates, stock: stock.filter((l) => l.state !== "ok") } as OrderPreflight,
    quote: makeQuote(costBasis, { assembly: options.assembly !== "none", shipping: input.shipping, tax: input.tax }),
  }
}

const orderFile = (name: string, id: string) => path.join(ordersDir(), name, `${id}.json`)
const zipFile = (name: string, id: string) => path.join(packageDir(), name, `${id}.zip`)

function write(order: Order) {
  fs.mkdirSync(path.join(ordersDir(), order.design), { recursive: true })
  fs.writeFileSync(orderFile(order.design, order.id), JSON.stringify(order, null, 2) + "\n")
}

export function readOrder(name: string, id: string): Order | null {
  if (!NAME_RE.test(name) || !ID_RE.test(id)) return null
  try { return JSON.parse(fs.readFileSync(orderFile(name, id), "utf8")) } catch { return null }
}

export type OrderSummary = Pick<Order, "id" | "design" | "revision" | "createdAt" | "updatedAt" | "status" | "qty"> & { total: number; estimate: boolean; preflightOk: boolean; orderNumber: string; tracking: string }
const summary = (o: Order): OrderSummary => ({
  id: o.id, design: o.design, revision: o.revision, createdAt: o.createdAt, updatedAt: o.updatedAt, status: o.status, qty: o.qty,
  total: o.vendor.quotedTotal ?? o.quote.total, estimate: o.vendor.quotedTotal === null, preflightOk: o.preflight.ok, orderNumber: o.vendor.orderNumber, tracking: o.tracking.number,
})

/** Newest first; one design, or every design when `name` is omitted. */
export function listOrders(name?: string): OrderSummary[] {
  const root = ordersDir()
  const designs = name ? [name] : fs.existsSync(root) ? fs.readdirSync(root).filter((d) => NAME_RE.test(d)) : []
  const out: OrderSummary[] = []
  for (const d of designs) {
    const dir = path.join(root, d)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      const o = f.endsWith(".json") ? readOrder(d, f.slice(0, -5)) : null
      if (o) out.push(summary(o))
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function newId(name: string): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  let id = base
  for (let i = 1; fs.existsSync(orderFile(name, id)); i++) id = `${base}-${i}`
  return id
}

function storePackage(name: string, id: string, pkg: Awaited<ReturnType<typeof buildPackage>>, revision: string): OrderPackage {
  fs.mkdirSync(path.join(packageDir(), name), { recursive: true })
  fs.writeFileSync(zipFile(name, id), pkg.buffer)
  const bad = pkg.cpl.filter((r) => r.status === "unverified").map((r) => r.ref)
  return {
    file: `${name}-r${revision.replace(/[^A-Za-z0-9._-]/g, "")}-${id}.zip`, bytes: pkg.buffer.length, sha256: pkg.hash, files: pkg.files,
    builtAt: new Date().toISOString(), sourceHash: sourceHash(name),
    cpl: { total: pkg.cpl.length, verified: pkg.cpl.filter((r) => r.status === "verified").length, override: pkg.cpl.filter((r) => r.status === "override").length, unverified: bad },
  }
}

/** Build the saved design in full and save a draft order. A failed gate still saves: the draft shows what to fix. */
export async function createOrder(name: string, input: OrderInput, prebuilt?: BuildLike): Promise<Order> {
  const qty = qtyOf(input.qty)
  const options = normalizeOptions(input.options)
  const build = prebuilt ?? (await buildDesign(name))
  if (!build.circuitJson.length) throw fail(422, build.errors[0]?.message ?? "build failed")
  const a = await assemble(name, build, { qty, options, shipping: input.shipping, tax: input.tax }, readMeta(name))
  const id = newId(name)
  const now = new Date().toISOString()
  const order: Order = {
    id, design: name, revision: a.revision, createdAt: now, updatedAt: now, status: "draft", qty, options,
    board: a.pkg.board, git: gitInfo(name), package: storePackage(name, id, a.pkg, a.revision), preflight: a.preflight, quote: a.quote, costBasis: a.costBasis,
    vendor: { name: "JLCPCB", orderNumber: "", orderUrl: "", quotedTotal: null, currency: "USD" },
    tracking: { carrier: "", number: "", url: "" },
    note: typeof input.note === "string" ? input.note.slice(0, 2000) : "",
    history: [{ at: now, status: "draft", note: "Draft created" }],
  }
  write(order)
  return order
}

/** Rebuild the package, pre-flight and estimate of an order that has not been placed yet. */
export async function refreshOrder(name: string, id: string, input: Partial<OrderInput> = {}): Promise<Order> {
  const order = readOrder(name, id)
  if (!order) throw fail(404, "order not found")
  if (order.status !== "draft" && order.status !== "quoted") throw fail(409, `This order is ${order.status.replace("_", " ")}; its package is fixed. Create a new order for a changed design.`)
  const qty = input.qty === undefined ? order.qty : qtyOf(input.qty)
  const options = input.options === undefined ? order.options : normalizeOptions(input.options, order.options)
  const build = await buildDesign(name)
  if (!build.circuitJson.length) throw fail(422, build.errors[0]?.message ?? "build failed")
  const a = await assemble(name, build, { qty, options, shipping: input.shipping ?? order.quote.shipping, tax: input.tax ?? { ratePct: order.quote.tax.ratePct } }, readMeta(name))
  const now = new Date().toISOString()
  const changed = a.pkg.files.some((f) => order.package.files.find((x) => x.name === f.name)?.sha256 !== f.sha256) || a.pkg.files.length !== order.package.files.length
  Object.assign(order, {
    qty, options, revision: a.revision, updatedAt: now, board: a.pkg.board, git: gitInfo(name), package: storePackage(name, id, a.pkg, a.revision),
    preflight: a.preflight, quote: a.quote, costBasis: a.costBasis,
  })
  // a vendor quote was for the old files
  if (changed && order.status === "quoted") { order.status = "draft"; order.vendor.quotedTotal = null; order.history.push({ at: now, status: "draft", note: "Package changed; vendor quote cleared" }) }
  else order.history.push({ at: now, status: order.status, note: changed ? "Package rebuilt (files changed)" : "Pre-flight and estimate refreshed" })
  write(order)
  return order
}

export type OrderPatch = {
  status?: OrderStatus; note?: string; force?: boolean
  shipping?: QuoteExtras["shipping"]; tax?: QuoteExtras["tax"]
  vendor?: Partial<Order["vendor"]>; tracking?: Partial<Order["tracking"]>
}

/** Record what happened on the vendor's side: quote, order number, tracking, status. Never contacts the vendor. */
export function updateOrder(name: string, id: string, patch: OrderPatch): Order {
  const order = readOrder(name, id)
  if (!order) throw fail(404, "order not found")
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined)
  const link = (v: unknown) => { const s = text(v, 500); return s === undefined ? undefined : s === "" || /^https:\/\/[^\s"'<>]+$/.test(s) ? s : (() => { throw fail(400, "links must start with https://") })() }
  if (patch.vendor) {
    const v = patch.vendor
    order.vendor = {
      name: text(v.name, 60) || order.vendor.name,
      orderNumber: text(v.orderNumber, 80) ?? order.vendor.orderNumber,
      orderUrl: link(v.orderUrl) ?? order.vendor.orderUrl,
      quotedTotal: v.quotedTotal === undefined ? order.vendor.quotedTotal : v.quotedTotal === null ? null : typeof v.quotedTotal === "number" && v.quotedTotal >= 0 && Number.isFinite(v.quotedTotal) ? Math.round(v.quotedTotal * 100) / 100 : (() => { throw fail(400, "quotedTotal must be a positive number") })(),
      currency: text(v.currency, 3)?.toUpperCase() || order.vendor.currency,
    }
  }
  if (patch.tracking) {
    const t = patch.tracking
    order.tracking = { carrier: text(t.carrier, 60) ?? order.tracking.carrier, number: text(t.number, 80) ?? order.tracking.number, url: link(t.url) ?? order.tracking.url }
  }
  if (patch.shipping || patch.tax)
    order.quote = makeQuote(order.costBasis, { assembly: order.options.assembly !== "none", shipping: patch.shipping ?? order.quote.shipping, tax: patch.tax ?? { ratePct: order.quote.tax.ratePct } })
  const note = text(patch.note, 2000)
  if (note !== undefined && !patch.status) order.note = note
  const now = new Date().toISOString()
  if (patch.status && patch.status !== order.status) {
    const to = patch.status
    if (!STATUSES.includes(to)) throw fail(400, "unknown status")
    const from = STATUSES.indexOf(order.status)
    if (order.status === "cancelled" || order.status === "delivered") throw fail(409, `This order is already ${order.status}`)
    if (to !== "cancelled" && STATUSES.indexOf(to) < from) throw fail(409, `An order cannot go back from ${order.status.replace("_", " ")} to ${to.replace("_", " ")}`)
    if (to === "quoted" && order.vendor.quotedTotal === null) throw fail(400, "Enter the vendor's quoted total first")
    if (STATUSES.indexOf(to) >= STATUSES.indexOf("submitted") && to !== "cancelled") {
      if (!order.vendor.orderNumber) throw fail(400, "Enter the vendor's order number first")
      if (from < STATUSES.indexOf("submitted") && !patch.force) {
        if (!order.preflight.ok) throw fail(409, "Pre-flight has blocking items. Fix them and refresh, or confirm that you ordered anyway.")
        if (order.package.sourceHash !== sourceHash(name)) throw fail(409, "The design changed after this package was built. Refresh the order, or confirm that you ordered this package anyway.")
      }
    }
    order.status = to
    order.history.push({ at: now, status: to, note: note ?? (patch.force ? "Marked by hand despite a failed gate" : "") })
  }
  order.updatedAt = now
  write(order)
  return order
}

export function deleteOrder(name: string, id: string) {
  const order = readOrder(name, id)
  if (!order) throw fail(404, "order not found")
  if (order.status !== "draft" && order.status !== "cancelled") throw fail(409, "Only draft or cancelled orders can be deleted; cancel it first")
  fs.rmSync(orderFile(name, id), { force: true })
  fs.rmSync(zipFile(name, id), { force: true })
}

/** The record plus live facts: is the package still on disk, has the design moved on since it was built. */
const view = (o: Order) => ({ ...o, stale: o.package.sourceHash !== sourceHash(o.design), packageOnDisk: fs.existsSync(zipFile(o.design, o.id)) })
export type OrderView = ReturnType<typeof view>

// ---------------------------------------------------------------- routes

export function registerOrderRoutes(app: FastifyInstance, designExists: (n: string) => boolean) {
  type P = { Params: { name: string; id: string } }
  const guard = (req: { params: { name: string } }, reply: any) => (designExists(req.params.name) ? true : (reply.code(404).send({ error: "design not found" }), false))

  app.get("/api/orders", async () => listOrders())
  app.get<{ Params: { name: string } }>("/api/designs/:name/orders", async (req, reply) => guard(req, reply) && listOrders(req.params.name))

  // Gate and estimate without saving anything.
  app.get<{ Params: { name: string }; Querystring: { qty?: string; assembly?: string } }>("/api/designs/:name/order-preflight", async (req, reply) => {
    if (!guard(req, reply)) return
    const { name } = req.params
    const build = await buildDesign(name)
    if (!build.circuitJson.length) return reply.code(422).send({ error: build.errors[0]?.message ?? "build failed" })
    const a = await assemble(name, build, { qty: qtyOf(req.query.qty ?? 10), options: normalizeOptions({ assembly: req.query.assembly }) }, readMeta(name))
    return { preflight: a.preflight, quote: a.quote, files: a.pkg.files, cpl: a.pkg.cpl }
  })

  app.post<{ Params: { name: string }; Body: OrderInput }>("/api/designs/:name/orders", async (req, reply) => guard(req, reply) && view(await createOrder(req.params.name, req.body ?? ({} as OrderInput))))

  app.get<P>("/api/designs/:name/orders/:id", async (req, reply) => {
    const o = readOrder(req.params.name, req.params.id)
    return o ? view(o) : reply.code(404).send({ error: "order not found" })
  })
  app.patch<P & { Body: OrderPatch }>("/api/designs/:name/orders/:id", async (req) => view(updateOrder(req.params.name, req.params.id, req.body ?? {})))
  app.post<P & { Body: Partial<OrderInput> }>("/api/designs/:name/orders/:id/refresh", async (req, reply) => guard(req, reply) && view(await refreshOrder(req.params.name, req.params.id, req.body ?? {})))
  app.delete<P>("/api/designs/:name/orders/:id", async (req) => { deleteOrder(req.params.name, req.params.id); return { ok: true } })

  const TYPES: Record<string, string> = { csv: "text/csv; charset=utf-8", txt: "text/plain; charset=utf-8" }
  app.get<P & { Querystring: { file?: string } }>("/api/designs/:name/orders/:id/package", async (req, reply) => {
    const o = readOrder(req.params.name, req.params.id)
    if (!o) return reply.code(404).send({ error: "order not found" })
    const file = zipFile(o.design, o.id)
    if (!fs.existsSync(file)) return reply.code(410).send({ error: "The package file is no longer on this machine (it lives in the cache). Refresh the order to rebuild it; the record keeps the original hash." })
    const buf = fs.readFileSync(file)
    const want = req.query.file
    if (!want) return reply.header("Content-Type", "application/zip").header("Content-Disposition", `attachment; filename="${o.package.file}"`).send(buf)
    if (!o.package.files.some((f) => f.name === want)) return reply.code(404).send({ error: "no such file in this package" })
    const data = await (await JSZip.loadAsync(buf)).file(want)!.async("nodebuffer")
    return reply.header("Content-Type", TYPES[want.split(".").pop()!] ?? "application/octet-stream").header("Content-Disposition", `attachment; filename="${want}"`).send(data)
  })
}
