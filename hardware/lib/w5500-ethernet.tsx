// 10/100 Ethernet over SPI: WIZnet W5500 (LQFP-48, JLCPCB C32843), 25 MHz
// crystal, HR911105A RJ45 with integrated magnetics and LEDs (JLCPCB C12074).
// The analog front end follows WIZnet's "W5500-Ref-RJ45WithMag" reference
// schematic: 49.9R TX pull-ups to the filtered analog 3.3 V, TX centre tap fed
// through 10R with 22nF to ground, 6.8nF series capacitors in the RX pair,
// 49.9R RX terminations to a 10nF midpoint that also takes the RX centre tap,
// ferrite bead between digital and analog 3.3 V, 1M across the crystal.
// Pin maps checked against the W5500 datasheet v1.1.0 and the HanRun
// HR911105A datasheet; see docs/research/base-s3-check-ethernet.md.
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
// analog supply for the PHY, behind the ferrite bead
const V33A = "net.V3_3A"
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
          AVDD1: V33A, AVDD2: V33A, AVDD3: V33A, AVDD4: V33A, AVDD5: V33A, AVDD6: V33A, VDD: V33,
          // pin 23 must be grounded; pins 38-42 (RSVD2-6) are NC in the current datasheet
          RSVD1: GND,
          PMODE0: V33, PMODE1: V33, PMODE2: V33,
          TXP: "net.ETH_TXP", TXN: "net.ETH_TXN", RXP: "net.ETH_RXP", RXN: "net.ETH_RXN",
          EXRES1: "net.ETH_EXRES", TOCAP: "net.ETH_TOCAP", V1V2O: "net.ETH_1V2",
          XI: "net.ETH_XI", XO: "net.ETH_XO",
          LINKLED: "net.ETH_LINKLED", ACTLED: "net.ETH_ACTLED",
          SCSN: props.cs, SCLK: props.sck, MISO: props.miso, MOSI: props.mosi, INTN: props.int, RSTN: props.rst,
        }}
      />
      {/* analog supply: ferrite bead (600R at 100 MHz) from 3.3 V, six 100nF + 10uF */}
      <chip name="FB_ETH" {...p("C1002")} manufacturerPartNumber="GZ1608D601TF"
        pcbX={x + 6} pcbY={y - 9.5} connections={{ pin1: V33, pin2: V33A }} />
      {[0, 1, 2, 3].map((i) => (
        <capacitor key={i} name={`C_ETH${i + 1}`} capacitance="100nF" {...p("C14663")}
          pcbX={x - 6 + i * 4} pcbY={y - 7} connections={{ pin1: V33A, pin2: GND }} />
      ))}
      {[0, 1].map((i) => (
        <capacitor key={i} name={`C_ETH${i + 5}`} capacitance="100nF" {...p("C14663")}
          pcbX={x - 6 + i * 4} pcbY={y - 9.5} connections={{ pin1: V33A, pin2: GND }} />
      ))}
      <capacitor name="C_ETH_BULK" capacitance="10uF" {...p("C15850", "0805")} pcbX={x + 12.5} pcbY={y - 7}
        connections={{ pin1: V33A, pin2: GND }} />
      {/* digital supply (VDD) */}
      <capacitor name="C_ETH_VDD" capacitance="100nF" {...p("C14663")} pcbX={x + 2} pcbY={y - 9.5}
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
      {/* SMD3225-4P: pads 1 and 3 are the crystal, 2 and 4 are case ground (TKD M3225 sheet) */}
      <resistor name="R_XTAL" resistance="1M" {...p("C22935")} pcbX={x + 11.5} pcbY={y + 0.5}
        pcbRotation={90} connections={{ pin1: "net.ETH_XI", pin2: "net.ETH_XO" }} />
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
        connections={{ pin1: "net.ETH_TXP", pin2: V33A }} />
      <resistor name="R_TXN" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y + 3}
        connections={{ pin1: "net.ETH_TXN", pin2: V33A }} />
      <resistor name="R_RXP" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y - 1}
        connections={{ pin1: "net.ETH_RXP", pin2: "net.ETH_RXC" }} />
      <resistor name="R_RXN" resistance="49.9" {...p("C114625")} pcbX={x - 8} pcbY={y - 3}
        connections={{ pin1: "net.ETH_RXN", pin2: "net.ETH_RXC" }} />
      {/* RX midpoint: 10nF to ground; the jack's RX centre tap joins this node */}
      <capacitor name="C_RXC" capacitance="10nF" {...p("C57112")} pcbX={x - 11} pcbY={y - 2}
        pcbRotation={90} connections={{ pin1: "net.ETH_RXC", pin2: GND }} />
      {/* RX series coupling, on the jack side of the terminations */}
      <capacitor name="C_RXP" capacitance="6.8nF" {...p("C1631")} pcbX={x - 14} pcbY={y - 1}
        connections={{ pin1: "net.ETH_RXP", pin2: "net.ETH_RDP" }} />
      <capacitor name="C_RXN" capacitance="6.8nF" {...p("C1631")} pcbX={x - 14} pcbY={y - 3}
        connections={{ pin1: "net.ETH_RXN", pin2: "net.ETH_RDN" }} />
      {/* TX centre tap: 10R from analog 3.3 V, 22nF to ground */}
      <resistor name="R_TCT" resistance="10" {...p("C22859")} pcbX={x - 14} pcbY={y + 2}
        connections={{ pin1: V33A, pin2: "net.ETH_TCT" }} />
      <capacitor name="C_TCT" capacitance="22nF" {...p("C21122")} pcbX={x - 11} pcbY={y + 2}
        pcbRotation={90} connections={{ pin1: "net.ETH_TCT", pin2: GND }} />
      {/* RJ45 with magnetics. LEDs per HanRun datasheet p.1: 9 green anode, 10 green cathode, 11 yellow cathode, 12 yellow anode */}
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
          pin9: "LEDG_A", pin10: "LEDG_K", pin11: "LEDY_K", pin12: "LEDY_A", pin13: "SH1", pin14: "SH2",
        }}
        connections={{
          TDP: "net.ETH_TXP", TDN: "net.ETH_TXN", RDP: "net.ETH_RDP", RDN: "net.ETH_RDN",
          TCT: "net.ETH_TCT", RCT: "net.ETH_RXC", CHS: GND, SH1: GND, SH2: GND,
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
