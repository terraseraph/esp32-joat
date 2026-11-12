// ESP32-S3-WROOM-1-N16R8 module (JLCPCB C2913202): 16 MB flash, 8 MB octal
// PSRAM, so IO35-IO37 are used internally and must stay unconnected.
// Footprint from the JLCPCB/EasyEDA library. Keep copper and parts out from
// under the antenna end of the module.
export const ESP32_S3_PINS = {
  pin1: "GND", pin2: "3V3", pin3: "EN",
  pin4: "IO4", pin5: "IO5", pin6: "IO6", pin7: "IO7", pin8: "IO15", pin9: "IO16", pin10: "IO17",
  pin11: "IO18", pin12: "IO8", pin13: "IO19", pin14: "IO20", pin15: "IO3", pin16: "IO46", pin17: "IO9",
  pin18: "IO10", pin19: "IO11", pin20: "IO12", pin21: "IO13", pin22: "IO14", pin23: "IO21", pin24: "IO47",
  pin25: "IO48", pin26: "IO45", pin27: "IO0", pin28: "IO35", pin29: "IO36", pin30: "IO37", pin31: "IO38",
  pin32: "IO39", pin33: "IO40", pin34: "IO41", pin35: "IO42", pin36: "RXD0", pin37: "TXD0", pin38: "IO2",
  pin39: "IO1", pin40: "GND2", pin41: "EPAD",
} as const

export type Esp32S3ModuleProps = {
  name: string
  /** module pin label -> net, e.g. { IO8: "net.SDA" } */
  connections: Record<string, string>
  pcbX: number
  pcbY: number
  pcbRotation?: number
}

export const Esp32S3Module = ({ connections, ...props }: Esp32S3ModuleProps) => (
  <chip
    {...props}
    footprint="jlcpcb:C2913202"
    manufacturerPartNumber="ESP32-S3-WROOM-1-N16R8"
    supplierPartNumbers={{ jlcpcb: ["C2913202"] }}
    pinLabels={ESP32_S3_PINS}
    pinAttributes={{ "3V3": { requiresPower: true }, GND: { requiresGround: true } }}
    connections={{ GND: "net.GND", GND2: "net.GND", EPAD: "net.GND", "3V3": "net.V3_3", ...connections }}
  />
)
