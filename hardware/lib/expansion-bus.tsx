// 2x8 2.54 mm shrouded expansion header (JLCPCB C3406), base-board side.
// Odd pins on one row, even on the other (IDC numbering). Every expansion
// board carries an ID EEPROM on SDA/SCL; INT is open-drain, pulled up on the
// base board. SPI is shared with the on-board W5500 (separate CS).
// IO_A..IO_C are spare GPIOs, intended for I2S (BCLK, WS, DATA).
// Pin current is about 1 A per pin, so 5 V is limited to about 2 A total.
export const EXPANSION_BUS_PINS = {
  pin1: "V5A", pin2: "V5B", pin3: "V3_3A", pin4: "V3_3B",
  pin5: "GNDA", pin6: "GNDB", pin7: "SDA", pin8: "SCL",
  pin9: "INT", pin10: "CS", pin11: "SCK", pin12: "MOSI",
  pin13: "MISO", pin14: "IO_A", pin15: "IO_B", pin16: "IO_C",
} as const

export type ExpansionBusProps = {
  name: string
  pcbX: number
  pcbY: number
  pcbRotation?: number
  /** pin label -> net for the signal pins; power pins are fixed */
  connections: Partial<Record<"SDA" | "SCL" | "INT" | "CS" | "SCK" | "MOSI" | "MISO" | "IO_A" | "IO_B" | "IO_C", string>>
}

export const ExpansionBus = ({ connections, ...props }: ExpansionBusProps) => (
  <chip
    {...props}
    footprint="jlcpcb:C3406"
    manufacturerPartNumber="2.54-2*8P"
    supplierPartNumbers={{ jlcpcb: ["C3406"] }}
    pinLabels={EXPANSION_BUS_PINS}
    connections={{
      V5A: "net.V5", V5B: "net.V5", V3_3A: "net.V3_3", V3_3B: "net.V3_3", GNDA: "net.GND", GNDB: "net.GND",
      ...connections,
    }}
  />
)
