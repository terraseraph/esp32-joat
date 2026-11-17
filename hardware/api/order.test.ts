import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { buildDesign } from "./build.js"
import { jlcCplCsv, jlcCplRows, makeQuote, stockCheck } from "./cost.js"
import { buildPackage, createOrder, DEFAULT_OPTIONS, deleteOrder, gate, listOrders, readOrder, updateOrder } from "./order.js"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-orders-"))
process.env.HW_ORDERS_DIR = path.join(tmp, "orders")
process.env.HW_ORDER_PKG_DIR = path.join(tmp, "pkg")
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const part = (i: number, name: string, extra: object) => [
  { type: "source_component", source_component_id: `s${i}`, name },
  { type: "pcb_component", pcb_component_id: `p${i}`, source_component_id: `s${i}`, center: { x: i, y: 2 }, layer: "top", rotation: 0, ...extra },
]

test("CPL rotation is corrected from the pin-1 position of our footprint and the JLCPCB one", () => {
  const cj = [
    ...part(1, "U1", { rotation: 90, pin1_location: "leftside_top", supplier_pin1_location_map: { jlcpcb: "bottomside_left" } }),
    ...part(2, "R1", { pin1_location: "topside_left", supplier_pin1_location_map: { jlcpcb: "topside_left" } }),
    ...part(3, "J1", { pin1_location: "topside_left" }),
    ...part(4, "Q1", { rotation: 180, pin1_location: "topside_left", supplier_pin1_location_map: { jlcpcb: "bottomside_right" } }),
    ...part(5, "X1", { pin1_location: "topside_left", supplier_pin1_location_map: { jlcpcb: "leftside_top" } }),
    ...part(6, "J2", { pin1_location: "topside_left" }),
    ...part(7, "H1", { do_not_place: true }),
  ]
  const rows = Object.fromEntries(jlcCplRows(cj, { J1: 45 }).map((r) => [r.ref, r]))
  assert.deepEqual([rows.U1.rotation, rows.U1.adjustment, rows.U1.status], [0, 270, "verified"]) // 90 + 270
  assert.deepEqual([rows.R1.rotation, rows.R1.status], [0, "verified"])
  assert.deepEqual([rows.J1.rotation, rows.J1.status], [45, "override"])
  assert.deepEqual([rows.Q1.rotation, rows.Q1.adjustment], [0, 180])
  assert.equal(rows.X1.status, "unverified") // mirror-image frames: no rotation maps one to the other
  assert.equal(rows.X1.rotation, 0)
  assert.match(rows.J2.reason ?? "", /no JLCPCB footprint/)
  assert.equal(rows.H1, undefined)
  assert.equal(jlcCplCsv([rows.U1]), "Designator,Mid X,Mid Y,Layer,Rotation\r\nU1,1mm,2mm,Top,0\r\n")
})

test("quote is labelled as an estimate and stays incomplete until shipping and tax are entered", () => {
  const cost = { qty: 10, partsCostPerBoard: 4, extendedFeesPerBoard: 0.6, missingCount: 1, fab: { fabTotal: 7, assemblyTotal: 20 } }
  const q = makeQuote(cost)
  assert.equal(q.source, "local-estimate")
  assert.deepEqual([q.subtotal, q.total, q.complete, q.shipping.amount, q.tax.amount], [73, 73, false, null, null])
  const full = makeQuote(cost, { shipping: { method: "DHL", amount: 27 }, tax: { ratePct: 10 } })
  assert.deepEqual([full.tax.amount, full.total, full.complete], [10, 110, true])
  assert.equal(makeQuote(cost, { assembly: false }).subtotal, 7)
})

test("gate blocks on errors, missing LCSC numbers and short stock", () => {
  const rows = [
    { refs: ["R1", "R2"], lcsc: "C1", qtyPerBoard: 2, stock: 15, missing: false },
    { refs: ["U1"], lcsc: "C2", qtyPerBoard: 1, stock: 5000, missing: false },
    { refs: ["J1"], lcsc: null, qtyPerBoard: 1, stock: null, missing: true },
  ]
  const stock = stockCheck(rows, 10)
  assert.deepEqual(stock.map((l) => [l.lcsc, l.needed, l.state]), [["C1", 20, "short"], ["C2", 10, "ok"]])
  const base = { buildErrors: [], checks: { counts: { error: 0, warning: 0 } }, bom: { rows }, stock, cpl: [], openReviewItems: 2, assembly: "top" as const, qty: 10 }
  const level = (g: ReturnType<typeof gate>) => Object.fromEntries(g.map((x) => [x.id, x.level]))
  assert.deepEqual(level(gate(base)), { build: "pass", checks: "pass", lcsc: "block", stock: "block", rotation: "pass", review: "warn" })
  assert.deepEqual(level(gate({ ...base, assembly: "none", openReviewItems: 0 })), { build: "pass", checks: "pass" })
  assert.equal(level(gate({ ...base, checks: { counts: { error: 3, warning: 0 } } })).checks, "block")
})

