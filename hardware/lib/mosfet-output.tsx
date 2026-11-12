import { PluggableTerminal2 } from "./pluggable-terminal"
import { DfnFet5x6Footprint } from "./power-footprints"

// One low-side MOSFET output for PWM or on/off loads, 5 A continuous target.
// AON6354 (30 V, DFN5x6, JLCPCB C404363) driven straight from a 3.3 V GPIO via
// 100R, 100k pull-down keeps it off through reset and boot. SS56 (60 V 5 A)
// flyback from OUT- back to the load supply. Red LED + 1k on the gate drive
// shows the commanded state. Terminal: pin1 = load +, pin2 = OUT- (switched).
export type MosfetOutputProps = {
  n: number
  /** GPIO net driving this channel, e.g. "net.OUT1_G" */
  drive: string
  /** load supply rail, e.g. "net.VLOAD" */
  vload: string
  /** centre of the channel cell; terminal sits at the board edge below it */
  x: number
  y: number
}

const r0603 = (lcsc: string) => ({ footprint: "0603", supplierPartNumbers: { jlcpcb: [lcsc] } })

export const MosfetOutput = ({ n, drive, vload, x, y }: MosfetOutputProps) => {
  const gate = `net.OUT${n}_GATE`
  const sw = `net.OUT${n}_SW`
  const ledA = `net.OUT${n}_LED`
  return (
    <>
      <PluggableTerminal2 name={`J_OUT${n}`} nets={[vload, sw]} labels={["LOAD", "OUT"]} pcbX={x} pcbY={y - 14} pcbRotation={180} />
      <chip
        name={`Q_OUT${n}`}
        footprint={<DfnFet5x6Footprint />}
        manufacturerPartNumber="AON6354"
        supplierPartNumbers={{ jlcpcb: ["C404363"] }}
        pinLabels={{ pin1: "S1", pin2: "S2", pin3: "S3", pin4: "G", pin5: "D1", pin6: "D2", pin7: "D3", pin8: "D4", pin9: "D5" }}
        connections={{ S1: "net.GND", S2: "net.GND", S3: "net.GND", G: gate, D1: sw, D2: sw, D3: sw, D4: sw, D5: sw }}
        pcbX={x}
        pcbY={y + 3}
      />
      <diode name={`D_FLY${n}`} footprint="sma" pinLabels={{ pin1: "cathode", pin2: "anode" }}  manufacturerPartNumber="SS56" supplierPartNumbers={{ jlcpcb: ["C65009"] }}
        pcbX={x + 6} pcbY={y + 3} pcbRotation={90} connections={{ anode: sw, cathode: vload }} />
      <resistor name={`R_G${n}`} resistance="100" {...r0603("C22775")} pcbX={x - 4.5} pcbY={y + 8}
        connections={{ pin1: drive, pin2: gate }} />
      <resistor name={`R_PD${n}`} resistance="100k" {...r0603("C25803")} pcbX={x - 4.5} pcbY={y + 6}
        connections={{ pin1: gate, pin2: "net.GND" }} />
      <resistor name={`R_LED${n}`} resistance="1k" {...r0603("C21190")} pcbX={x - 1} pcbY={y + 9.5}
        connections={{ pin1: drive, pin2: ledA }} />
      <led name={`LED_OUT${n}`} color="red" footprint="0603" manufacturerPartNumber="KT-0603R"
        supplierPartNumbers={{ jlcpcb: ["C2286"] }} pcbX={x + 2.5} pcbY={y + 9.5}
        connections={{ anode: ledA, cathode: "net.GND" }} />
    </>
  )
}
