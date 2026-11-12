// Source edits for "connect without typing net names": add/change a pin's net in index.tsx,
// rename a net, and read/assign the ESP32-S3 module GPIO map. Pure string -> string functions
// (TypeScript AST positions), so the same code serves the UI and Claude via the API.
import ts from "typescript"
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./build.js"
import type { PinRef } from "../shared/nets.js"

const parse = (src: string) => ts.createSourceFile("index.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const isId = (s: string) => /^[A-Za-z_$][\w$]*$/.test(s)
const esc = (s: string) => s.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")
export const normNet = (n: string) => (n.startsWith("net.") ? n : `net.${n}`)
const bareNet = (n: string) => n.replace(/^net\./, "")
export const NET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type Edit = { start: number; end: number; text: string }
const apply = (src: string, edits: Edit[]) =>
  [...edits].sort((a, b) => b.start - a.start).reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), src)

function* walk(n: ts.Node): Generator<ts.Node> {
  yield n
  for (const c of n.getChildren()) yield* walk(c)
}
const tagText = (el: ts.JsxOpeningLikeElement) => el.tagName.getText()
const attrs = (el: ts.JsxOpeningLikeElement) => el.attributes.properties.filter(ts.isJsxAttribute)
const attr = (el: ts.JsxOpeningLikeElement, n: string) => attrs(el).find((a) => a.name.getText() === n)
const strAttr = (a?: ts.JsxAttribute) => {
  const i = a?.initializer
  if (!i) return undefined
  if (ts.isStringLiteral(i)) return i.text
  if (ts.isJsxExpression(i) && i.expression && (ts.isStringLiteral(i.expression) || ts.isNoSubstitutionTemplateLiteral(i.expression))) return i.expression.text
  return undefined
}
function elements(sf: ts.SourceFile): ts.JsxOpeningLikeElement[] {
  const out: ts.JsxOpeningLikeElement[] = []
  for (const n of walk(sf)) if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) out.push(n)
  return out
}
const byName = (sf: ts.SourceFile, name: string) => elements(sf).find((e) => strAttr(attr(e, "name")) === name)
const keyText = (p: ts.ObjectLiteralElementLike) =>
  ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) ? p.name.text : undefined
function connObj(el: ts.JsxOpeningLikeElement): ts.ObjectLiteralExpression | undefined {
  const i = attr(el, "connections")?.initializer
  return i && ts.isJsxExpression(i) && i.expression && ts.isObjectLiteralExpression(i.expression) ? i.expression : undefined
}

/** Top-level `const X = "net.…"` constants, so `connections={{ IO8: GND }}` resolves. */
function constStrings(sf: ts.SourceFile): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of walk(sf))
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)))
      out[n.name.text] = n.initializer.text
  return out
}
const exprNet = (e: ts.Expression, consts: Record<string, string>): string | undefined =>
  ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : ts.isIdentifier(e) ? consts[e.text] : undefined

export type EditResult = { source: string; changed: boolean; how: string }

/** Set (or with net=null remove) the net of one pin, editing the component's `connections` prop,
 *  an existing `<trace from=".REF > .PIN" />`, or adding a new `<trace>` as a last resort. */