test("a build becomes a saved draft with a repeatable package, then follows the order through to delivery", async () => {
  const name = "order-test-board"
  const src = 'export default () => <board width="20mm" height="20mm"><resistor name="R1" resistance="10k" footprint="0603" pcbX={-3} /><resistor name="R2" resistance="10k" footprint="0603" pcbX={3} /></board>'
  const build = await buildDesign(name, { "index.tsx": src }, "quick", { background: true })
  assert.equal(build.ok, true, JSON.stringify(build.errors))

  const opts = { design: name, revision: "A", qty: 5, options: DEFAULT_OPTIONS }
  const a = await buildPackage(build.circuitJson, opts)
  const b = await buildPackage(build.circuitJson, opts)
  assert.equal(a.hash, b.hash)
  assert.notEqual(a.hash, (await buildPackage(build.circuitJson, { ...opts, qty: 6 })).hash)
  const names = a.files.map((f) => f.name)
  for (const f of ["bom.csv", "cpl.csv", "order-options.txt", "F_Cu.gtl", "Edge_Cuts.gm1"]) assert.ok(names.includes(f), `${f} in ${names}`)
  const bare = await buildPackage(build.circuitJson, { ...opts, options: { ...DEFAULT_OPTIONS, assembly: "none" } })
  assert.ok(!bare.files.some((f) => f.name === "bom.csv" || f.name === "cpl.csv"))

  // no LCSC numbers: saved as a draft, but the gate blocks
  const draft = await createOrder(name, { qty: 5 }, build)
  assert.equal(draft.status, "draft")
  assert.equal(draft.preflight.ok, false)
  assert.deepEqual(draft.preflight.gates.find((g) => g.id === "lcsc")?.refs, ["R1", "R2"])
  assert.equal(draft.quote.source, "local-estimate")
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(process.env.HW_ORDER_PKG_DIR!, name, `${draft.id}.zip`)))
  assert.match(await zip.file("order-options.txt")!.async("string"), /Quantity:\s+5/)
  assert.equal((await zip.file("cpl.csv")!.async("string")).trim().split("\r\n").length, 3)

  // fitted by hand: the parts leave the BOM and CPL and the gate clears
  const ok = await createOrder(name, { qty: 5, options: { handFit: ["R1", "R2"] }, shipping: { method: "DHL", amount: 20 }, tax: { ratePct: 10 } }, build)
  assert.equal(ok.preflight.ok, true, JSON.stringify(ok.preflight.gates))
  assert.equal(ok.quote.complete, true)
  assert.equal(listOrders(name).length, 2)

  assert.throws(() => updateOrder(name, ok.id, { status: "quoted" }), /quoted total/)
  assert.equal(updateOrder(name, ok.id, { vendor: { quotedTotal: 61.5 }, status: "quoted" }).status, "quoted")
  assert.throws(() => updateOrder(name, ok.id, { status: "submitted" }), /order number/)
  assert.throws(() => updateOrder(name, draft.id, { vendor: { orderNumber: "Y1" }, status: "submitted" }), /Pre-flight/)
  assert.throws(() => updateOrder(name, ok.id, { vendor: { orderUrl: "javascript:alert(1)" } }), /https/)
  assert.equal(updateOrder(name, ok.id, { vendor: { orderNumber: "Y123" }, status: "submitted" }).status, "submitted")
  assert.throws(() => updateOrder(name, ok.id, { status: "draft" }), /cannot go back/)
  const shipped = updateOrder(name, ok.id, { status: "shipped", tracking: { carrier: "DHL", number: "123" } })
  assert.equal(shipped.tracking.number, "123")
  assert.equal(updateOrder(name, ok.id, { status: "delivered" }).history.length, 5)
  assert.throws(() => deleteOrder(name, ok.id), /Only draft/)
  deleteOrder(name, draft.id)
  assert.equal(readOrder(name, draft.id), null)
  assert.equal(listOrders().find((o) => o.id === ok.id)?.total, 61.5)
})
