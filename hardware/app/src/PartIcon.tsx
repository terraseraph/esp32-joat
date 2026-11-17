import type { ReactNode } from "react"

type Cat = "passive" | "power" | "digital" | "connector" | "switching" | "sense" | "neutral"
const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const

/** Pictograms on a 32x32 grid, drawn like the parts look on a board or schematic. Colour comes from the category. */
const ART: Record<string, { cat: Cat; art: ReactNode }> = {
  "prim:resistor": { cat: "passive", art: <path d="M3 16h5l2-5 4 10 4-10 4 10 2-5h5" /> },
  "prim:capacitor": { cat: "passive", art: <path d="M3 16h10M19 16h10M13 7v18M19 7v18" /> },
  "prim:led": { cat: "passive", art: <><path d="M10 8v16l11-8zM22 8v16M3 16h7M22 16h7" /><path d="M18 5l5-3M22 9l5-3" /></> },
  "prim:diode": { cat: "passive", art: <path d="M10 8v16l11-8zM22 8v16M3 16h7M22 16h7" /> },
  "prim:pinheader": { cat: "connector", art: <><rect x="5" y="11" width="22" height="10" rx="1.5" />{[0, 1, 2, 3].map((i) => <circle key={i} cx={9.5 + i * 4.3} cy="16" r="1.6" fill="currentColor" stroke="none" />)}</> },
  "prim:chip": { cat: "digital", art: <><rect x="9" y="9" width="14" height="14" rx="2" /><path d="M5 12.5h4M5 16h4M5 19.5h4M23 12.5h4M23 16h4M23 19.5h4M12.5 5v4M16 5v4M19.5 5v4M12.5 23v4M16 23v4M19.5 23v4" /><circle cx="12.5" cy="12.5" r="1" fill="currentColor" stroke="none" /></> },
  "prim:hole": { cat: "neutral", art: <><circle cx="16" cy="16" r="10" /><circle cx="16" cy="16" r="4.5" /></> },
  "lib:Buck3v3": { cat: "power", art: <><path d="M3 22h3.5c0-6 6-6 6 0c0-6 6-6 6 0c0-6 6-6 6 0H29" /><path d="M16 5v8m-3-3l3 3 3-3" /></> },
  "lib:Buck5v": { cat: "power", art: <><path d="M3 22h3.5c0-6 6-6 6 0c0-6 6-6 6 0c0-6 6-6 6 0H29" /><path d="M16 5v8m-3-3l3 3 3-3" /></> },
  "lib:Esp32S3Module": { cat: "digital", art: <><rect x="7" y="11" width="18" height="17" rx="1.5" /><path d="M8 11V6h3v3h3V6h3v3h3V6h3v5" /><path d="M4 15h3M4 19h3M4 23h3M25 15h3M25 19h3M25 23h3" /></> },
  "lib:ExpansionBus": { cat: "connector", art: <><rect x="4" y="10" width="24" height="12" rx="1.5" /><path d="M13 10V8h6v2" />{[0, 1, 2, 3, 4].map((i) => <g key={i}><circle cx={8.5 + i * 3.8} cy="14" r="1.3" fill="currentColor" stroke="none" /><circle cx={8.5 + i * 3.8} cy="18" r="1.3" fill="currentColor" stroke="none" /></g>)}</> },
  "lib:ExpansionHeader": { cat: "connector", art: <><rect x="3" y="12" width="26" height="8" rx="1.5" />{[0, 1, 2, 3, 4, 5].map((i) => <circle key={i} cx={7 + i * 3.6} cy="16" r="1.3" fill="currentColor" stroke="none" />)}</> },
  "lib:IdEeprom": { cat: "digital", art: <><rect x="9" y="7" width="14" height="18" rx="1.5" /><path d="M5 10h4M5 14h4M5 18h4M5 22h4M23 10h4M23 14h4M23 18h4M23 22h4" /><text x="16" y="19" fontSize="7.5" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700" fontFamily="ui-monospace, monospace">ID</text></> },
  "lib:Ina226Monitor": { cat: "sense", art: <><path d="M5 22a11 11 0 0 1 22 0" /><path d="M16 22l5-7M5 22h22M9 26h14" /><circle cx="16" cy="22" r="1.4" fill="currentColor" stroke="none" /></> },
  "lib:MosfetOutput": { cat: "switching", art: <><path d="M6 16h8M14 8v16M18 8v4M18 14v4M18 20v4M18 10h8V4M18 22h8v6M18 16h6" /><path d="M23 14l2 2-2 2" /></> },
  "lib:PluggableTerminal2": { cat: "connector", art: <><rect x="5" y="9" width="22" height="13" rx="1.5" /><circle cx="11" cy="15.5" r="3.2" /><circle cx="21" cy="15.5" r="3.2" /><path d="M11 22v5M21 22v5" /></> },
  "lib:ScrewTerminal3": { cat: "connector", art: <><rect x="3" y="9" width="26" height="13" rx="1.5" /><circle cx="9" cy="15.5" r="2.6" /><circle cx="16" cy="15.5" r="2.6" /><circle cx="23" cy="15.5" r="2.6" /><path d="M9 22v5M16 22v5M23 22v5" /></> },
  "lib:RelayChannel": { cat: "switching", art: <><rect x="3" y="9" width="11" height="14" rx="1" /><path d="M8.5 5v4M8.5 23v4M22 25v-3M22 22l6-8M28 14v-5M22 25h0" /><circle cx="22" cy="25" r="1.3" fill="currentColor" stroke="none" /></> },
  "lib:SrdRelay": { cat: "switching", art: <><rect x="4" y="6" width="24" height="20" rx="2" /><rect x="8" y="11" width="8" height="10" /><path d="M21 21v-3M21 18l4-6" /></> },
  "lib:UsbCDevice": { cat: "connector", art: <><rect x="5" y="10" width="22" height="12" rx="6" /><rect x="10" y="14" width="12" height="4" rx="2" /></> },
  "lib:W5500Ethernet": { cat: "digital", art: <><path d="M6 8h20v14h-5v4h-10v-4H6z" /><path d="M11 12v5M14.5 12v5M18 12v5M21.5 12v5" /></> },
}
const GENERIC = { cat: "neutral" as Cat, art: <><rect x="6" y="6" width="9" height="9" rx="1.5" /><rect x="17" y="6" width="9" height="9" rx="1.5" /><rect x="6" y="17" width="9" height="9" rx="1.5" /><rect x="17" y="17" width="9" height="9" rx="1.5" /></> }

export const PART_CATEGORIES: Record<Cat, string> = { passive: "Passive", power: "Power", digital: "Digital / IC", connector: "Connector", switching: "Switching", sense: "Sensing", neutral: "Mechanical" }

/** A small tile with a picture of the part, tinted by what kind of part it is. */
export default function PartIcon({ id, size = 38 }: { id: string; size?: number }) {
  const { cat, art } = ART[id] ?? GENERIC
  return (
    <span className={`part-icon cat-${cat}`} style={{ width: size, height: size }} aria-hidden title={PART_CATEGORIES[cat]}>
      <svg viewBox="0 0 32 32" width={size - 8} height={size - 8} {...S}>{art}</svg>
    </span>
  )
}
