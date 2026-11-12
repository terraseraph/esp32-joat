import fs from "node:fs"
import path from "node:path"

export type Template = "blank" | "expansion" | "base"
export type NewDesignOptions = {
  name: string
  template?: Template
  width?: number
  height?: number
  layers?: 2 | 4
  holes?: "none" | "m3-corners"
  description?: string
}

export const TEMPLATES: { id: Template; label: string; blurb: string; defaultSize: [number, number]; defaultLayers: 2 | 4 }[] = [
  { id: "blank", label: "Blank", blurb: "Empty board with one resistor to start from.", defaultSize: [50, 40], defaultLayers: 2 },
  { id: "expansion", label: "Expansion card", blurb: "1x6 expansion header + ID EEPROM, like relay-8.", defaultSize: [60, 40], defaultLayers: 2 },
  { id: "base", label: "Base controller", blurb: "ESP32-S3 module + 5 V to 3.3 V power.", defaultSize: [80, 60], defaultLayers: 4 },
]

export const SIZE_PRESETS = [
  { label: "50 × 40", w: 50, h: 40 },
  { label: "60 × 40", w: 60, h: 40 },
  { label: "80 × 60", w: 80, h: 60 },
  { label: "100 × 84", w: 100, h: 84 },
  { label: "120 × 90", w: 120, h: 90 },
]

const HOLE_INSET = 4

const num = (n: number) => String(Math.round(n * 100) / 100)

function body(t: Template, lib: (n: string) => boolean): { imports: string; pre: string; inner: string } {
  if (t === "expansion")
    return {
      imports: `import { ExpansionHeader } from "../../lib/expansion-header"\nimport { IdEeprom } from "../../lib/id-eeprom"\n`,
      pre: "",
      inner: `      <copperpour layer="bottom" connectsTo={GND} />

      <ExpansionHeader name="J_EXP" pcbX={-W / 2 + 4} pcbY={0} pcbRotation={90} schX={-14} schY={0} />
      <IdEeprom name="U2" pcbX={-W / 2 + 14} pcbY={0} schX={0} schY={0} />
      <capacitor name="C1" capacitance="100nF" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C14663"] }} pcbX={-W / 2 + 14} pcbY={7} schX={-6} schY={4} />

      <capacitor name="C2" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }} pcbX={-W / 2 + 14} pcbY={-7} schX={-6} schY={-4} />
      {/* INT is open-drain; fit R_INT only if the base board has no pull-up */}
      <resistor name="R_INT" resistance="10k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C25804"] }} pcbX={-W / 2 + 22} pcbY={7} schX={-10} schY={-7} />

      <trace from=".J_EXP > .V5" to="net.V5" />
      <trace from=".J_EXP > .V3_3" to="net.V3_3" />
      <trace from=".J_EXP > .GND" to={GND} />
      <trace from=".J_EXP > .SDA" to="net.SDA" />
      <trace from=".J_EXP > .SCL" to="net.SCL" />
      <trace from=".J_EXP > .INT" to="net.INT" />

      {/* ID EEPROM: address 0x50, write-protect off */}
      <trace from=".U2 > .VCC" to="net.V3_3" />
      <trace from=".U2 > .GND" to={GND} />
      <trace from=".U2 > .SDA" to="net.SDA" />
      <trace from=".U2 > .SCL" to="net.SCL" />
      <trace from=".U2 > .A0" to={GND} />
      <trace from=".U2 > .A1" to={GND} />
      <trace from=".U2 > .A2" to={GND} />
      <trace from=".U2 > .WP" to={GND} />
      <trace from=".C1 > .pin1" to="net.V3_3" />
      <trace from=".C1 > .pin2" to={GND} />
      <trace from=".C2 > .pin1" to="net.V5" />
      <trace from=".C2 > .pin2" to={GND} />
      <trace from=".R_INT > .pin1" to="net.V3_3" />
      <trace from=".R_INT > .pin2" to="net.INT" />

      {/* add your circuit here */}
`,
    }
  if (t === "base") {
    const hasLib = lib("esp32-s3-module")
    return {
      imports: hasLib ? `import { Esp32S3Module } from "../../lib/esp32-s3-module"\n` : "",
      pre: hasLib
        ? ""
        : `
// lib/esp32-s3-module.tsx is not in this checkout, so a bare module symbol is used.
// Replace with Esp32S3Module from lib once available.
const Esp32S3Module = ({ connections, ...props }: any) => (
  <chip
    {...props}
    footprint="jlcpcb:C2913202"
    manufacturerPartNumber="ESP32-S3-WROOM-1-N16R8"
    supplierPartNumbers={{ jlcpcb: ["C2913202"] }}
    pinLabels={{ pin1: "GND", pin2: "3V3", pin3: "EN", pin40: "GND2", pin41: "EPAD" }}
    pinAttributes={{ "3V3": { requiresPower: true }, GND: { requiresGround: true } }}
    connections={{ GND: "net.GND", GND2: "net.GND", EPAD: "net.GND", "3V3": "net.V3_3", ...connections }}
  />
)
`,
      inner: `      <copperpour layer="bottom" connectsTo={GND} />

      {/* 5 V in, AMS1117-3.3 linear regulator (SOT-223, C6186) */}
      <pinheader name="J_PWR" pinCount={2} pitch="2.54mm" gender="male" pinLabels={["V5", "GND"]}
        pcbX={-W / 2 + 5} pcbY={0} pcbRotation={90} supplierPartNumbers={{ jlcpcb: ["C2337"] }}
        connections={{ V5: "net.V5", GND }} />
      <chip name="U_REG" footprint="sot223" manufacturerPartNumber="AMS1117-3.3" supplierPartNumbers={{ jlcpcb: ["C6186"] }}
        pinLabels={{ pin1: "GND", pin2: "VOUT", pin3: "VIN" }}
        pinAttributes={{ GND: { requiresGround: true } }}
        pcbX={-W / 2 + 15} pcbY={0}
        connections={{ GND, VOUT: "net.V3_3", VIN: "net.V5" }} />
      <capacitor name="C_IN" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }} pcbX={-W / 2 + 15} pcbY={7} connections={{ pin1: "net.V5", pin2: GND }} />
      <capacitor name="C_OUT" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }} pcbX={-W / 2 + 15} pcbY={-7} connections={{ pin1: "net.V3_3", pin2: GND }} />

      <Esp32S3Module name="U1" pcbX={W / 4} pcbY={0} connections={{}} />

      {/* add your circuit here */}
`,
    }
  }
  return {
    imports: "",
    pre: "",
    inner: `      <resistor name="R1" resistance="10k" footprint="0402" pcbX={0} pcbY={0} />\n`,
  }
}

