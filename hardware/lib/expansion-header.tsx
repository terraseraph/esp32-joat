// 1x6 2.54 mm pin header (C2337, 1x40 breakable strip cut to 6) carrying the
// expansion bus to the base board.
export const EXPANSION_PINS = ["V5", "V3_3", "GND", "SDA", "SCL", "INT"] as const

export type ExpansionHeaderProps = {
  name: string
  pcbX?: number
  pcbY?: number
  pcbRotation?: number
  schX?: number
  schY?: number
}

export const ExpansionHeader = (props: ExpansionHeaderProps) => (
  <pinheader
    {...props}
    pinCount={6}
    pitch="2.54mm"
    gender="male"
    showSilkscreenPinLabels
    pinLabels={["V5", "V3_3", "GND", "SDA", "SCL", "INT"]}
    supplierPartNumbers={{ jlcpcb: ["C2337"] }}
    schPinArrangement={{ leftSide: { direction: "top-to-bottom", pins: ["V5", "V3_3", "GND", "SDA", "SCL", "INT"] } }}
  />
)
