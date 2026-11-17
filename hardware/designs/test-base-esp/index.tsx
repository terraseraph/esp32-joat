import { Esp32S3Module } from "../../lib/esp32-s3-module"
import { UsbCDevice } from "../../lib/usb-c-device"
import { Buck3v3 } from "../../lib/buck-3v3"

const W = 50
const H = 40
// 4x M3 mounting holes, 4 mm in from each corner
const HOLES = [
  [-21, -16],
  [21, -16],
  [-21, 16],
  [21, 16],
]

export default function TestBaseEsp() {
  return (
    <board width={`${W}mm`} height={`${H}mm`} layers={2}>
      {HOLES.map(([x, y], i) => (
        <hole key={i} name={`H${i + 1}`} diameter="3.2mm" pcbX={x} pcbY={y} />
      ))}
      <resistor name="R1" resistance="10k" footprint="0402" pcbX={18} pcbY={14} />
      <Esp32S3Module name="U1" connections={{ IO19: "net.USB_DP" }} pcbX={-8} pcbY={15} />
      <UsbCDevice vbus="V5_USB" dp="USB_DP" dn="USB_DN" pcbX={13} pcbY={0} />
      <pinheader name="J1" pinCount={2} pitch="2.54mm" showSilkscreenPinLabels pcbX={-18} pcbY={-14} schX={22} schY={0} />
      <Buck3v3 vin="J1.pin1" vout="U1.3V3" pcbX={6} pcbY={-14} />
    </board>
  )
}
