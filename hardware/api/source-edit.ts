/**
 * Source rewriting for design files: find the JSX element with a given `name` prop and read or
 * update its props, using the TypeScript compiler AST (never regex on code). Edits are spliced
 * into the original text so formatting and comments elsewhere are untouched.
 */
import ts from "typescript"

export type PropValue = string | number | boolean | null // null removes the prop

export type ComponentInfo = {
  name: string
  tag: string
  /** Props that are plain literals, rendered as strings/numbers; other props are listed in `dynamic`. */
  props: Record<string, string | number | boolean>
  /** Props whose value is an expression (e.g. `x`, `COLS[i]`). Shown read-only. */
  dynamic: string[]
  /** True when the element sits inside a callback such as `.map()`, so one line makes many parts. */
  inLoop: boolean
  line: number
}

const parse = (src: string) => ts.createSourceFile("index.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

type El = ts.JsxSelfClosingElement | ts.JsxOpeningElement

function attrName(a: ts.JsxAttribute): string {
  return ts.isIdentifier(a.name) ? a.name.text : a.name.getText()
}

function literalOf(init: ts.JsxAttribute["initializer"]): string | number | boolean | undefined {
  if (!init) return true
  if (ts.isStringLiteral(init)) return init.text
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression
    if (ts.isStringLiteralLike(e)) return e.text
    if (ts.isNumericLiteral(e)) return Number(e.text)
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text)
    if (e.kind === ts.SyntaxKind.TrueKeyword) return true
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false
  }
  return undefined
}

function elements(sf: ts.SourceFile): El[] {
  const out: El[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n)) out.push(n)
    else if (ts.isJsxOpeningElement(n)) out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function inLoop(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const call = p.parent
      if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return true
    }
  }
  return false
}

function nameOf(el: El): string | null {
  for (const a of el.attributes.properties) {
    if (ts.isJsxAttribute(a) && attrName(a) === "name") {
      const v = literalOf(a.initializer)
      return typeof v === "string" ? v : null
    }
  }
  return null
}

/** All elements in a source file that carry a literal `name` prop. */
export function listComponents(src: string): ComponentInfo[] {
  const sf = parse(src)
  const out: ComponentInfo[] = []
  for (const el of elements(sf)) {
    const name = nameOf(el)
    if (name === null) continue
    const props: ComponentInfo["props"] = {}
    const dynamic: string[] = []
    for (const a of el.attributes.properties) {
      if (!ts.isJsxAttribute(a)) continue
      const k = attrName(a)
      const v = literalOf(a.initializer)
      if (v === undefined) dynamic.push(k)
      else props[k] = v
    }
    // `supplierPartNumbers={{ jlcpcb: ["C123"] }}` is surfaced as an `lcsc` prop.
    const lcsc = readLcsc(el)
    if (lcsc) props.lcsc = lcsc
    out.push({
      name,
      tag: el.tagName.getText(),
      props,
      dynamic: lcsc ? dynamic.filter((d) => d !== "supplierPartNumbers") : dynamic,
      inLoop: inLoop(el),
      line: sf.getLineAndCharacterOfPosition(el.getStart()).line + 1,
    })
  }
  return out
}

function readLcsc(el: El): string | null {
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a) || attrName(a) !== "supplierPartNumbers") continue
    const init = a.initializer
    if (!init || !ts.isJsxExpression(init) || !init.expression || !ts.isObjectLiteralExpression(init.expression)) return null
    for (const p of init.expression.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "jlcpcb" && ts.isArrayLiteralExpression(p.initializer)) {
        const first = p.initializer.elements[0]
        if (first && ts.isStringLiteralLike(first)) return first.text
      }
    }
  }
  return null
}

const IDENT_RE = /^[A-Za-z_$][\w$-]*$/

function render(key: string, v: string | number | boolean): string {
  if (key === "lcsc") return `supplierPartNumbers={{ jlcpcb: [${JSON.stringify(String(v))}] }}`
  // JSX attribute strings have no escapes, so anything with a quote, backslash or newline goes in braces
  if (typeof v === "string") return /["\\\n\r]/.test(v) ?`${key}={${JSON.stringify(v)}}` : `${key}="${v}"`
  if (v === true) return key
  return `${key}={${v}}`
}

export class EditError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

/** Round to 3 decimals so drag/snap results stay tidy in the source. */
const tidy = (v: PropValue) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v)

/**
 * Apply `changes` to the element named `component`. Returns the new source.
 * Throws EditError (404 not found, 409 ambiguous/not editable) when it cannot do so safely.
 */
export type PatchResult = { content: string; warnings: string[] }

/** Number value of a literal prop on the element (also "90deg"-style strings), or undefined. */
function numericProp(el: El, key: string): number | undefined {
  for (const a of el.attributes.properties) {
    if (ts.isJsxAttribute(a) && attrName(a) === key) {
      const v = literalOf(a.initializer)
      if (typeof v === "number") return v
      if (typeof v === "string" && /^-?\d+(\.\d+)?(deg)?$/.test(v.trim())) return parseFloat(v)
    }
  }
  return undefined
}

/**
 * Like patchComponent, plus `deltas`: numeric props moved relative to their literal value in THIS text
 * (so repeated nudges/rotations never act on a stale value). pcbX/pcbY need a literal number already;
 * pcbRotation counts a missing prop as 0 and is wrapped to 0..359.
 */
