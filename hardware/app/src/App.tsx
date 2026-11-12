import { useCallback, useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { api, type GitStatus } from "./api"
import { ToastProvider } from "./toast"
import DesignList from "./DesignList"
import Workspace from "./Workspace"
import GitControl from "./GitControl"

const isDesignRoute = () => /^#\/?design\//.test(location.hash)
const readHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, "").split("/")[1] ?? "") || null
const readRoute = () => (isDesignRoute() ? readHash() : null)

function useTheme() {
  const [theme, setTheme] = useState<string | null>(() => {
    try { return localStorage.getItem("theme") } catch { return null }
  })
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
    try { theme ? localStorage.setItem("theme", theme) : localStorage.removeItem("theme") } catch {}
  }, [theme])
  const toggle = () => {
    const sysDark = matchMedia("(prefers-color-scheme: dark)").matches
    const cur = theme ?? (sysDark ? "dark" : "light")
    setTheme(cur === "dark" ? "light" : "dark")
  }
  return { toggle }
}

export default function App() {
  const [design, setDesign] = useState<string | null>(readRoute)
  const [git, setGit] = useState<GitStatus | null>(null)
  const { toggle } = useTheme()

  useEffect(() => {
    const on = () => setDesign(readRoute())
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])

  const refreshGit = useCallback(() => {
    api.gitStatus().then(setGit).catch(() => setGit(null))
  }, [])
  useEffect(() => {
    refreshGit()
    const t = setInterval(refreshGit, 10000)
    return () => clearInterval(t)
  }, [refreshGit])

  return (
    <ToastProvider>
      <div className="app">
        <header className="topbar">
          <a className="brand" href="#/">
            <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
              <rect width="32" height="32" rx="7" fill="var(--accent)" />
              <path d="M8 16h6l3-6 3 12 3-6h3" stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Joat Hardware</span>
          </a>
          {design && <span className="crumb">/ {design}</span>}
          <div className="grow" />
          <GitControl git={git} design={design} onChange={refreshGit} />
          <button className="icon-btn" onClick={toggle} title="Toggle theme" aria-label="Toggle theme">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </button>
        </header>
        <main className="main">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={design ?? "__list"}
              className="page"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {design ? <Workspace name={design} onSaved={refreshGit} /> : <DesignList git={git} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </ToastProvider>
  )
}
