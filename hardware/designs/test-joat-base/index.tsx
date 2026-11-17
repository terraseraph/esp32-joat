
const W = 50
const H = 40

export default function TestJoatBase() {
  return (
    <board width={`${W}mm`} height={`${H}mm`} layers={2}>
      <resistor name="R1" resistance="10k" footprint="0402" pcbX={-0.5} pcbY={0} />
      <chip name="U1" footprint="jlcpcb:C2913202" manufacturerPartNumber="ESP32-S3-WROOM-1-N16R8" pcbX={-13} pcbY={2.5} supplierPartNumbers={{ jlcpcb: ["C2913202"] }} />
      <capacitor name="C1" capacitance="100nF" footprint="0603" pcbX={0} pcbY={8} />
    </board>
  )
}
