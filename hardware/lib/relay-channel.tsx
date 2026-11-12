import { SrdRelay } from "./srd-relay"
import { ScrewTerminal3 } from "./screw-terminal"

export type RelayChannelProps = {
  /** 1-based channel number, used for ref designators (K1, Q1, ...) */
  n: number
  /** board position of the channel cell centre */
  x: number
  /** +1 = relay row at +y with terminal on the +y edge, -1 = mirrored (rotated 180) */
  side: 1 | -1
  /** net carrying the logic-level drive signal from the I/O expander, e.g. "net.RLY1" */
  drive: string
  /** schematic origin of this channel */
  schX: number
  schY: number
}

// Local layout (side=+1), origin = cell centre at board y=0.
const TERMINAL_Y = 36.5
const RELAY_Y = 20.7

/**
 * One relay channel: SRD relay + AO3400A low-side switch (100R gate, 100k
 * pull-down), 1N4148W flyback across the coil, red LED + 1k indicator from 5V,
 * and the COM/NO/NC screw terminal.
 */
export const RelayChannel = ({ n, x, side: s, drive, schX, schY }: RelayChannelProps) => {
  const rot = s === 1 ? 0 : 180
  const p = (dx: number, dy: number) => ({ pcbX: x + s * dx, pcbY: s * dy, pcbRotation: rot })
  const sw = `net.SW${n}`
  const gate = `net.G${n}`
  const r = `.K${n}`
  return (
    <>
      <ScrewTerminal3 name={`TB${n}`} {...p(0, TERMINAL_Y)} schX={schX + 14} schY={schY} />
      <SrdRelay name={`K${n}`} {...p(0, RELAY_Y)} schX={schX + 8} schY={schY} />

      <resistor
        name={`RG${n}`}
        resistance="100"
        footprint="0603"
        supplierPartNumbers={{ jlcpcb: ["C22775"] }}
        {...p(-8.5, 11)}
        schX={schX - 6}
        schY={schY}
      />
      <transistor
        name={`Q${n}`}
        type="mosfet"
        footprint="sot23"
        manufacturerPartNumber="AO3400A"
        supplierPartNumbers={{ jlcpcb: ["C347475"] }}
        pinLabels={{ pin1: "gate", pin2: "source", pin3: "drain" }}
        {...p(-4, 11)}
        schX={schX - 2}
        schY={schY}
      />
      <resistor
        name={`RP${n}`}
        resistance="100k"
        footprint="0603"
        supplierPartNumbers={{ jlcpcb: ["C25803"] }}
        {...p(-8.5, 7.5)}
        schX={schX - 6}
        schY={schY - 3}
      />
      <diode
        name={`D${n}`}
        footprint="sod123"
        pinLabels={{ pin1: "cathode", pin2: "anode" }}
        manufacturerPartNumber="1N4148W"
        supplierPartNumbers={{ jlcpcb: ["C81598"] }}
        {...p(2, 11)}
        schX={schX + 3}
        schY={schY + 3}
      />
      <led
        name={`LED${n}`}
        color="red"
        footprint="0603"
        manufacturerPartNumber="KT-0603R"
        supplierPartNumbers={{ jlcpcb: ["C2286"] }}
        {...p(2, 7.5)}
        schX={schX + 3}
        schY={schY - 3}
      />
      <resistor
        name={`RL${n}`}
        resistance="1k"
        footprint="0603"
        supplierPartNumbers={{ jlcpcb: ["C21190"] }}
        {...p(6.5, 7.5)}
        schX={schX + 6}
        schY={schY - 3}
      />

      {/* drive: expander -> RG -> gate; RP pulls the gate low (relay off while the expander pin is high-Z) */}
      <trace name={`T${n}_1`} from={`.RG${n} > .pin1`} to={drive} />
      <trace name={`T${n}_2`} from={`.RG${n} > .pin2`} to={gate} />
      <trace name={`T${n}_3`} from={`.Q${n} > .gate`} to={gate} />
      <trace name={`T${n}_4`} from={`.RP${n} > .pin1`} to={gate} />
      <trace name={`T${n}_5`} from={`.RP${n} > .pin2`} to="net.GND" />
      <trace name={`T${n}_6`} from={`.Q${n} > .source`} to="net.GND" />
      {/* coil: 5V -> coil -> switch node; flyback and LED hang off the same nodes */}
      <trace name={`T${n}_7`} from={`${r} > .COIL_A`} to="net.V5" />
      <trace name={`T${n}_8`} from={`${r} > .COIL_B`} to={sw} />
      <trace name={`T${n}_9`} from={`.Q${n} > .drain`} to={sw} />
      <trace name={`T${n}_10`} from={`.D${n} > .cathode`} to="net.V5" />
      <trace name={`T${n}_11`} from={`.D${n} > .anode`} to={sw} />
      <trace name={`T${n}_12`} from={`.RL${n} > .pin1`} to="net.V5" />
      <trace name={`T${n}_13`} from={`.RL${n} > .pin2`} to={`.LED${n} > .anode`} />
      <trace name={`T${n}_14`} from={`.LED${n} > .cathode`} to={sw} />
      {/* contacts -> terminal */}
      <trace name={`T${n}_15`} from={`${r} > .COM`} to={`.TB${n} > .COM`} />
      <trace name={`T${n}_16`} from={`${r} > .NO`} to={`.TB${n} > .NO`} />
      <trace name={`T${n}_17`} from={`${r} > .NC`} to={`.TB${n} > .NC`} />
    </>
  )
}