/** Generate index.tsx and board.json for a new design. Throws on bad options. */
export function renderTemplate(o: NewDesignOptions, rootDir: string) {
  const t: Template = o.template ?? "blank"
  const def = TEMPLATES.find((x) => x.id === t)
  if (!def) throw new Error(`unknown template: ${t}`)
  const w = o.width ?? def.defaultSize[0]
  const h = o.height ?? def.defaultSize[1]
  if (!(w >= 10 && w <= 400 && h >= 10 && h <= 400)) throw new Error("width and height must be 10-400 mm")
  const layers = o.layers ?? def.defaultLayers
  if (layers !== 2 && layers !== 4) throw new Error("layers must be 2 or 4")
  const holes = o.holes ?? "none"
  if (holes !== "none" && holes !== "m3-corners") throw new Error("holes must be none or m3-corners")

  const b = body(t, (n) => fs.existsSync(path.join(rootDir, "lib", `${n}.tsx`)))
  const hx = num(w / 2 - HOLE_INSET)
  const hy = num(h / 2 - HOLE_INSET)
  const usesGnd = b.inner.includes("GND")
  const header = `${b.imports}${b.pre}
const W = ${num(w)}
const H = ${num(h)}
${usesGnd ? 'const GND = "net.GND"\n' : ""}${holes === "m3-corners" ? `// 4x M3 mounting holes, ${HOLE_INSET} mm in from each corner\nconst HOLES = [\n  [-${hx}, -${hy}],\n  [${hx}, -${hy}],\n  [-${hx}, ${hy}],\n  [${hx}, ${hy}],\n]\n` : ""}`
  const holeJsx = holes === "m3-corners"
    ? `      {HOLES.map(([x, y], i) => (\n        <hole key={i} name={\`H\${i + 1}\`} diameter="3.2mm" pcbX={x} pcbY={y} />\n      ))}\n`
    : ""
  const comp = o.name.replace(/(^|[-_]+)([a-z0-9])/g, (_, __, c) => c.toUpperCase()).replace(/^[0-9]+/, (d) => `Board${d}`) || "Board"
  const routeRemaining = t === "blank" ? "" : " routeRemaining"
  const index = `${header}
export default function ${comp}() {
  return (
    <board width={\`\${W}mm\`} height={\`\${H}mm\`} layers={${layers}}${routeRemaining}>
${holeJsx}${b.inner}    </board>
  )
}
`
  const board = JSON.stringify({ name: o.name, description: o.description?.trim() ?? "", revision: "A", notes: "" }, null, 2) + "\n"
  return { "index.tsx": index, "board.json": board }
}
