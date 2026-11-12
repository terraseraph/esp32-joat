// USB-C device port for the ESP32-S3 native USB (IO19 = D-, IO20 = D+).
// TYPE-C16PIN receptacle (JLCPCB C393939), 5.1k CC pull-downs (5 V only, up
// to 3 A from a Type-C source), USBLC6-2SC6 ESD on D+/D- and VBUS.
// VBUS leaves on `vbus`; the board decides how it joins the 5 V rail.
export type UsbCDeviceProps = {
  vbus: string
  dp: string
  dn: string
  pcbX: number
  pcbY: number
  pcbRotation?: number
}

export const UsbCDevice = ({ vbus, dp, dn, pcbX: x, pcbY: y, pcbRotation = 0 }: UsbCDeviceProps) => (
  <>
    <chip
      name="J_USB"
      footprint="jlcpcb:C393939"
      manufacturerPartNumber="TYPE-C16PIN"
      supplierPartNumbers={{ jlcpcb: ["C393939"] }}
      pcbX={x}
      pcbY={y}
      pcbRotation={pcbRotation}
      pinLabels={{
        pin1: "SH1", pin2: "SH2", pin3: "SH3", pin4: "SH4",
        pin5: "GND1", pin6: "VBUS1", pin7: "GND2", pin8: "VBUS2", pin9: "CC2", pin10: "SBU1",
        pin11: "DP2", pin12: "DN1", pin13: "DP1", pin14: "DN2", pin15: "CC1", pin16: "SBU2",
      }}
      connections={{
        SH1: "net.GND", SH2: "net.GND", SH3: "net.GND", SH4: "net.GND",
        GND1: "net.GND", GND2: "net.GND", VBUS1: vbus, VBUS2: vbus,
        CC1: "net.USB_CC1", CC2: "net.USB_CC2", DP1: dp, DP2: dp, DN1: dn, DN2: dn,
      }}
    />
    <resistor name="R_CC1" resistance="5.1k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C23186"] }}
      pcbX={x - 3} pcbY={y - 6} connections={{ pin1: "net.USB_CC1", pin2: "net.GND" }} />
    <resistor name="R_CC2" resistance="5.1k" footprint="0603" supplierPartNumbers={{ jlcpcb: ["C23186"] }}
      pcbX={x + 3} pcbY={y - 6} connections={{ pin1: "net.USB_CC2", pin2: "net.GND" }} />
    <chip
      name="U_ESD"
      footprint="sot23_6"
      manufacturerPartNumber="USBLC6-2SC6"
      supplierPartNumbers={{ jlcpcb: ["C7519"] }}
      pcbX={x}
      pcbY={y - 9}
      pinLabels={{ pin1: "IO1A", pin2: "GND", pin3: "IO2A", pin4: "IO2B", pin5: "VBUS", pin6: "IO1B" }}
      connections={{ IO1A: dp, IO1B: dp, IO2A: dn, IO2B: dn, GND: "net.GND", VBUS: vbus }}
    />
  </>
)
