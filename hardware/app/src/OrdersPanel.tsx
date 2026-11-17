import { useCallback, useEffect, useState } from "react"
import { orderApi, type Order, type OrderOptions, type OrderStatus, type OrderSummary } from "./api"
import "./orders.css"

const LABEL: Record<OrderStatus, string> = { draft: "Draft", quoted: "Quoted", submitted: "Ordered", in_fab: "In fab", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" }
const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  draft: { to: "quoted", label: "Save vendor quote" },
  quoted: { to: "submitted", label: "Mark as ordered" },
  submitted: { to: "in_fab", label: "Mark in fab" },
  in_fab: { to: "shipped", label: "Mark shipped" },
  shipped: { to: "delivered", label: "Mark delivered" },
}
const money = (n: number | null, cur = "USD") => (n === null ? "not entered" : `${cur === "USD" ? "$" : `${cur} `}${n.toFixed(2)}`)
const day = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
const numOrNull = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s))

/** Orders for one design: save a draft (package + pre-flight + estimate), then record the quote, order number and tracking by hand. */
export default function OrdersPanel({ name, qty, dirty }: { name: string; qty: number; dirty: boolean }) {
  const [list, setList] = useState<OrderSummary[] | null>(null)
  const [order, setOrder] = useState<Order | null>(null)
  const [busy, setBusy] = useState("")
  const [err, setErr] = useState("")
  const [form, setForm] = useState({ qty: String(qty), assembly: "top" as OrderOptions["assembly"], colour: "green", finish: "HASL lead-free", thicknessMm: "1.6", handFit: "", shipMethod: "", shipAmount: "", taxPct: "" })

  const reload = useCallback(() => orderApi.list(name).then(setList).catch((e) => setErr(e.message)), [name])
  useEffect(() => { reload() }, [reload])

  const run = async (label: string, fn: () => Promise<Order | void>) => {
    setBusy(label); setErr("")
    try { const o = await fn(); if (o) setOrder(o); await reload() } catch (e: any) { setErr(e.message) } finally { setBusy("") }
  }
  const create = () => run("Building the board in full and packaging it…", () => orderApi.create(name, {
    qty: Number(form.qty),
    options: { assembly: form.assembly, colour: form.colour, finish: form.finish, thicknessMm: Number(form.thicknessMm), handFit: form.handFit.split(/[\s,]+/).filter(Boolean) },
    shipping: { method: form.shipMethod, amount: numOrNull(form.shipAmount) }, tax: { ratePct: numOrNull(form.taxPct) },
  }))
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div className="orders">
      {err && <div className="empty err small" role="alert">{err}</div>}
      {busy && <div className="small muted" role="status"><span className="dot pulse" /> {busy}</div>}

      {order ? (
        <OrderDetail order={order} busy={!!busy} onBack={() => setOrder(null)} run={run} />
      ) : (
        <>
          <fieldset className="order-form" disabled={!!busy}>
            <legend>New draft order</legend>
            {dirty && <div className="small" style={{ color: "var(--warn)" }}>You have unsaved edits; the order uses the saved files.</div>}
            <label>Boards<input type="number" min={1} value={form.qty} onChange={set("qty")} /></label>
            <label>Assembly
              <select value={form.assembly} onChange={set("assembly")}>
                <option value="top">Top side</option><option value="both">Both sides</option><option value="none">None (bare boards)</option>
              </select>
            </label>
            <label>Thickness (mm)<input type="number" step={0.2} min={0.4} max={3.2} value={form.thicknessMm} onChange={set("thicknessMm")} /></label>
            <label>Solder mask<input value={form.colour} onChange={set("colour")} /></label>
            <label>Finish<input value={form.finish} onChange={set("finish")} /></label>
            <label className="wide">Fitted by hand (refs, left out of BOM and CPL)<input value={form.handFit} onChange={set("handFit")} placeholder="J1, J2" /></label>
            <label>Shipping method<input value={form.shipMethod} onChange={set("shipMethod")} placeholder="e.g. DHL Express" /></label>
            <label>Shipping (USD)<input type="number" min={0} step={0.01} value={form.shipAmount} onChange={set("shipAmount")} placeholder="from vendor" /></label>
            <label>Tax (%)<input type="number" min={0} step={0.1} value={form.taxPct} onChange={set("taxPct")} placeholder="e.g. 10" /></label>
            <div className="wide row">
              <span className="small muted">Runs a full build, so a large board can take a minute. Nothing is sent to a manufacturer.</span>
              <button className="btn primary" onClick={create} disabled={!(Number(form.qty) >= 1)}>Save draft order</button>
            </div>
          </fieldset>

          <h4>Orders for {name}</h4>
          {!list && <div className="muted small">Loading…</div>}
          {list && !list.length && <div className="muted small">No orders yet. A draft keeps the exact files, the pre-flight result and the estimate for this revision.</div>}
          {list && list.length > 0 && (
            <table className="bom-table orders-table">
              <thead><tr><th>Created</th><th>Rev</th><th className="r">Boards</th><th>Status</th><th className="r">Total</th><th>Order no.</th></tr></thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id} tabIndex={0} onClick={() => run("Loading…", () => orderApi.get(name, o.id))} onKeyDown={(e) => e.key === "Enter" && run("Loading…", () => orderApi.get(name, o.id))}>
                    <td>{day(o.createdAt)}</td><td className="mono">{o.revision}</td><td className="r mono">{o.qty}</td>
                    <td><span className={`order-status s-${o.status}`}>{LABEL[o.status]}</span>{!o.preflightOk && o.status === "draft" && <span className="small" style={{ color: "var(--bad)" }}> blocked</span>}</td>
                    <td className="r mono">{money(o.total)}{o.estimate && <span className="muted small"> est.</span>}</td>
                    <td className="mono">{o.orderNumber || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

function OrderDetail({ order: o, busy, onBack, run }: { order: Order; busy: boolean; onBack: () => void; run: (label: string, fn: () => Promise<Order | void>) => Promise<void> }) {
  const [f, setF] = useState({ quoted: o.vendor.quotedTotal?.toString() ?? "", orderNumber: o.vendor.orderNumber, orderUrl: o.vendor.orderUrl, carrier: o.tracking.carrier, tracking: o.tracking.number, trackingUrl: o.tracking.url, shipMethod: o.quote.shipping.method, shipAmount: o.quote.shipping.amount?.toString() ?? "", taxPct: o.quote.tax.ratePct?.toString() ?? "" })
  const [force, setForce] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const fields = () => ({
    vendor: { quotedTotal: numOrNull(f.quoted), orderNumber: f.orderNumber, orderUrl: f.orderUrl },
    tracking: { carrier: f.carrier, number: f.tracking, url: f.trackingUrl },
    shipping: { method: f.shipMethod, amount: numOrNull(f.shipAmount) }, tax: { ratePct: numOrNull(f.taxPct) },
  })
  const save = (status?: OrderStatus) => run("Saving…", () => orderApi.update(o.design, o.id, { ...fields(), status, force: force || undefined }))
  const open = o.status === "draft" || o.status === "quoted"
  const next = NEXT[o.status]
  const q = o.quote
  const gateBlocks = !o.preflight.ok || o.stale
  const warnings = o.preflight.gates.filter((g) => g.level === "warn").length

  return (
    <div className="order-detail">
      <div className="row">
        <button className="btn sm ghost" onClick={onBack}>← All orders</button>
        <b>{o.design} rev {o.revision}</b><span className="mono small">× {o.qty}</span>
        <span className={`order-status s-${o.status}`}>{LABEL[o.status]}</span>
        <span className="muted small">created {day(o.createdAt)}{o.git.commit && <> · commit <span className="mono">{o.git.commit.slice(0, 7)}</span>{o.git.dirty && " + uncommitted changes"}</>}</span>
      </div>

      {o.stale && open && (
        <div className="order-note warn">The design changed after this package was built.
          <button className="btn sm" disabled={busy} onClick={() => run("Rebuilding the package…", () => orderApi.refresh(o.design, o.id))}>Rebuild package</button>
        </div>
      )}

      <section>
        <h4>Pre-flight {o.preflight.ok ? (warnings ? <span className="small" style={{ color: "var(--warn)" }}>no blockers, {warnings} to check</span> : <span className="small" style={{ color: "var(--good)" }}>ready to order</span>) :<span className="small" style={{ color: "var(--bad)" }}>blocked</span>}</h4>
        <ul className="checks">
          {o.preflight.gates.map((g, i) => (
            <li key={i}><span className={`dot ${g.level === "pass" ? "good" : g.level === "warn" ? "warn" : "bad"}`} /><span>{g.text}{g.refs?.length ? <span className="mono small muted"> {g.refs.slice(0, 12).join(", ")}{g.refs.length > 12 ? ` +${g.refs.length - 12}` : ""}</span> : null}</span></li>
          ))}
        </ul>
        {o.preflight.stock.filter((l) => l.state === "short").map((l) => (
          <div key={l.lcsc} className="order-note">
            <span><span className="mono">{l.lcsc}</span> ({l.refs.join(", ")}): {l.stock} in stock, {l.needed} needed.</span>
            {l.alternates.length ? <span> In-stock matches: {l.alternates.map((a) => <span key={a.lcsc} className="mono" title={`${a.mfr} ${a.description}`}> {a.lcsc}{a.basic ? " (Basic)" : ""} ${a.unitPrice}</span>)}. Check the datasheet before swapping.</span> : <span className="muted"> {l.note}</span>}
          </div>
        ))}
        {open && <button className="btn sm" disabled={busy} onClick={() => run("Rebuilding and re-checking…", () => orderApi.refresh(o.design, o.id))}>Re-check stock and rebuild</button>}
      </section>

      <section>
        <h4>Estimate <span className="order-tag">{q.label}</span></h4>
        <table className="quote-table">
          <tbody>
            <tr><td>Parts</td><td className="r mono">{money(q.parts)}</td></tr>
            <tr><td>Extended-part fees</td><td className="r mono">{money(q.extendedFees)}</td></tr>
            <tr><td>PCB fabrication <span className="muted small">est.</span></td><td className="r mono">{money(q.fab)}</td></tr>
            <tr><td>Assembly <span className="muted small">est.</span></td><td className="r mono">{money(q.assembly)}</td></tr>
            <tr><td>Shipping {q.shipping.method && <span className="muted small">{q.shipping.method}</span>}</td><td className="r mono">{money(q.shipping.amount)}</td></tr>
            <tr><td>Tax {q.tax.ratePct !== null && <span className="muted small">{q.tax.ratePct}%</span>}</td><td className="r mono">{money(q.tax.amount)}</td></tr>
            <tr className="total"><td>Estimated total{!q.complete && <span className="muted small"> without {[q.shipping.amount === null && "shipping", q.tax.amount === null && "tax"].filter(Boolean).join(" and ")}</span>}</td><td className="r mono">{money(q.total)}</td></tr>
            {o.vendor.quotedTotal !== null && <tr className="total"><td>{o.vendor.name} quote</td><td className="r mono">{money(o.vendor.quotedTotal, o.vendor.currency)}</td></tr>}
          </tbody>
        </table>
        {q.unpricedParts > 0 && <div className="small" style={{ color: "var(--warn)" }}>{q.unpricedParts} BOM line(s) have no price and are not in the total.</div>}
        <div className="order-form compact">
          <label>Shipping method<input value={f.shipMethod} onChange={set("shipMethod")} /></label>
          <label>Shipping (USD)<input type="number" min={0} step={0.01} value={f.shipAmount} onChange={set("shipAmount")} /></label>
          <label>Tax (%)<input type="number" min={0} step={0.1} value={f.taxPct} onChange={set("taxPct")} /></label>
        </div>
      </section>

      <section>
        <h4>Package <span className="muted small mono" title={o.package.sha256}>{o.package.sha256.slice(0, 12)}</span></h4>
        <div className="small">{o.board.layers} layers, {o.board.widthMm} × {o.board.heightMm} mm, {o.options.thicknessMm} mm, {o.options.colour}, {o.options.finish}, assembly: {o.options.assembly}.
          {o.options.assembly !== "none" && <> Rotations: {o.package.cpl.verified + o.package.cpl.override} of {o.package.cpl.total} matched to JLCPCB's footprints.</>}</div>
        {o.packageOnDisk ? (
          <div className="row wrap">
            <a className="btn sm primary" href={orderApi.packageUrl(o.design, o.id)} download={o.package.file}>Download zip</a>
            {o.package.files.filter((x) => /\.(csv|txt)$/.test(x.name)).map((x) => <a key={x.name} className="btn sm" href={orderApi.packageUrl(o.design, o.id, x.name)} download={x.name}>{x.name}</a>)}
            <span className="muted small">{o.package.files.length} files</span>
          </div>
        ) : <div className="small muted">The zip is no longer in the local cache. {open ? "Rebuild the package to get it back." : "The record keeps its hash."}</div>}
      </section>

      <section>
        <h4>At the manufacturer</h4>
        <div className="small muted">You upload, review the placement preview and pay on their site. Record what they give you here.</div>
        <div className="order-form compact">
          <label>Quoted total ({o.vendor.currency})<input type="number" min={0} step={0.01} value={f.quoted} onChange={set("quoted")} /></label>
          <label>Order number<input value={f.orderNumber} onChange={set("orderNumber")} /></label>
          <label className="wide">Order link (https)<input value={f.orderUrl} onChange={set("orderUrl")} placeholder="https://" /></label>
          <label>Carrier<input value={f.carrier} onChange={set("carrier")} /></label>
          <label>Tracking number<input value={f.tracking} onChange={set("tracking")} /></label>
          <label className="wide">Tracking link (https)<input value={f.trackingUrl} onChange={set("trackingUrl")} placeholder="https://" /></label>
        </div>
        {o.status === "quoted" && gateBlocks && (
          <label className="small row"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> I ordered this package anyway ({!o.preflight.ok ? "pre-flight is blocked" : "the design has changed since"})</label>
        )}
        <div className="row wrap">
          <a className="small" href="https://cart.jlcpcb.com/quote" target="_blank" rel="noreferrer">Open JLCPCB quote page ↗</a>
          {o.vendor.orderUrl && <a className="small" href={o.vendor.orderUrl} target="_blank" rel="noreferrer">Order page ↗</a>}
          {o.tracking.url && <a className="small" href={o.tracking.url} target="_blank" rel="noreferrer">Tracking ↗</a>}
          <div style={{ flex: 1 }} />
          {o.status !== "delivered" && o.status !== "cancelled" && <button className="btn sm ghost" disabled={busy} onClick={() => save("cancelled")}>Cancel order</button>}
          {(o.status === "draft" || o.status === "cancelled") && <button className="btn sm ghost" disabled={busy} onClick={() => run("Deleting…", async () => { await orderApi.remove(o.design, o.id); onBack() })}>Delete</button>}
          <button className="btn sm" disabled={busy} onClick={() => save()}>Save</button>
          {next && <button className="btn sm primary" disabled={busy} onClick={() => save(next.to)}>{next.label}</button>}
        </div>
      </section>

      <section>
        <h4>History</h4>
        <ul className="order-history small">{o.history.map((h, i) => <li key={i}><span className="muted">{day(h.at)}</span> {LABEL[h.status]}{h.note && ` · ${h.note}`}</li>)}</ul>
      </section>
    </div>
  )
}
