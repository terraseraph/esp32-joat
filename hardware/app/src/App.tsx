import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type GitStatus } from "./api"
import { ToastProvider } from "./toast"
import DesignList from "./DesignList"
import Workspace from "./Workspace"
import GitControl from "./GitControl"
import Overview from "./Overview"
import Settings from "./Settings"
import { BoardOrder, OrdersAll } from "./OrdersPage"
import { link, needs, useBoards, useRoute, type Route } from "./boards"
import { Icon, StatusChip } from "./ui"

function useTheme() {
  const [theme, setTheme] = useState<string | null>(() => {
    try { return localStorage.getItem("theme") } catch { return null }
  })
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try { theme ? localStorage.setItem("theme", theme) : localStorage.removeItem("theme") } catch {}
  }, [theme])
  const current: "light" | "dark" = theme === "light" || theme === "dark" ? theme : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  const toggle = () => setTheme(current === "dark" ? "light" : "dark")
  return { toggle, current }
}

const SECTION: Record<Route["page"], string> = { projects: "Projects", orders: "Orders", settings: "Settings", board: "Overview", design: "Workspace", order: "Order" }

function NavItem({ href, on, icon, label, badge }: { href: string; on: boolean; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <li>
      <a href={href} className={`nav-item ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} title={label}>
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
        {!!badge && <span className="nav-badge" aria-label={`${badge} need attention`}>{badge}</span>}
      </a>
    </li>
  )
}

export default function App() {
  const route = useRoute()
  const [git, setGit] = useState<GitStatus | null>(null)
  const { toggle, current } = useTheme()
  const { boards, err, reload } = useBoards()
  const name = "name" in route ? route.name : null

  const refreshGit = useCallback(() => {
    api.gitStatus().then(setGit).catch(() => setGit(null))
  }, [])
  useEffect(() => {
    refreshGit()
    const t = setInterval(refreshGit, 10000)
    return () => clearInterval(t)
  }, [refreshGit])
  // the workspace loads its own data; every other page reads the derived board list, so refresh it when you arrive
  useEffect(() => { if (route.page !== "design") reload() }, [route.page, name, reload])

  const board = name ? boards?.find((b) => b.name === name) : undefined
  const attention = boards ? needs(boards).filter((n) => n.tone !== "info").length : 0

  let page: React.ReactNode
  if (route.page === "design") page = <Workspace name={route.name} initialPanel={route.panel ?? null} onSaved={refreshGit} />
  else if (route.page === "settings") page = <Settings theme={current} toggleTheme={toggle} />
  else if (route.page === "orders") page = <OrdersAll boards={boards} />
  else if (route.page === "board" || route.page === "order") {
    if (!boards && !err) page = <div className="empty">Loading…</div>
    else if (!board) page = <div className="empty err">{err ? `Could not reach the API: ${err}` : `No board called "${route.name}".`} <a href={link.projects()}>Back to projects</a></div>
    else page = route.page === "board" ? <Overview board={board} /> : <BoardOrder board={board} />
  } else page = <DesignList boards={boards} err={err} reload={reload} git={git} />

  return (
    <ToastProvider>
      <div className={`shell ${route.page === "design" ? "compact" : ""}`}>
        <nav className="sidebar" aria-label="Main">
          <a className="brand" href={link.projects()}>
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
              <rect width="32" height="32" rx="7" fill="var(--accent)" />
              <path d="M8 16h6l3-6 3 12 3-6h3" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="nav-label">Joat Hardware</span>
          </a>
          <ul className="nav-list">
            <NavItem href={link.projects()} on={route.page === "projects"} icon={Icon.projects} label="Projects" badge={attention} />
            {name && (
              <li className="nav-board">
                <div className="nav-board-name mono nav-label" title={name}>{name}</div>
                <ul>
                  <NavItem href={link.board(name)} on={route.page === "board"} icon={Icon.overview} label="Overview" />
                  <NavItem href={link.design(name)} on={route.page === "design"} icon={Icon.workspace} label="Workspace" />
                  <NavItem href={link.order(name)} on={route.page === "order"} icon={Icon.order} label="Order" />
                </ul>
              </li>
            )}
            <NavItem href={link.orders()} on={route.page === "orders"} icon={Icon.orders} label="Orders" />
          </ul>
          <div className="grow" />
          <ul className="nav-list">
            <NavItem href={link.settings()} on={route.page === "settings"} icon={Icon.settings} label="Settings" />
          </ul>
        </nav>
        <div className="shell-main">
          <header className="topbar">
            <nav className="crumbs" aria-label="Breadcrumb">
              <a href={link.projects()}>Projects</a>
              {name && <><span aria-hidden>/</span><a className="mono" href={link.board(name)}>{name}</a></>}
              {route.page !== "projects" && <><span aria-hidden>/</span><span className="crumb-now">{SECTION[route.page]}</span></>}
            </nav>
            {board && name && <StatusChip status={board.status} />}
            <div className="grow" />
            <GitControl git={git} design={name} onChange={refreshGit} />
            <button className="icon-btn" onClick={toggle} title="Toggle theme" aria-label="Toggle theme">{Icon.sun}</button>
          </header>
          <main className="main">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${route.page}:${name ?? ""}`}
                className="page"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {page}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