export function patchComponent(src: string, component: string, changes: Record<string, PropValue>, deltas: Record<string, number> = {}): PatchResult {
  const sf0 = parse(src)
  const el0 = elements(sf0).filter((e) => nameOf(e) === component)
  if (el0.length === 1 && Object.keys(deltas).length) {
    changes = { ...changes }
    for (const [k, d] of Object.entries(deltas)) {
      if (!Number.isFinite(d)) throw new EditError(`bad delta for ${k}`)
      const cur = numericProp(el0[0], k)
      if (cur === undefined && k !== "pcbRotation") throw new EditError(`"${component}" has no literal ${k}; it is positioned by something else, edit it in the code`, 409)
      const next = (cur ?? 0) + d
      changes[k] = k === "pcbRotation" ? ((next % 360) + 360) % 360 : next
    }
  }
  return patchComponentAbs(src, component, changes)
}

function patchComponentAbs(src: string, component: string, changes: Record<string, PropValue>): PatchResult {
  const sf = parse(src)
  const matches = elements(sf).filter((el) => nameOf(el) === component)
  if (matches.length === 0) throw new EditError(`No element with name="${component}" in this file`, 404)
  if (matches.length > 1) throw new EditError(`name="${component}" appears ${matches.length} times; cannot pick one`, 409)
  const el = matches[0]
  if (inLoop(el)) throw new EditError(`"${component}" is created inside a loop; edit the loop in the code`, 409)

  type Edit = { start: number; end: number; text: string }
  const edits: Edit[] = []
  const attrs = el.attributes.properties.filter(ts.isJsxAttribute)
  const lastAny = el.attributes.properties[el.attributes.properties.length - 1] // may be a {...spread}
  const appended: string[] = []

  for (const [rawKey, raw] of Object.entries(changes)) {
    if (!IDENT_RE.test(rawKey)) throw new EditError(`bad prop name: ${rawKey}`)
    const value = tidy(raw)
    const realKey = rawKey === "lcsc" ? "supplierPartNumbers" : rawKey
    const existing = attrs.find((a) => attrName(a) === realKey)
    if (existing && existing.initializer && literalOf(existing.initializer) === undefined && rawKey !== "lcsc") {
      throw new EditError(`"${rawKey}" on "${component}" is an expression; edit it in the code`, 409)
    }
    if (rawKey === "lcsc" && existing && readLcsc(el) === null && value !== null)
      throw new EditError(`supplierPartNumbers on "${component}" is not a simple jlcpcb list; edit it in the code`, 409)
    if (value === null) {
      if (existing) edits.push({ start: existing.getFullStart(), end: existing.getEnd(), text: "" })
    } else if (existing) {
      edits.push({ start: existing.getStart(), end: existing.getEnd(), text: render(rawKey, value) })
    } else {
      appended.push(render(rawKey, value))
    }
  }

  if (appended.length) {
    const last = lastAny
    const multiline = last && sf.getLineAndCharacterOfPosition(last.getStart()).line !== sf.getLineAndCharacterOfPosition(el.tagName.getStart()).line
    if (last) {
      let sep = " "
      if (multiline) {
        const ls = sf.getLineAndCharacterOfPosition(last.getStart())
        const lineStart = sf.getPositionOfLineAndCharacter(ls.line, 0)
        sep = "\n" + src.slice(lineStart, last.getStart()).match(/^\s*/)![0]
      }
      edits.push({ start: last.getEnd(), end: last.getEnd(), text: sep + appended.join(sep) })
    } else {
      edits.push({ start: el.tagName.getEnd(), end: el.tagName.getEnd(), text: " " + appended.join(" ") })
    }
  }

  // A rename also fixes selectors that reference the old name, like ".R1 > .pin1".
  const newName = changes.name
  if (typeof newName === "string" && newName !== component) {
    if (!/^[A-Za-z_][\w-]*$/.test(newName)) throw new EditError(`invalid name: ${newName}`)
    if (elements(sf).some((e) => nameOf(e) === newName)) throw new EditError(`name "${newName}" is already used`, 409)
    const re = new RegExp(`(?<![\\w])\\.${component.replace(/[$]/g, "\\$&")}(?![\\w-])`, "g")
    const nameAttr = attrs.find((a) => attrName(a) === "name")
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n) && n.parent !== nameAttr && re.test(n.text)) {
        re.lastIndex = 0
        const q = src[n.getStart()]
        edits.push({ start: n.getStart() + 1, end: n.getEnd() - 1, text: src.slice(n.getStart() + 1, n.getEnd() - 1).replace(re, `.${newName}`) })
        void q
      }
      re.lastIndex = 0
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }

  edits.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  const warnings: string[] = []
  if (typeof newName === "string" && newName !== component) {
    const left = countNameRefs(out, component)
    if (left) warnings.push(`${left} other string reference(s) to "${component}" remain in this file (e.g. sel.${component}); check them in the code`)
  }
  return { content: out, warnings }
}

/** String/template literals that still mention `name` as a whole word (".R1", "sel.R1", "R1 > pin"). */
export function countNameRefs(src: string, name: string): number {
  const re = new RegExp(`(?<![\\w$-])${name.replace(/[$]/g, "\\$&")}(?![\\w$-])`)
  let n = 0
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && re.test(node.text) && !(node.parent && ts.isJsxAttribute(node.parent) && attrName(node.parent) === "name")) n++
    ts.forEachChild(node, visit)
  }
  visit(parse(src))
  return n
}
