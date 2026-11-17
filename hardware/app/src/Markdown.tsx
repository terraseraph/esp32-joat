import { useMemo } from "react"
import { Marked } from "marked"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const safeHref = (h: string) => /^(https?:|mailto:|#)/i.test(h.trim())

// Model output is untrusted. marked already escapes text and code; these hooks also neutralise raw HTML, images and
// non-web links, so the result can be shown with dangerouslySetInnerHTML.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) { return esc(text) },
    image({ text }) { return esc(text) },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens)
      return safeHref(href) ? `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} target="_blank" rel="noopener noreferrer">${inner}</a>` : inner
    },
  },
})

/** An assistant reply: headings, lists, tables, code and links rendered, never raw HTML. */
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    try { return md.parse(text, { async: false }) as string } catch { return `<p>${esc(text)}</p>` }
  }, [text])
  return <div className="ai-message md" dangerouslySetInnerHTML={{ __html: html }} />
}
