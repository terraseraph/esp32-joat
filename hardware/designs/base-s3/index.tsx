import { Esp32S3Module } from "../../lib/esp32-s3-module"
import { PluggableTerminal2 } from "../../lib/pluggable-terminal"
import { Ina226Monitor } from "../../lib/ina226-monitor"
import { Buck5v } from "../../lib/buck-5v"
import { Buck3v3 } from "../../lib/buck-3v3"
import { UsbCDevice } from "../../lib/usb-c-device"
import { W5500Ethernet } from "../../lib/w5500-ethernet"
import { MosfetOutput } from "../../lib/mosfet-output"
import { ExpansionBus } from "../../lib/expansion-bus"

/*
 * ESP32-S3 base board.
 * Logic power: DC terminal (5-24 V) and PoE plug-in (12 V) are diode-ORed onto
 * VIN, which feeds a 60 V buck to 5 V; USB VBUS is diode-ORed straight onto
 * 5 V. A small buck makes 3.3 V. An INA226 on each input reports which source
 * is live. Load power has its own input (two terminals in parallel, 20 A
 * total) feeding four 5 A low-side MOSFET outputs, with its own INA226.
 *
 * GPIO map: IO8 SDA, IO9 SCL, IO12 SCK, IO11 MOSI, IO13 MISO, IO14 ETH CS,
 * IO21 ETH INT, IO47 ETH RST, IO10 EXP CS, IO48 EXP INT, IO4/5/6 EXP IO_A/B/C,
 * IO15-IO18 OUT1-OUT4, IO2 status LED, IO0 BOOT, IO19/IO20 USB D-/D+.
 * IO35-37 are taken by the octal PSRAM.
 */

const GND = "net.GND"
const V33 = "net.V3_3"
const r0603 = (lcsc: string) => ({ footprint: "0603", supplierPartNumbers: { jlcpcb: [lcsc] } })

const HOLES = [
  [-56, -41],
  [56, -41],
  [-56, 41],
  [56, 41],
]

const OUTPUT_X = [-22, -2, 18, 38]

// board outline (120 x 90, centred) with the antenna keep-out cut out at the top edge
const POUR_OUTLINE = [
  { x: -60, y: -45 }, { x: 60, y: -45 }, { x: 60, y: 45 },
  { x: 54, y: 45 }, { x: 54, y: 37 }, { x: 30, y: 37 }, { x: 30, y: 45 },
  { x: -60, y: 45 },
]

