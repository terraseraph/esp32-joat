// 3-pin 5.08 mm pitch screw terminal block, KF128-5.08-3P-AA (JLCPCB C474953).
// Pin order along +x: pin1, pin2, pin3. Origin is the centre of the 3 pins.
const PITCH = 5.08

const TerminalFootprint3 = () => (
  <footprint>
    {[0, 1, 2].map((i) => (
      <platedhole
        key={i}
        shape="circle"
        portHints={[`pin${i + 1}`]}
        pcbX={(i - 1) * PITCH}
        pcbY={0}
        holeDiameter="1.4mm"
        outerDiameter="2.8mm"
      />
    ))}
    <silkscreenpath
      route={[
        { x: -7.62, y: -5 },
        { x: 7.62, y: -5 },
        { x: 7.62, y: 5 },
        { x: -7.62, y: 5 },
        { x: -7.62, y: -5 },
      ]}
    />
  </footprint>
)

export type ScrewTerminal3Props = {
  name: string
  pcbX?: number
  pcbY?: number
  pcbRotation?: number
  schX?: number
  schY?: number
  /** labels for pin1..pin3 */
  labels?: [string, string, string]
}

export const ScrewTerminal3 = ({ labels = ["COM", "NO", "NC"], ...props }: ScrewTerminal3Props) => (
  <chip
    {...props}
    manufacturerPartNumber="KF128-5.08-3P-AA"
    supplierPartNumbers={{ jlcpcb: ["C474953"] }}
    pinLabels={{ pin1: labels[0], pin2: labels[1], pin3: labels[2] }}
    schPinArrangement={{ rightSide: { direction: "top-to-bottom", pins: labels as string[] } }}
    footprint={<TerminalFootprint3 />}
  />
)
