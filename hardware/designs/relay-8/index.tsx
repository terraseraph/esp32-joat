import { Fragment } from "react"
import { RelayChannel } from "../../lib/relay-channel"
import { ExpansionHeader } from "../../lib/expansion-header"
import { IdEeprom } from "../../lib/id-eeprom"

const COLUMNS = [-33, -11, 11, 33]
const HOLES = [
  [-46.5, -38.5],
  [46.5, -38.5],
  [-46.5, 38.5],
  [46.5, 38.5],
]

export default function Relay8() {
  const gnd = "net.GND"
  return (
    <board width="100mm" height="84mm" layers={2} routeRemaining>
      {HOLES.map(([x, y], i) => (
        <hole key={i} name={`H${i + 1}`} diameter="3.2mm" pcbX={x} pcbY={y} />
      ))}

      {/* bottom-layer ground pour: GND needs no routing */}
      <copperpour layer="bottom" connectsTo={gnd} />

      <ExpansionHeader name="J_EXP" pcbX={-47} pcbY={0} pcbRotation={90} schX={-14} schY={0} />

      {/* I/O expander: PCF8574-compatible pinout, push-pull PCA9554 (inputs at power-up = relays off) */}
      <chip
        name="U1"
        footprint="tssop16"
        manufacturerPartNumber="PCA9554PWR"
        supplierPartNumbers={{ jlcpcb: ["C2873588"] }}
        pcbX={-20}
        pcbY={0}
        schX={0}
        schY={0}
        pinAttributes={{ VCC: { requiresPower: true }, GND: { requiresGround: true } }}
        pinLabels={{
          pin1: "A0", pin2: "A1", pin3: "A2",
          pin4: "P0", pin5: "P1", pin6: "P2", pin7: "P3",
          pin8: "GND",
          pin9: "P4", pin10: "P5", pin11: "P6", pin12: "P7",
          pin13: "INT", pin14: "SCL", pin15: "SDA", pin16: "VCC",
        }}
        schPinArrangement={{
          leftSide: { direction: "top-to-bottom", pins: ["A0", "A1", "A2", "SDA", "SCL", "INT", "VCC", "GND"] },
          rightSide: { direction: "top-to-bottom", pins: ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7"] },
        }}
      />
      <IdEeprom name="U2" pcbX={-37} pcbY={0} schX={0} schY={-14} />

      {/* I2C pull-ups (fit only if the base board does not provide them) */}
      <resistor name="R_SDA" resistance="4.7k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C23162"] }} pcbX={-30} pcbY={3} schX={-8} schY={-7} />
      <resistor name="R_SCL" resistance="4.7k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C23162"] }} pcbX={-30} pcbY={-3} schX={-10} schY={-7} />
      {/* decoupling / bulk */}
      <capacitor name="C1" capacitance="100nF" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C14663"] }} pcbX={-20} pcbY={5} schX={-6} schY={4} />
      <capacitor name="C2" capacitance="100nF" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C14663"] }} pcbX={-37} pcbY={5} schX={-6} schY={-14} />
      <capacitor name="C3" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }} pcbX={-12} pcbY={4} schX={-18} schY={4} />
      <capacitor name="C4" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }} pcbX={-12} pcbY={-4} schX={-18} schY={-4} />

      {/* power / bus */}
      <trace name="T1" from=".J_EXP > .V5" to="net.V5" />
      <trace name="T2" from=".J_EXP > .V3_3" to="net.V3_3" />
      <trace name="T3" from=".J_EXP > .GND" to={gnd} />
      <trace name="T4" from=".J_EXP > .SDA" to="net.SDA" />
      <trace name="T5" from=".J_EXP > .SCL" to="net.SCL" />
      <trace name="T6" from=".J_EXP > .INT" to="net.INT" />

      <trace name="T7" from=".U1 > .VCC" to="net.V3_3" />
      <trace name="T8" from=".U1 > .GND" to={gnd} />
      <trace name="T9" from=".U1 > .SDA" to="net.SDA" />
      <trace name="T10" from=".U1 > .SCL" to="net.SCL" />
      <trace name="T11" from=".U1 > .INT" to="net.INT" />
      {/* address 0x20 */}
      <trace name="T12" from=".U1 > .A0" to={gnd} />
      <trace name="T13" from=".U1 > .A1" to={gnd} />
      <trace name="T14" from=".U1 > .A2" to={gnd} />

      <trace name="T15" from=".U2 > .VCC" to="net.V3_3" />
      <trace name="T16" from=".U2 > .GND" to={gnd} />
      <trace name="T17" from=".U2 > .SDA" to="net.SDA" />
      <trace name="T18" from=".U2 > .SCL" to="net.SCL" />
      {/* address 0x50, write-protect off */}
      <trace name="T19" from=".U2 > .A0" to={gnd} />
      <trace name="T20" from=".U2 > .A1" to={gnd} />
      <trace name="T21" from=".U2 > .A2" to={gnd} />
      <trace name="T22" from=".U2 > .WP" to={gnd} />

      <trace name="T23" from=".R_SDA > .pin1" to="net.V3_3" />
      <trace name="T24" from=".R_SDA > .pin2" to="net.SDA" />
      <trace name="T25" from=".R_SCL > .pin1" to="net.V3_3" />
      <trace name="T26" from=".R_SCL > .pin2" to="net.SCL" />

      <trace name="T27" from=".C1 > .pin1" to="net.V3_3" />
      <trace name="T28" from=".C1 > .pin2" to={gnd} />
      <trace name="T29" from=".C2 > .pin1" to="net.V3_3" />
      <trace name="T30" from=".C2 > .pin2" to={gnd} />
      <trace name="T31" from=".C3 > .pin1" to="net.V5" />
      <trace name="T32" from=".C3 > .pin2" to={gnd} />
      <trace name="T33" from=".C4 > .pin1" to="net.V3_3" />
      <trace name="T34" from=".C4 > .pin2" to={gnd} />

      {/* expander outputs -> relay drivers */}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <Fragment key={i}>
          <trace name={`TP${i}`} from={`.U1 > .P${i}`} to={`net.RLY${i + 1}`} />
        </Fragment>
      ))}

      {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
        <RelayChannel
          key={n}
          n={n}
          x={COLUMNS[(n - 1) % 4]}
          side={n <= 4 ? 1 : -1}
          drive={`net.RLY${n}`}
          schX={24}
          schY={-(n - 1) * 10 + 30}
        />
      ))}
    </board>
  )
}