export default function BaseS3() {
  return (
    <board width="120mm" height="90mm" layers={4} routeRemaining>
      {HOLES.map(([x, y], i) => (
        <hole key={i} name={`H${i + 1}`} diameter="3.2mm" pcbX={x} pcbY={y} />
      ))}
      {/* GND pours with a notch under the ESP32 antenna (x 30..54, y 37..45: from the module's last pads to the top edge) */}
      <copperpour layer="inner1" connectsTo={GND} outline={POUR_OUTLINE} />
      <copperpour layer="bottom" connectsTo={GND} outline={POUR_OUTLINE} />

      {/* ---------- logic power inputs ---------- */}
      <PluggableTerminal2 name="J_DC" nets={["net.VDC_IN", GND]} labels={["VIN", "GND"]} pcbX={-56} pcbY={20} pcbRotation={90} />
      <fuse name="F_DC" currentRating="1.1A" voltageRating="33V" footprint="1812" manufacturerPartNumber="mSMD110-33V"
        supplierPartNumbers={{ jlcpcb: ["C70119"] }} pcbX={-41} pcbY={25} connections={{ pin1: "net.VDC_IN", pin2: "net.VDC_F" }} />
      <diode name="D_TVS_DC" footprint="smb" pinLabels={{ pin1: "cathode", pin2: "anode" }} manufacturerPartNumber="SMBJ26A" supplierPartNumbers={{ jlcpcb: ["C5331110"] }}
        pcbX={-41} pcbY={19} pcbRotation={90} connections={{ cathode: "net.VDC_F", anode: GND }} />
      <Ina226Monitor id="DC" from="net.VDC_F" to="net.VDC_S" a0={GND} a1={GND} shunt="20m" pcbX={-32} pcbY={19} />
      <diode name="D_OR_DC" footprint="sma" pinLabels={{ pin1: "cathode", pin2: "anode" }} manufacturerPartNumber="SS56" supplierPartNumbers={{ jlcpcb: ["C65009"] }}
        pcbX={-24} pcbY={19} connections={{ anode: "net.VDC_S", cathode: "net.VIN" }} />

      {/* PoE plug-in: the plug-in board delivers isolated 12 V here */}
      <chip name="J_POE" footprint="jlcpcb:C158012" manufacturerPartNumber="B2B-XH-A" supplierPartNumbers={{ jlcpcb: ["C158012"] }}
        pinLabels={{ pin1: "VPOE", pin2: "GND" }} connections={{ VPOE: "net.VPOE", GND }} pcbX={-55} pcbY={6} pcbRotation={90} />
      <Ina226Monitor id="POE" from="net.VPOE" to="net.VPOE_S" a0={V33} a1={GND} shunt="20m" pcbX={-37} pcbY={6} />
      <diode name="D_OR_POE" footprint="sma" pinLabels={{ pin1: "cathode", pin2: "anode" }} manufacturerPartNumber="SS56" supplierPartNumbers={{ jlcpcb: ["C65009"] }}
        pcbX={-27} pcbY={14} connections={{ anode: "net.VPOE_S", cathode: "net.VIN" }} />

      <Buck5v vin="net.VIN" vout="net.V5" pcbX={-8} pcbY={8} />

      {/* USB VBUS joins the 5 V rail after the buck */}
      <UsbCDevice vbus="net.VBUS" dp="net.USB_DP" dn="net.USB_DN" pcbX={10} pcbY={39.3} pcbRotation={180} />
      <Ina226Monitor id="USB" from="net.VBUS" to="net.VUSB_S" a0={GND} a1={V33} shunt="20m" pcbX={10} pcbY={21} />
      <diode name="D_OR_USB" footprint="sma" pinLabels={{ pin1: "cathode", pin2: "anode" }} manufacturerPartNumber="SS56" supplierPartNumbers={{ jlcpcb: ["C65009"] }}
        pcbX={19} pcbY={21} connections={{ anode: "net.VUSB_S", cathode: "net.V5" }} />

      <Buck3v3 vin="net.V5" vout={V33} pcbX={0} pcbY={-8} />

      {/* ---------- load power input and outputs ---------- */}
      <PluggableTerminal2 name="J_LOAD1" nets={["net.VLOAD_IN", GND]} labels={["V", "GND"]} pcbX={-56} pcbY={-8} pcbRotation={90} />
      <PluggableTerminal2 name="J_LOAD2" nets={["net.VLOAD_IN", GND]} labels={["V", "GND"]} pcbX={-56} pcbY={-20} pcbRotation={90} />
      <diode name="D_TVS_LOAD" footprint="smb" pinLabels={{ pin1: "cathode", pin2: "anode" }} manufacturerPartNumber="SMBJ26A" supplierPartNumbers={{ jlcpcb: ["C5331110"] }}
        pcbX={-38} pcbY={-27} connections={{ cathode: "net.VLOAD_IN", anode: GND }} />
      <Ina226Monitor id="LOAD" from="net.VLOAD_IN" to="net.VLOAD" a0={V33} a1={V33} shunt="2m" pcbX={-38} pcbY={-14} />

      {OUTPUT_X.map((x, i) => (
        <MosfetOutput key={i} n={i + 1} drive={`net.OUT${i + 1}_DRV`} vload="net.VLOAD" x={x} y={-27} />
      ))}

      {/* ---------- MCU ---------- */}
      <Esp32S3Module
        name="U_MCU"
        pcbX={42}
        pcbY={28.2}
        connections={{
          EN: "net.EN", IO0: "net.BOOT",
          IO19: "net.USB_DN", IO20: "net.USB_DP",
          IO8: "net.SDA", IO9: "net.SCL",
          IO12: "net.SCK", IO11: "net.MOSI", IO13: "net.MISO",
          IO14: "net.ETH_CS", IO21: "net.ETH_INT", IO47: "net.ETH_RST",
          IO10: "net.EXP_CS", IO48: "net.EXP_INT",
          IO4: "net.EXP_IO_A", IO5: "net.EXP_IO_B", IO6: "net.EXP_IO_C",
          IO15: "net.OUT1_DRV", IO16: "net.OUT2_DRV", IO17: "net.OUT3_DRV", IO18: "net.OUT4_DRV",
          IO2: "net.STATUS_LED",
        }}
      />
      <capacitor name="C_MCU1" capacitance="10uF" footprint="0805" supplierPartNumbers={{ jlcpcb: ["C15850"] }}
        pcbX={26} pcbY={30} pcbRotation={90} connections={{ pin1: V33, pin2: GND }} />
      <capacitor name="C_MCU2" capacitance="100nF" {...r0603("C14663")} pcbX={28.5} pcbY={30} pcbRotation={90}
        connections={{ pin1: V33, pin2: GND }} />
      {/* EN: RC power-on reset + RESET button; IO0: BOOT button */}
      <resistor name="R_EN" resistance="10k" {...r0603("C25804")} pcbX={26} pcbY={24} connections={{ pin1: V33, pin2: "net.EN" }} />
      <capacitor name="C_EN" capacitance="1uF" {...r0603("C15849")} pcbX={26} pcbY={22} connections={{ pin1: "net.EN", pin2: GND }} />
      <resistor name="R_BOOT" resistance="10k" {...r0603("C25804")} pcbX={26} pcbY={20} connections={{ pin1: V33, pin2: "net.BOOT" }} />
      <chip name="SW_RST" footprint="jlcpcb:C318884" manufacturerPartNumber="TS-1187A-B-A-B" supplierPartNumbers={{ jlcpcb: ["C318884"] }}
        pinLabels={{ pin1: "A", pin2: "B", pin3: "C", pin4: "D" }} connections={{ A: "net.EN", D: GND }} pcbX={26} pcbY={8} />
      <chip name="SW_BOOT" footprint="jlcpcb:C318884" manufacturerPartNumber="TS-1187A-B-A-B" supplierPartNumbers={{ jlcpcb: ["C318884"] }}
        pinLabels={{ pin1: "A", pin2: "B", pin3: "C", pin4: "D" }} connections={{ A: "net.BOOT", D: GND }} pcbX={35} pcbY={8} />
      {/* status LED, I2C and expansion INT pull-ups */}
      <resistor name="R_STAT" resistance="1k" {...r0603("C21190")} pcbX={44} pcbY={12} connections={{ pin1: "net.STATUS_LED", pin2: "net.STATUS_A" }} />
      <led name="LED_STAT" color="red" footprint="0603" manufacturerPartNumber="KT-0603R" supplierPartNumbers={{ jlcpcb: ["C2286"] }}
        pcbX={47} pcbY={12} connections={{ anode: "net.STATUS_A", cathode: GND }} />
      <resistor name="R_SDA" resistance="4.7k" {...r0603("C23162")} pcbX={40} pcbY={-6} connections={{ pin1: V33, pin2: "net.SDA" }} />
      <resistor name="R_SCL" resistance="4.7k" {...r0603("C23162")} pcbX={40} pcbY={-8} connections={{ pin1: V33, pin2: "net.SCL" }} />
      <resistor name="R_INT" resistance="10k" {...r0603("C25804")} pcbX={40} pcbY={-10} connections={{ pin1: V33, pin2: "net.EXP_INT" }} />

      {/* ---------- Ethernet ---------- */}
      <W5500Ethernet
        sck="net.SCK" mosi="net.MOSI" miso="net.MISO" cs="net.ETH_CS" int="net.ETH_INT" rst="net.ETH_RST"
        pcbX={-12} pcbY={32} jackX={-40} jackY={36} jackRotation={180}
      />

      {/* ---------- expansion ---------- */}
      <ExpansionBus
        name="J_EXP"
        pcbX={54}
        pcbY={-10}
        pcbRotation={90}
        connections={{
          SDA: "net.SDA", SCL: "net.SCL", INT: "net.EXP_INT", CS: "net.EXP_CS",
          SCK: "net.SCK", MOSI: "net.MOSI", MISO: "net.MISO",
          IO_A: "net.EXP_IO_A", IO_B: "net.EXP_IO_B", IO_C: "net.EXP_IO_C",
        }}
      />
    </board>
  )
}
