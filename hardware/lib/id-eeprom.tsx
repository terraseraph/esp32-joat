// AT24C02C 2 Kbit I2C ID EEPROM, SOIC-8 (C6203). A0-A2 and WP tied low by the
// design: address 0x50, write-protect off (firmware may write the ID record).
export type IdEepromProps = {
  name: string
  pcbX?: number
  pcbY?: number
  pcbRotation?: number
  schX?: number
  schY?: number
}

export const IdEeprom = (props: IdEepromProps) => (
  <chip
    {...props}
    footprint="soic8"
    manufacturerPartNumber="AT24C02C-SSHM-T"
    supplierPartNumbers={{ jlcpcb: ["C6203"] }}
    pinAttributes={{ VCC: { requiresPower: true }, GND: { requiresGround: true } }}
    pinLabels={{ pin1: "A0", pin2: "A1", pin3: "A2", pin4: "GND", pin5: "SDA", pin6: "SCL", pin7: "WP", pin8: "VCC" }}
    schPinArrangement={{
      leftSide: { direction: "top-to-bottom", pins: ["A0", "A1", "A2", "WP"] },
      rightSide: { direction: "top-to-bottom", pins: ["VCC", "SDA", "SCL", "GND"] },
    }}
  />
)
