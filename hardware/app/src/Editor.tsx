import { useEffect, useState } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { EditorView } from "@codemirror/view"
import { motion } from "motion/react"

function useIsDark() {
  const get = () => {
    const t = document.documentElement.dataset.theme
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  }
  const [dark, setDark] = useState(get)
  useEffect(() => {
    const update = () => setDark(get())
    const mq = matchMedia("(prefers-color-scheme: dark)")
    mq.addEventListener("change", update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => { mq.removeEventListener("change", update); mo.disconnect() }
  }, [])
  return dark
}

const base = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted)" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  "&.cm-focused": { outline: "none" },
})

export default function Editor({ files, saved, active, setActive, onChange }: {
  files: Record<string, string>
  saved: Record<string, string>
  active: string
  setActive: (k: string) => void
  onChange: (k: string, v: string) => void
}) {
  const dark = useIsDark()
  const names = Object.keys(files)
  const ext = active.endsWith(".json") ? json() : javascript({ jsx: true, typescript: true })
  return (
    <div className="editor">
      <div className="tabs">
        {names.map((k) => (
          <button key={k} className={`tab ${k === active ? "on" : ""}`} onClick={() => setActive(k)}>
            {k === active && <motion.span layoutId="filetab" className="tab-bg" transition={{ type: "spring", visualDuration: 0.2, bounce: 0 }} />}
            <span className="tab-label mono">
              {k}
              {files[k] !== saved[k] && <span className="unsaved" title="Unsaved changes" />}
            </span>
          </button>
        ))}
      </div>
      <div className="cm-wrap">
        <CodeMirror
          key={active}
          value={files[active] ?? ""}
          height="100%"
          theme={dark ? "dark" : "light"}
          extensions={[ext, base]}
          onChange={(v) => onChange(active, v)}
          basicSetup={{ foldGutter: false, highlightActiveLine: true }}
        />
      </div>
    </div>
  )
}