export function setPinNet(source: string, { ref, pin }: PinRef, net: string | null): EditResult {
  const sf = parse(source)
  const value = net === null ? null : normNet(net)
  const el = byName(sf, ref)
  const lit = value === null ? "" : JSON.stringify(value)
  const key = isId(pin) ? pin : JSON.stringify(pin)
  // an existing <trace from=".REF > .PIN"> for this pin wins over adding a second connection (that would short two nets)
  const sel = new RegExp(`^\\.${esc(ref)}\\s*>\\s*\\.${esc(pin)}$`)
  const tr = elements(sf).find((e) => tagText(e) === "trace" && sel.test((strAttr(attr(e, "from")) ?? "").trim()))
  if (el) {
    const obj = connObj(el)
    const inConn = obj?.properties.some((p) => keyText(p) === pin)
    if (obj && (inConn || !tr)) {
      const props = obj.properties
      const prop = props.find((p) => keyText(p) === pin)
      if (prop && ts.isPropertyAssignment(prop)) {
        if (value === null) {
          const idx = props.indexOf(prop)
          const next = props[idx + 1]
          if (next) return { source: apply(source, [{ start: prop.getStart(), end: next.getStart(), text: "" }]), changed: true, how: `removed ${ref}.${pin} from connections` }
          const from = idx > 0 ? props[idx - 1].end : prop.getStart()
          const end = props.hasTrailingComma ? prop.end + 1 : prop.end
          return { source: apply(source, [{ start: from, end, text: idx > 0 && props.hasTrailingComma ? "," : "" }]), changed: true, how: `removed ${ref}.${pin} from connections` }
        }
        if (prop.initializer.getText() === lit) return { source, changed: false, how: "already set" }
        return { source: apply(source, [{ start: prop.initializer.getStart(), end: prop.initializer.end, text: lit }]), changed: true, how: `changed ${ref}.${pin} in connections` }
      }
      if (value === null) return { source, changed: false, how: "pin was not connected here" }
      const entry = `${key}: ${lit}`
      const last = props[props.length - 1]
      if (!last) return { source: apply(source, [{ start: obj.getStart(), end: obj.end, text: `{ ${entry} }` }]), changed: true, how: `added ${ref}.${pin} to connections` }
      const multiline = source.slice(obj.getStart(), obj.end).includes("\n")
      const lineStart = source.lastIndexOf("\n", last.getStart()) + 1
      const indent = multiline ? source.slice(lineStart, last.getStart()) : " "
      if (props.hasTrailingComma) return { source: apply(source, [{ start: last.end + 1, end: last.end + 1, text: `${multiline ? "\n" + indent : " "}${entry},` }]), changed: true, how: `added ${ref}.${pin} to connections` }
      return { source: apply(source, [{ start: last.end, end: last.end, text: `,${multiline ? "\n" + indent : " "}${entry}` }]), changed: true, how: `added ${ref}.${pin} to connections` }
    }
    // primitives (lowercase tags) accept connections; capitalised lib blocks may not, so those use a trace
    if (value !== null && !tr && /^[a-z]/.test(tagText(el)) && !attr(el, "connections")) {
      const nameAttr = attr(el, "name")!
      return { source: apply(source, [{ start: nameAttr.end, end: nameAttr.end, text: ` connections={{ ${key}: ${lit} }}` }]), changed: true, how: `added connections to ${ref}` }
    }
  }
  if (tr) {
    const to = attr(tr, "to")!
    if (value === null) {
      const full = ts.isJsxSelfClosingElement(tr) ? tr : tr.parent
      const ls = source.lastIndexOf("\n", full.getStart()) + 1
      const le = source.indexOf("\n", full.end)
      return { source: apply(source, [{ start: ls, end: le < 0 ? full.end : le + 1, text: "" }]), changed: true, how: "removed trace" }
    }
    if (strAttr(to) === value) return { source, changed: false, how: "already set" }
    return { source: apply(source, [{ start: to.getStart(), end: to.end, text: `to=${JSON.stringify(value)}` }]), changed: true, how: `retargeted trace ${ref}.${pin}` }
  }
  if (value === null) return { source, changed: false, how: "pin was not connected in this file" }
  // new trace, inserted before the closing tag of the board/group
  const root = [...walk(sf)].find((n): n is ts.JsxElement => ts.isJsxElement(n) && ["board", "group", "subcircuit"].includes(tagText(n.openingElement)))
  if (!root) throw new Error("no <board> found to add a trace to")
  const closeAt = root.closingElement.getStart()
  const lineStart = source.lastIndexOf("\n", closeAt) + 1
  const closeIndent = source.slice(lineStart, closeAt)
  const ownLine = closeIndent.trim() === ""
  const text = `${ownLine ? closeIndent + "  " : "  "}<trace from=${JSON.stringify(`.${ref} > .${pin}`)} to=${JSON.stringify(value)} />\n`
  const at = ownLine ? lineStart : closeAt
  return { source: apply(source, [{ start: at, end: at, text }]), changed: true, how: `added <trace> for ${ref}.${pin}` }
}

