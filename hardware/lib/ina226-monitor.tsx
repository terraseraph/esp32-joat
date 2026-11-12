// INA226 high-side current/voltage monitor (VSSOP-10, JLCPCB C49851) with its
// shunt. Current flows from `from` through the shunt to `to`; VBUS reads `to`.
// Address pins: GND/GND 0x40, GND/VS 0x41, VS/GND 0x44, VS/VS 0x45.
// ALERT is left unconnected.
export const SHUNTS = {
  // 20 mOhm 1206: 81.92 mV full scale = 4.1 A, 0.32 W at 4 A
  "20m": { resistance: "20mOhm", footprint: "1206", lcsc: "C5120998", mpn: "LRAM12CJTR020" },
  // 2 mOhm 2512 3 W: 41 A full scale, 0.8 W at 20 A
  "2m": { resistance: "2mOhm", footprint: "2512", lcsc: "C375692", mpn: "PA2512FKE7T0R002E" },
} as const

export type Ina226MonitorProps = {
  /** suffix for ref designators, e.g. "DC" gives U_INA_DC, RS_DC, C_INA_DC */
  id: string
  from: string
  to: string
  /** nets for A0 and A1 (net.GND or net.V3_3) */
  a0: string
  a1: string
  shunt: keyof typeof SHUNTS
  pcbX: number
  pcbY: number
  pcbRotation?: number
}

export const Ina226Monitor = ({ id, from, to, a0, a1, shunt, pcbX, pcbY, pcbRotation = 0 }: Ina226MonitorProps) => {
  const s = SHUNTS[shunt]
  const big = shunt === "2m"
  return (
    <>
      <resistor
        name={`RS_${id}`}
        resistance={s.resistance}
        footprint={s.footprint}
        manufacturerPartNumber={s.mpn}
        supplierPartNumbers={{ jlcpcb: [s.lcsc] }}
        pcbX={pcbX}
        pcbY={pcbY + (big ? 5 : 4)}
        pcbRotation={pcbRotation}
        connections={{ pin1: from, pin2: to }}
      />
      <chip
        name={`U_INA_${id}`}
        footprint="vssop10"
        manufacturerPartNumber="INA226AIDGSR"
        supplierPartNumbers={{ jlcpcb: ["C49851"] }}
        pcbX={pcbX}
        pcbY={pcbY}
        pcbRotation={pcbRotation}
        pinLabels={{
          pin1: "A1", pin2: "A0", pin3: "ALERT", pin4: "SDA", pin5: "SCL",
          pin6: "VS", pin7: "GND", pin8: "VBUS", pin9: "INM", pin10: "INP",
        }}
        pinAttributes={{ VS: { requiresPower: true }, GND: { requiresGround: true } }}
        connections={{
          A1: a1, A0: a0, SDA: "net.SDA", SCL: "net.SCL",
          VS: "net.V3_3", GND: "net.GND", VBUS: to, INP: from, INM: to,
        }}
      />
      <capacitor
        name={`C_INA_${id}`}
        capacitance="100nF"
        footprint="0603"
        supplierPartNumbers={{ jlcpcb: ["C14663"] }}
        pcbX={pcbX - 4.5}
        pcbY={pcbY}
        pcbRotation={90}
        connections={{ pin1: "net.V3_3", pin2: "net.GND" }}
      />
    </>
  )
}
