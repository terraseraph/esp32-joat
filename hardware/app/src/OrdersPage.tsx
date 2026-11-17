import { useEffect, useState } from "react"
import { orderApi, type OrderStatus, type OrderSummary } from "./api"
import { ago, link, type Board } from "./boards"
import { Stepper } from "./ui"
import OrdersPanel from "./OrdersPanel"

export const ORDER_STEPS = ["Pre-flight", "BOM & stock", "Quote", "Shipping", "Place order", "Track"] as const
const PLACED: OrderStatus[] = ["submitted", "in_fab", "shipped", "delivered"]
const LABEL: Record<OrderStatus, string> = { draft: "Draft", quoted: "Quoted", submitted: "Ordered", in_fab: "In fab", shipped: "Shipped", delivered: "Delivered", cancelled: "Cancelled" }

/** Which pipeline steps are finished, from the board's state and its latest order. */
function stepsDone(board: Board | undefined, o: OrderSummary | undefined): boolean[] {
  const ok = !!o || (!!board && ["ready", "ordered", "delivered"].includes(board.status))
  const quoted = !!o && (o.status === "quoted" || PLACED.includes(o.status))
  const placed = !!o && PLACED.includes(o.status)
  return [ok, !!o, quoted, quoted, placed, o?.status === "delivered"]
}
const NOTES = ["Build, checks and review items", "Package and stock check", "Vendor quote entered", "Shipping and tax entered", "Order number recorded", "Tracking until delivered"]

/** Pipeline for one board, with the existing order panel (package, pre-flight, quote, tracking) underneath. */
export function BoardOrder({ board }: { board: Board }) {
  const o = board.active
  const done = stepsDone(board, o)
  const blocked = !done[0]
  return (
    <div className="page-wrap">
      <div className="page-head">
        <div>
          <h1>Order {board.d.meta?.name || board.name}</h1>
          <p className="muted">Build the order package, record the vendor quote and order, then follow it to delivery.</p>
        </div>
        <a className="btn" href={link.board(board.name)}>Back to overview</a>
      </div>
      <section className="panel-card">
        <Stepper steps={ORDER_STEPS} done={done} note={(i) => (done.findIndex((d) => !d) === i ? NOTES[i] : undefined)} />
        <p className="muted small pipeline-note">Orders are recorded by hand for now: this app prepares the package and the numbers, you place the order on the vendor's site and enter the order number here.</p>
      </section>
      {blocked && (
        <section className="callout warn">
          <b>Before you order:</b> {board.status === "failing" ? `${board.errors} design-rule error${board.errors === 1 ? "" : "s"} to fix` : board.status === "review" ? `${board.open} review item${board.open === 1 ? "" : "s"} still open` : "build the board once so it can be checked"}.
          <a className="link" href={board.status === "review" ? link.design(board.name, "review") : board.status === "failing" ? link.design(board.name, "problems") : link.design(board.name)}> Go and fix it</a>. You can still prepare a draft order below.
        </section>
      )}
      <section className="panel-card"><OrdersPanel name={board.name} qty={10} dirty={false} /></section>
    </div>
  )
}

/** Every order across every board. */
export function OrdersAll({ boards }: { boards: Board[] | null }) {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null)
  const [err, setErr] = useState("")
  useEffect(() => { orderApi.all().then((l) => setOrders([...l].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))).catch((e) => setErr(e.message)) }, [])
  const byName = new Map((boards ?? []).map((b) => [b.name, b]))
  return (
    <div className="page-wrap">
      <div className="page-head">
        <div><h1>Orders</h1><p className="muted">{orders ? `${orders.length} order${orders.length === 1 ? "" : "s"}` : " "}</p></div>
      </div>
      {err && <div className="empty err">{err}</div>}
      {!orders && !err && <div className="empty">Loading…</div>}
      {orders && orders.length === 0 && (
        <div className="empty-card">
          <p><b>No orders yet.</b></p>
          <p className="muted">Open a board that is ready to order and start a draft from its Order page.</p>
          <a className="btn primary" href={link.projects()}>Go to projects</a>
        </div>
      )}
      <div className="order-list">
        {orders?.map((o) => {
          const done = stepsDone(byName.get(o.design), o)
          return (
            <a key={o.id} className="order-row" href={link.order(o.design)}>
              <div className="order-main">
                <b className="mono">{o.design}</b> <span className="chip">rev {o.revision}</span> <span className={`chip st-${o.status}`}>{LABEL[o.status]}</span>
                <div className="muted small">{o.qty} boards · ${o.total.toFixed(2)}{o.estimate ? " estimate" : ""}{o.orderNumber ? ` · #${o.orderNumber}` : ""}{o.tracking ? ` · ${o.tracking}` : ""}</div>
              </div>
              <div className="mini-steps" aria-label={`${done.filter(Boolean).length} of ${ORDER_STEPS.length} steps done`}>
                {ORDER_STEPS.map((s, i) => <span key={s} title={s} className={done[i] ? "done" : i === done.findIndex((d) => !d) ? "now" : ""} />)}
              </div>
              <span className="muted small order-when">{ago(Date.parse(o.updatedAt))}</span>
            </a>
          )
        })}
      </div>
    </div>
  )
}
