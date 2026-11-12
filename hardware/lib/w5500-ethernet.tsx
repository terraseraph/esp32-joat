// 10/100 Ethernet over SPI: WIZnet W5500 (LQFP-48, JLCPCB C32843), 25 MHz
// crystal, HR911105A RJ45 with integrated magnetics and LEDs (JLCPCB C12074).
// The analog front end (49.9R terminations, 6.8nF RX centre, TX centre tap to
// 3.3 V) follows the usual W5500 + magjack arrangement but has not been
// checked line by line against the WIZnet reference schematic.
export type W5500EthernetProps = {
  sck: string
  mosi: string
  miso: string
  cs: string
  int: string
  rst: string
  pcbX: number
  pcbY: number
  /** RJ45 position (absolute) */
  jackX: number
  jackY: number
  jackRotation?: number
}

const p = (lcsc: string, footprint = "0603") => ({ footprint, supplierPartNumbers: { jlcpcb: [lcsc] } })
const V33 = "net.V3_3"
const GND = "net.GND"

export const W5500Ethernet = (props: W5500EthernetProps) => {
  const { pcbX: x, pcbY: y } = props
  return (
    <>
      <chip
        name="U_ETH"
        footprint="lqfp48"
        manufacturerPartNumber="W5500"
        supplierPartNumbers={{ jlcpcb: ["C32843"] }}
        pcbX={x}
        pcbY={y}
        pinLabels={{
          pin1: "TXN", pin2: "TXP", pin3: "AGND1", pin4: "AVDD1", pin5: "RXN", pin6: "RXP", pin7: "DNC",
          pin8: "AVDD2", pin9: "AGND2", pin10: "EXRES1", pin11: "AVDD3", pin12: "NC1", pin13: "NC2",
          pin14: "AGND3", pin15: "AVDD4", pin16: "AGND4", pin17: "AVDD5", pin18: "VBG", pin19: "AGND5",
          pin20: "TOCAP", pin21: "AVDD6", pin22: "V1V2O", pin23: "RSVD1", pin24: "SPDLED", pin25: "LINKLED",
          pin26: "DUPLED", pin27: "ACTLED", pin28: "VDD", pin29: "GND", pin30: "XI", pin31: "XO",
          pin32: "SCSN", pin33: "SCLK", pin34: "MISO", pin35: "MOSI", pin36: "INTN", pin37: "RSTN",
          pin38: "RSVD2", pin39: "RSVD3", pin40: "RSVD4", pin41: "RSVD5", pin42: "RSVD6",
          pin43: "PMODE2", pin44: "PMODE1", pin45: "PMODE0", pin46: "NC3", pin47: "NC4", pin48: "AGND6",
        }}
        pinAttributes={{ VDD: { requiresPower: true }, GND: { requiresGround: true } }}
        connections={{
          AGND1: GND, AGND2: GND, AGND3: GND, AGND4: GND, AGND5: GND, AGND6: GND, GND: GND,
          AVDD1: V33, AVDD2: V33, AVDD3: V33, AVDD4: V33, AVDD5: V33, AVDD6: V33, VDD: V33,
          RSVD1: GND, RSVD2: GND, RSVD3: GND, RSVD4: GND, RSVD5: GND, RSVD6: GND,
          PMODE0: V33, PMODE1: V33, PMODE2: V33,
          TXP: "net.ETH_TXP", TXN: "net.ETH_TXN", RXP: "net.ETH_RXP", RXN: "net.ETH_RXN",
          EXRES1: "net.ETH_EXRES", TOCAP: "net.ETH_TOCAP", V1V2O: "net.ETH_1V2",
          XI: "net.ETH_XI", XO: "net.ETH_XO",
          LINKLED: "net.ETH_LINKLED", ACTLED: "net.ETH_ACTLED",
          SCSN: props.cs, SCLK: props.sck, MISO: props.miso, MOSI: props.mosi, INTN: props.int, RSTN: props.rst,
        }}
      />
      {/* supply decoupling */}
      {[0, 1, 2, 3].map((i) => (
        <capacitor key={i} name={`C_ETH${i + 1}`} capacitance="100nF" {...p("C14663")}
          pcbX={x - 6 + i * 4} pcbY={y - 7} connections={{ pin1: V33, pin2: GND }} />
      ))}
      <capacitor name="C_ETH_BULK" capacitance="10uF" {...p("C15850", "0805")} pcbX={x + 12.5} pcbY={y - 7}
        connections={{ pin1: V33, pin2: GND }} />
      <capacitor name="C_TOCAP" capacitance="4.7uF" {...p("C19666")} pcbX={x + 7.5} pcbY={y - 4.5}
        pcbRotation={90} connections={{ pin1: "net.ETH_TOCAP", pin2: GND }} />
      <capacitor name="C_1V2" capacitance="10nF" {...p("C57112")} pcbX={x + 9.5} pcbY={y - 4.5}
        pcbRotation={90} connections={{ pin1: "net.ETH_1V2", pin2: GND }} />
      <resistor name="R_EXRES" resistance="12.4k" {...p("C137798")} pcbX={x - 10} pcbY={y - 7}
        pcbRotation={90} connections={{ pin1: "net.ETH_EXRES", pin2: GND }} />
      {/* reset and interrupt pull-ups */}
      <resistor name="R_ETH_RST" resistance="10k" {...p("C25804")} pcbX={x - 1} pcbY={y + 9}
        pcbRotation={90} connections={{ pin1: props.rst, pin2: V33 }} />
      <resistor name="R_ETH_INT" resistance="10k" {...p("C25804")} pcbX={x + 2} pcbY={y + 9}
        pcbRotation={90} connections={{ pin1: props.int, pin2: V33 }} />
      {/* 25 MHz crystal, 12 pF load */}
      {/* SMD3225-4P: pads 1 and 3 are the crystal, 2 and 4 are case ground */}
      <chip name="Y_ETH" footprint="jlcpcb:C20612981"
        manufacturerPartNumber="SX32Y025000BC1T001" supplierPartNumbers={{ jlcpcb: ["C20612981"] }}
        pcbX={x + 8.5} pcbY={y + 0.5}
        pinLabels={{ pin1: "XI", pin2: "GND1", pin3: "XO", pin4: "GND2" }}
        connections={{ XI: "net.ETH_XI", XO: "net.ETH_XO", GND1: GND, GND2: GND }} />
      <capacitor name="C_XI" capacitance="18pF" {...p("C1647")} pcbX={x + 8.5} pcbY={y - 2}
        connections={{ pin1: "net.ETH_XI", pin2: GND }} />
      <capacitor name="C_XO" capacitance="18pF" {...p("C1647")} pcbX={x + 8.5} pcbY={y + 3.2}
        connections={{ pin1: "net.ETH_XO", pin2: GND }} />
      {/* line terminations */}
      <resistor name="R_TXP" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y + 1}
        connections={{ pin1: "net.ETH_TXP", pin2: V33 }} />
      <resistor name="R_TXN" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y + 3}
        connections={{ pin1: "net.ETH_TXN", pin2: V33 }} />
      <resistor name="R_RXP" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y - 1}
        connections={{ pin1: "net.ETH_RXP", pin2: "net.ETH_RXC" }} />
      <resistor name="R_RXN" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y - 3}
        connections={{ pin1: "net.ETH_RXN", pin2: "net.ETH_RXC" }} />
      <capacitor name="C_RXC" capacitance="6.8nF" {...p("C1631")} pcbX={x - 11} pcbY={y - 2}
        pcbRotation={90} connections={{ pin1: "net.ETH_RXC", pin2: GND }} />
      <capacitor name="C_RCT" capacitance="100nF" {...p("C14663")} pcbX={x - 11} pcbY={y + 2}
        pcbRotation={90} connections={{ pin1: "net.ETH_RCT", pin2: GND }} />
      {/* RJ45 with magnetics; LED pin polarity per EasyEDA symbol, to verify */}
      <chip
        name="J_ETH"
        footprint="jlcpcb:C12074"
        manufacturerPartNumber="HR911105A"
        supplierPartNumbers={{ jlcpcb: ["C12074"] }}
        pcbX={props.jackX}
        pcbY={props.jackY}
        pcbRotation={props.jackRotation ?? 0}
        pinLabels={{
          pin1: "TDP", pin2: "TDN", pin3: "RDP", pin4: "TCT", pin5: "RCT", pin6: "RDN", pin7: "NC", pin8: "CHS",
          pin9: "LEDY_K", pin10: "LEDY_A", pin11: "LEDG_A", pin12: "LEDG_K", pin13: "SH1", pin14: "SH2",
        }}
        connections={{
          TDP: "net.ETH_TXP", TDN: "net.ETH_TXN", RDP: "net.ETH_RXP", RDN: "net.ETH_RXN",
          TCT: V33, RCT: "net.ETH_RCT", CHS: GND, SH1: GND, SH2: GND,
          LEDY_A: "net.ETH_LEDY_A", LEDY_K: "net.ETH_ACTLED", LEDG_A: "net.ETH_LEDG_A", LEDG_K: "net.ETH_LINKLED",
        }}
      />
      <resistor name="R_LEDY" resistance="330" {...p("C23138")} pcbX={props.jackX + 12.5} pcbY={props.jackY + 4}
        connections={{ pin1: "net.ETH_LEDY_A", pin2: V33 }} />
      <resistor name="R_LEDG" resistance="330" {...p("C23138")} pcbX={props.jackX + 12.5} pcbY={props.jackY + 6}
        connections={{ pin1: "net.ETH_LEDG_A", pin2: V33 }} />
    </>
  )
}