/** Put `a` (and `b`) on one net. */
export function connectPins(source: string, a: PinRef, b: PinRef | undefined, net: string): EditResult {
  if (!NET_NAME_RE.test(bareNet(net))) throw new Error(`invalid net name "${net}" (letters, digits, underscore)`)
  let s = source
  const how: string[] = []
  let changed = false
  for (const p of b ? [a, b] : [a]) {
    const r = setPinNet(s, p, net)
    s = r.source
    changed ||= r.changed
    how.push(r.how)
  }
  return { source: s, changed, how: how.join("; ") }
}

export function renameNet(source: string, from: string, to: string): { source: string; count: number } {
  if (!NET_NAME_RE.test(bareNet(to))) throw new Error(`invalid net name "${to}"`)
  const sf = parse(source)
  const edits: Edit[] = []
  const f = normNet(from)
  for (const n of walk(sf))
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === f) edits.push({ start: n.getStart() + 1, end: n.end - 1, text: normNet(to) })
  return { source: apply(source, edits), count: edits.length }
}

/** Files in lib/ that mention a net literal (renaming in a design does not touch shared blocks). */
export function libMentions(net: string): string[] {
  const dir = path.join(ROOT, "lib")
  const re = new RegExp(`net\\.${esc(bareNet(net))}(?![A-Za-z0-9_])`)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".tsx") && re.test(fs.readFileSync(path.join(dir, n), "utf8"))) : []
}

// ---------------------------------------------------------------- ESP32-S3 GPIO map

type Level = "error" | "warn" | "info"
export type Note = { level: Level; text: string }
export type GpioRow = { pin: string; pinNumber: number; net: string | null; isDefault: boolean; notes: Note[] }
export type GpioMap = { component: string; rows: GpioRow[]; clashes: { level: Level; text: string; pins: string[] }[]; nets: string[] }

/** Pin list (pinN -> label) and default connections, read from lib/esp32-s3-module.tsx. */
export function moduleInfo(): { pins: { pinNumber: number; label: string }[]; defaults: Record<string, string> } {
  const src = fs.readFileSync(path.join(ROOT, "lib", "esp32-s3-module.tsx"), "utf8")
  const pins = [...src.matchAll(/pin(\d+):\s*"([^"]+)"/g)].map((m) => ({ pinNumber: +m[1], label: m[2] }))
  const defaults: Record<string, string> = {}
  for (const n of walk(parse(src)))
    if (ts.isObjectLiteralExpression(n) && n.properties.some(ts.isSpreadAssignment))
      for (const p of n.properties) {
        const k = keyText(p)
        if (k && ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) defaults[k] = p.initializer.text
      }
  return { pins, defaults }
}

