import { Esp32S3Module } from "../../lib/esp32-s3-module"
import { UsbCDevice } from "../../lib/usb-c-device"
import { Buck3v3 } from "../../lib/buck-3v3"

/**
 * Minimal ESP32-S3 board: USB-C powers it and flashes it, a UART header gives a second way in.
 *  - USB-C -> 5 V rail -> TLV62569 buck -> 3.3 V.
 *  - IO19 / IO20 are the S3's native USB (USB-Serial/JTAG): flashing and the serial console over the one USB-C.
 *  - EN has an RC power-on reset and a RESET button; IO0 has a pull-up and a BOOT button (hold BOOT, tap RESET for download mode).
 *  - J_UART (3V3, TXD0, RXD0, GND) is UART0 for an external USB-serial adapter.
 */
const GND = "net.GND"
const V5 = "net.V5"
const V33 = "net.V3_3"
const r0603 = (lcsc: string) => ({ footprint: "0603", supplierPartNumbers: { jlcpcb: [lcsc] } })

// 56 x 50 mm, centred. The antenna end of the module sits on the bottom edge and keeps clear of copper.
const W = 56
const H = 50
const HOLES = [
  [-24, 21],
  [24, 21],
  [-24, -21],
  [24, -21],
]

export default function TestBaseEsp() {
  return (
    <board width={`${W}mm`} height={`${H}mm`} layers={2}>
      {HOLES.map(([x, y], i) => (
        <hole key={i} name={`H${i + 1}`} diameter="3.2mm" pcbX={x} pcbY={y} />
      ))}

      {/* power: USB-C VBUS -> 5 V -> 3.3 V */}
      <UsbCDevice vbus={V5} dp="net.USB_DP" dn="net.USB_DN" pcbX={-6} pcbY={19.3} pcbRotation={180} />
      <Buck3v3 vin={V5} vout={V33} pcbX={-20} pcbY={4} />
      <resistor name="R_PWR" resistance="1k" {...r0603("C21190")} pcbX={-13} pcbY={-3} connections={{ pin1: V33, pin2: "net.PWR_A" }} />
      <led name="LED_PWR" color="red" footprint="0603" manufacturerPartNumber="KT-0603R" supplierPartNumbers={{ jlcpcb: ["C2286"] }}
        pcbX={-10} pcbY={-3} connections={{ anode: "net.PWR_A", cathode: GND }} />

      {/* MCU: native USB on IO19 (D-) / IO20 (D+), UART0 for the header, antenna end at the bottom edge */}
      <Esp32S3Module
        name="U_MCU"
        pcbX={12}
        pcbY={-8}
        pcbRotation={180}
        connections={{
          EN: "net.EN", IO0: "net.BOOT",
          IO19: "net.USB_DN", IO20: "net.USB_DP",
          TXD0: "net.UART_TX", RXD0: "net.UART_RX",
        }}
      />
      <capacitor name="C_MCU1" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }}
        pcbX={24} pcbY={-5} pcbRotation={90} connections={{ pin1: V33, pin2: GND }} />
      <capacitor name="C_MCU2" capacitance="100nF" {...r0603("C14663")} pcbX={24} pcbY={-8.5} pcbRotation={90}
        connections={{ pin1: V33, pin2: GND }} />

      {/* EN: RC power-on reset + RESET button; IO0: pull-up + BOOT button */}
      <resistor name="R_EN" resistance="10k" {...r0603("C25804")} pcbX={-3} pcbY={-3} connections={{ pin1: V33, pin2: "net.EN" }} />
      <capacitor name="C_EN" capacitance="1uF" {...r0603("C15849")} pcbX={-3} pcbY={-6} connections={{ pin1: "net.EN", pin2: GND }} />
      <resistor name="R_BOOT" resistance="10k" {...r0603("C25804")} pcbX={-3} pcbY={-9} connections={{ pin1: V33, pin2: "net.BOOT" }} />
      <chip name="SW_RST" footprint="jlcpcb:C318884" manufacturerPartNumber="TS-1187A-B-A-B" supplierPartNumbers={{ jlcpcb: ["C318884"] }}
        pinLabels={{ pin1: "A", pin2: "B", pin3: "C", pin4: "D" }} connections={{ A: "net.EN", D: GND }} pcbX={-6} pcbY={-14} />
      <chip name="SW_BOOT" footprint="jlcpcb:C318884" manufacturerPartNumber="TS-1187A-B-A-B" supplierPartNumbers={{ jlcpcb: ["C318884"] }}
        pinLabels={{ pin1: "A", pin2: "B", pin3: "C", pin4: "D" }} connections={{ A: "net.BOOT", D: GND }} pcbX={-14} pcbY={-14} />

      {/* UART0 header for an external USB-serial adapter (module pin names: TXD0 out, RXD0 in) */}
      <pinheader
        name="J_UART"
        pinCount={4}
        pitch="2.54mm"
        gender="male"
        showSilkscreenPinLabels
        pinLabels={["3V3", "TXD0", "RXD0", "GND"]}
        supplierPartNumbers={{ jlcpcb: ["C2337"] }}
        connections={{ pin1: V33, pin2: "net.UART_TX", pin3: "net.UART_RX", pin4: GND }}
        pcbX={-24}
        pcbY={-12}
        pcbRotation={90}
      />
    </board>
  )
}
