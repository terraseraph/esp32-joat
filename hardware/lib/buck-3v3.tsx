// 5 V to 3.3 V synchronous buck: TLV62569DBV (2 A, SOT-23-5, JLCPCB C141836).
// Vout = 0.6 V * (1 + 100k / 22k) = 3.33 V.
export type Buck3v3Props = {
  vin: string
  vout: string
  pcbX: number
  pcbY: number
}

export const Buck3v3 = ({ vin, vout, pcbX: x, pcbY: y }: Buck3v3Props) => (
  <>
    <chip
      name="U_BUCK3"
      footprint="sot23_5"
      manufacturerPartNumber="TLV62569DBVR"
      supplierPartNumbers={{ jlcpcb: ["C141836"] }}
      pcbX={x}
      pcbY={y}
      pinLabels={{ pin1: "EN", pin2: "GND", pin3: "SW", pin4: "VIN", pin5: "FB" }}
      pinAttributes={{ VIN: { requiresPower: true }, GND: { requiresGround: true } }}
      connections={{ EN: vin, GND: "net.GND", SW: "net.SW3", VIN: vin, FB: "net.FB3" }}
    />
    <capacitor name="C_B3_IN" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }}
      pcbX={x - 4} pcbY={y} pcbRotation={90} connections={{ pin1: vin, pin2: "net.GND" }} />
    <inductor name="L_BUCK3" inductance="2.2uH" footprint="jlcpcb:C5832372" manufacturerPartNumber="FTC252012S2R2MBCA"
      supplierPartNumbers={{ jlcpcb: ["C5832372"] }} pcbX={x + 4.5} pcbY={y + 1} connections={{ pin1: "net.SW3", pin2: vout }} />
    <resistor name="R_FB3_TOP" resistance="100k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C25803"] }}
      pcbX={x + 1} pcbY={y - 3.5} connections={{ pin1: vout, pin2: "net.FB3" }} />
    <resistor name="R_FB3_BOT" resistance="22k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C31850"] }}
      pcbX={x + 1} pcbY={y - 5.5} connections={{ pin1: "net.FB3", pin2: "net.GND" }} />
    <capacitor name="C_B3_OUT1" capacitance="22uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C45783"] }}
      pcbX={x + 8.5} pcbY={y + 1} pcbRotation={90} connections={{ pin1: vout, pin2: "net.GND" }} />
    <capacitor name="C_B3_OUT2" capacitance="22uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C45783"] }}
      pcbX={x + 11} pcbY={y + 1} pcbRotation={90} connections={{ pin1: vout, pin2: "net.GND" }} />
  </>
)