const ioNum = (label: string) => {
  const m = /^IO(\d+)$/.exec(label)
  return m ? +m[1] : null
}
/** What each IO means on the WROOM-1-N16R8 (octal PSRAM). Knowledge, not in the lib file. */
export function pinNotes(label: string): Note[] {
  const n = ioNum(label)
  const notes: Note[] = []
  if (n === null) {
    if (label === "RXD0" || label === "TXD0") notes.push({ level: "info", text: "UART0 console / flashing (IO44 RX, IO43 TX). Keep free for serial boot logs and programming." })
    if (label === "EN") notes.push({ level: "info", text: "Chip enable (reset). Needs an RC / button, not a GPIO." })
    return notes
  }
  if (n >= 35 && n <= 37) notes.push({ level: "error", text: "Used internally by the octal PSRAM on N16R8 modules. Leave unconnected." })
  if (n === 0) notes.push({ level: "warn", text: "Strapping pin: low at reset = download mode. Normally the BOOT button; do not drive hard." })
  if (n === 3) notes.push({ level: "warn", text: "Strapping pin: selects the JTAG signal source. Avoid loads that pull it at reset." })
  if (n === 45) notes.push({ level: "warn", text: "Strapping pin: sets the flash/PSRAM voltage (VDD_SPI). Must be low at reset on 3.3 V modules." })
  if (n === 46) notes.push({ level: "warn", text: "Strapping pin (ROM boot log) and input-only: cannot be an output." })
  if (n === 19 || n === 20) notes.push({ level: "warn", text: `Native USB ${n === 19 ? "D-" : "D+"}. Using it as GPIO disables USB serial/JTAG.` })
  if (n >= 39 && n <= 42) notes.push({ level: "info", text: "Default JTAG pins (MTCK/MTDO/MTDI/MTMS). Fine as GPIO if you do not need JTAG." })
  if (n >= 11 && n <= 20) notes.push({ level: "info", text: "ADC2 channel: ADC2 reads are unreliable while WiFi is active. Use IO1–IO10 (ADC1) for analog." })
  if (n >= 1 && n <= 10) notes.push({ level: "info", text: "ADC1 channel (usable with WiFi)." })
  if (n === 47 || n === 48) notes.push({ level: "info", text: "Free GPIO on N16R8 (IO48 drives the RGB LED on dev kits only)." })
  return notes
}

/** Current GPIO map for the first (or named) Esp32S3Module in the source. Source-only: no build needed. */
export function gpioMap(source: string, component?: string): GpioMap | null {
  const sf = parse(source)
  const el = elements(sf).find((e) => tagText(e) === "Esp32S3Module" && (!component || strAttr(attr(e, "name")) === component))
  if (!el) return null
  const consts = constStrings(sf)
  const set: Record<string, string> = {}
  for (const p of connObj(el)?.properties ?? []) {
    const k = keyText(p)
    if (k && ts.isPropertyAssignment(p)) {
      const v = exprNet(p.initializer, consts)
      if (v) set[k] = v
    }
  }
  const { pins, defaults } = moduleInfo()
  const rows: GpioRow[] = pins
    .filter((p) => !/^(GND2?|EPAD)$/.test(p.label))
    .map((p) => {
      const mine = set[p.label]
      return { pin: p.label, pinNumber: p.pinNumber, net: mine ?? defaults[p.label] ?? null, isDefault: !mine && !!defaults[p.label], notes: pinNotes(p.label) }
    })
  const clashes: GpioMap["clashes"] = []
  const used: Record<string, string[]> = {}
  for (const r of rows) if (r.net && ioNum(r.pin) !== null) (used[r.net] ??= []).push(r.pin)
  for (const [net, ps] of Object.entries(used))
    if (ps.length > 1) clashes.push({ level: "error", text: `${net} is on ${ps.length} IO pins (${ps.join(", ")}): the pins are shorted together.`, pins: ps })
  for (const r of rows) if (r.net && !r.isDefault) for (const n of r.notes) if (n.level === "error") clashes.push({ level: "error", text: `${r.pin}: ${n.text}`, pins: [r.pin] })
  const nets = [...new Set([...walk(sf)].filter((n): n is ts.StringLiteral => ts.isStringLiteral(n) && /^net\.[A-Za-z_]\w*$/.test(n.text)).map((n) => n.text))].sort()
  return { component: strAttr(attr(el, "name")) ?? "U?", rows, clashes, nets }
}

export function assignGpio(source: string, pin: string, net: string | null, component?: string): EditResult {
  const m = gpioMap(source, component)
  if (!m) throw new Error("no Esp32S3Module in this design")
  if (!moduleInfo().pins.some((p) => p.label === pin)) throw new Error(`unknown module pin "${pin}"`)
  return setPinNet(source, { ref: m.component, pin }, net)
}
