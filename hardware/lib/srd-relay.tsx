// Songle SRD-05VDC-SL-C style 5 V SPDT sugar-cube relay (JLCPCB C35449).
// Pad positions follow the Songle/SRD "Form C" PCB layout (same as the KiCad
// Relay_SPDT_SANYOU_SRD_Series_Form_C footprint), re-centred on the body.
// NOTE: which of pin3/pin4 is NC vs NO is taken from the KiCad convention and
// must be checked against the datasheet bottom view before fabrication.
export const SRD_RELAY_PINLABELS = {
  pin1: "COM",
  pin2: "COIL_A",
  pin3: "NC",
  pin4: "NO",
  pin5: "COIL_B",
} as const

const CX = 8.5 // KiCad origin (COM pad) -> body centre, x

const SrdFootprint = () => (
  <footprint>
    <platedhole shape="circle" portHints={["pin1"]} pcbX={0 - CX} pcbY={0} holeDiameter="1.3mm" outerDiameter="3mm" />
    <platedhole shape="circle" portHints={["pin2"]} pcbX={1.95 - CX} pcbY={-6.05} holeDiameter="1mm" outerDiameter="2.5mm" />
    <platedhole shape="circle" portHints={["pin3"]} pcbX={14.15 - CX} pcbY={-6.05} holeDiameter="1.3mm" outerDiameter="3mm" />
    <platedhole shape="circle" portHints={["pin4"]} pcbX={14.2 - CX} pcbY={6} holeDiameter="1.3mm" outerDiameter="3mm" />
    <platedhole shape="circle" portHints={["pin5"]} pcbX={1.95 - CX} pcbY={5.95} holeDiameter="1mm" outerDiameter="2.5mm" />
    <silkscreenpath
      route={[
        { x: -9.9, y: -7.8 },
        { x: 9.9, y: -7.8 },
        { x: 9.9, y: 7.8 },
        { x: -9.9, y: 7.8 },
        { x: -9.9, y: -7.8 },
      ]}
    />
  </footprint>
)

export type SrdRelayProps = {
  name: string
  pcbX?: number
  pcbY?: number
  pcbRotation?: number
  schX?: number
  schY?: number
}

export const SrdRelay = (props: SrdRelayProps) => (
  <chip
    {...props}
    manufacturerPartNumber="SRD-05VDC-SL-C"
    supplierPartNumbers={{ jlcpcb: ["C35449"] }}
    pinLabels={SRD_RELAY_PINLABELS}
    schPinArrangement={{
      leftSide: { direction: "top-to-bottom", pins: ["COIL_A", "COIL_B"] },
      rightSide: { direction: "top-to-bottom", pins: ["COM", "NO", "NC"] },
    }}
    footprint={<SrdFootprint />}
  />
)
