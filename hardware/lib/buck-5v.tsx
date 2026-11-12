import { So8PowerpadFootprint } from "./power-footprints"

// Wide-input 5 V buck: TPS54360DDA (60 V, 3.5 A, non-synchronous, SO-8
// PowerPAD, JLCPCB C44377) + SS56 catch diode + 10 uH inductor.
// Vout = 0.8 V * (1 + 51k / 10k) = 4.88 V. RT = 160k gives about 610 kHz.
// Compensation values are a starting point, not a worked loop design.
export type Buck5vProps = {
  vin: string
  vout: string
  pcbX: number
  pcbY: number
}

const r0603 = (lcsc: string) => ({ footprint: "0603", supplierPartNumbers: { jlcpcb: [lcsc] } })

export const Buck5v = ({ vin, vout, pcbX: x, pcbY: y }: Buck5vProps) => (
  <>
    <chip
      name="U_BUCK5"
      footprint={<So8PowerpadFootprint />}
      manufacturerPartNumber="TPS54360DDAR"
      supplierPartNumbers={{ jlcpcb: ["C44377"] }}
      pcbX={x}
      pcbY={y}
      pinLabels={{ pin1: "BOOT", pin2: "VIN", pin3: "EN", pin4: "RT", pin5: "FB", pin6: "COMP", pin7: "GND", pin8: "SW", pin9: "PAD" }}
      pinAttributes={{ VIN: { requiresPower: true }, GND: { requiresGround: true } }}
      connections={{ VIN: vin, GND: "net.GND", PAD: "net.GND", SW: "net.SW5", BOOT: "net.BOOT5", FB: "net.FB5", COMP: "net.COMP5", RT: "net.RT5" }}
    />
    {/* EN floats high (internal pull-up): runs whenever VIN is above UVLO */}
    <capacitor name="C_BUCK_IN1" capacitance="2.2uF" footprint="1206" supplierPartNumbers={{ jlcpcb: ["C50254"] }}
      pcbX={x - 5} pcbY={y + 1.5} pcbRotation={90} connections={{ pin1: vin, pin2: "net.GND" }} />
    <capacitor name="C_BUCK_IN2" capacitance="2.2uF" footprint="1206" supplierPartNumbers={{ jlcpcb: ["C50254"] }}
      pcbX={x - 8} pcbY={y + 1.5} pcbRotation={90} connections={{ pin1: vin, pin2: "net.GND" }} />
    <capacitor name="C_BUCK_BULK" capacitance="100uF" footprint="jlcpcb:C2836439" manufacturerPartNumber="RVT100UF50V67RV0040"
      supplierPartNumbers={{ jlcpcb: ["C2836439"] }} pcbX={x - 17} pcbY={y - 2} connections={{ pin1: vin, pin2: "net.GND" }} />
    <capacitor name="C_BOOT5" capacitance="100nF" {...r0603("C14663")} pcbX={x + 4} pcbY={y + 5.5}
      connections={{ pin1: "net.BOOT5", pin2: "net.SW5" }} />
    <diode name="D_CATCH" footprint="sma" pinLabels={{ pin1: "cathode", pin2: "anode" }}  manufacturerPartNumber="SS56" supplierPartNumbers={{ jlcpcb: ["C65009"] }}
      pcbX={x + 6} pcbY={y - 7} pcbRotation={90} connections={{ anode: "net.GND", cathode: "net.SW5" }} />
    <inductor name="L_BUCK5" inductance="10uH" footprint="jlcpcb:C79272" manufacturerPartNumber="SWPA6045S100MT"
      supplierPartNumbers={{ jlcpcb: ["C79272"] }} pcbX={x + 11} pcbY={y} connections={{ pin1: "net.SW5", pin2: vout }} />
    <resistor name="R_RT5" resistance="160k" {...r0603("C22813")} pcbX={x - 4} pcbY={y - 5.5}
      connections={{ pin1: "net.RT5", pin2: "net.GND" }} />
    <resistor name="R_FB5_TOP" resistance="51k" {...r0603("C23196")} pcbX={x + 1} pcbY={y - 6}
      connections={{ pin1: vout, pin2: "net.FB5" }} />
    <resistor name="R_FB5_BOT" resistance="10k" {...r0603("C25804")} pcbX={x + 1} pcbY={y - 8}
      connections={{ pin1: "net.FB5", pin2: "net.GND" }} />
    <resistor name="R_COMP5" resistance="16.9k" {...r0603("C137789")} pcbX={x - 4} pcbY={y - 7.5}
      connections={{ pin1: "net.COMP5", pin2: "net.COMPRC5" }} />
    <capacitor name="C_COMP5" capacitance="4.7nF" {...r0603("C53987")} pcbX={x - 1} pcbY={y - 10.5}
      connections={{ pin1: "net.COMPRC5", pin2: "net.GND" }} />
    <capacitor name="C_COMPHF5" capacitance="47pF" {...r0603("C1671")} pcbX={x - 4} pcbY={y - 9.5}
      connections={{ pin1: "net.COMP5", pin2: "net.GND" }} />
    <capacitor name="C_BUCK_OUT1" capacitance="22uF" footprint="1206" supplierPartNumbers={{ jlcpcb: ["C12891"] }}
      pcbX={x + 18} pcbY={y + 2} pcbRotation={90} connections={{ pin1: vout, pin2: "net.GND" }} />
    <capacitor name="C_BUCK_OUT2" capacitance="22uF" footprint="1206" supplierPartNumbers={{ jlcpcb: ["C12891"] }}
      pcbX={x + 18} pcbY={y - 3} pcbRotation={90} connections={{ pin1: vout, pin2: "net.GND" }} />
  </>
)
