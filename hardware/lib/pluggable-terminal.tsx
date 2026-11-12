// 2-pin 5.08 mm pluggable terminal, board-side header KF2EDGR-5.08-2P
// (JLCPCB C441204, open, 15 A per pin). The mating plug is ordered separately.
// Footprint comes from the JLCPCB/EasyEDA library.
export type PluggableTerminal2Props = {
  name: string
  /** net for pin1 and pin2, e.g. ["net.VIN_DC", "net.GND"] */
  nets: [string, string]
  labels?: [string, string]
  pcbX?: number
  pcbY?: number
  pcbRotation?: number
  schX?: number
  schY?: number
}

export const PluggableTerminal2 = ({ nets, labels = ["P1", "P2"], ...props }: PluggableTerminal2Props) => (
  <chip
    {...props}
    footprint="jlcpcb:C441204"
    manufacturerPartNumber="KF2EDGR-5.08-2P"
    supplierPartNumbers={{ jlcpcb: ["C441204"] }}
    pinLabels={{ pin1: labels[0], pin2: labels[1] }}
    connections={{ [labels[0]]: nets[0], [labels[1]]: nets[1] }}
  />
)
