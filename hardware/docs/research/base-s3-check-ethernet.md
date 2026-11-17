# base-s3 Ethernet check: W5500 + HR911105A + 25 MHz crystal + PoE options

Checked file: `hardware/lib/w5500-ethernet.tsx`. Checked 2026-11-17/18.
Every claim below comes from a document that was opened (URL + page/figure given). Anything not opened is marked **UNVERIFIED**.

## Sources opened

| Tag | Document | URL |
|---|---|---|
| DS | WIZnet W5500 Datasheet v1.1.0 (17 Dec 2022), English, 67 pages | https://docs.wiznet.io/img/products/w5500/W5500_ds_v110e.pdf |
| REF-MAG | WIZnet "W5500-Ref-RJ45WithMag" reference schematic, 25 Sep 2015, sheet 2/2 | https://docs.wiznet.io/img/products/w5500/w5500_sch_v110_use_mag_.pdf |
| REF-EXT | WIZnet "W5500-Ref-ExternalMag" reference schematic, 25 Sep 2015, sheet 1/2 | https://docs.wiznet.io/img/products/w5500/w5500_sch_v110_use_trans_.pdf |
| HR | HanRun HR911105A datasheet, REV A/2, 4 pages (LCSC copy for C12074) | https://www.lcsc.com/datasheet/C12074.pdf |
| TKD | TKD "M3225" MHz crystal series sheet, 1 page (LCSC copy for C20612981) | https://www.lcsc.com/datasheet/C20612981.pdf |
| HR-POE | HanRun HR871150C datasheet, REV 00, 4 pages (LCSC copy for C19724786) | https://www.lcsc.com/datasheet/C19724786.pdf |
| AG | Silvertel Ag9700 datasheet V2.7, Feb 2025 | https://silvertel.com/images/datasheets/Ag9700-Datasheet-low-cost-isolated-Power-over-Ethernet-PoE-module-solution.pdf |
| DP14 | SDAPO DP1435 datasheet (LCSC copy for C5440760) | https://www.lcsc.com/datasheet/C5440760.pdf |
| DP99 | SDAPO DP9900 series datasheet, 12 pages (LCSC copy for C5380107) | https://www.lcsc.com/datasheet/C5380107.pdf |
| LCSC | LCSC product pages (stock / price as displayed on 2026-11-18) | https://www.lcsc.com/product-detail/<Cxxxx>.html |

Method note: the two WIZnet schematics are vector PDFs; they were re-rendered at high zoom and every net below was traced on the drawing. The HanRun, TKD and HR871150C sheets are drawings without a text layer and were read from the rendered pages.

---

## Summary of mismatches (most important first)

1. **Both jack LEDs are wired backwards and the colours are swapped in the labels.** They will never light. (Section 3)
2. **RX front end does not match the WIZnet reference**: the two series 6.8 nF coupling capacitors are missing, the centre capacitor value is wrong, and RCT is on its own capacitor instead of the RX termination midpoint. (Section 2)
3. **TX centre tap goes straight to 3.3 V**; the reference feeds it through 10 R with 22 nF to ground. (Section 2)
4. **HR911105A cannot supply PoE**: the cable-side centre taps and spare pairs are terminated inside the jack and are not on any pin. J_POE can only work with a different jack or an external splitter. (Sections 3 and 5)
5. **RSVD pins 38 to 42 are tied to GND**; the current datasheet says NC. Pin 23 to GND is correct. (Section 1)
6. **No 1 M resistor across the crystal**; the reference has one. Load capacitor value is acceptable but not centred. (Section 4)
7. **No ferrite bead between digital and analog 3.3 V**, and less decoupling than the reference. (Section 2)

No error was found in the 48-entry W5500 `pinLabels` map.

---

## 1. W5500 pin table (DS Figure 1 p.7, Table 2 p.8-10)

All 48 `pinLabels` entries match DS Figure 1 / Table 2:

| Pins | Datasheet | Code | Result |
|---|---|---|---|
| 1, 2 | TXN, TXP | TXN, TXP | OK |
| 3, 9, 14, 16, 19, 48 | AGND | AGND1..6 | OK |
| 4, 8, 11, 15, 17, 21 | AVDD | AVDD1..6 | OK |
| 5, 6 | RXN, RXP | RXN, RXP | OK |
| 7 | DNC | DNC (unconnected) | OK |
| 10 | EXRES1 | EXRES1 | OK |
| 12, 13, 46, 47 | NC | NC1..4 (unconnected) | OK |
| 18 | VBG | VBG (unconnected) | OK |
| 20 | TOCAP | TOCAP | OK |
| 22 | 1V2O | V1V2O | OK |
| 23 | RSVD | RSVD1 | OK |
| 24..27 | SPDLED, LINKLED, DUPLED, ACTLED | same | OK |
| 28, 29 | VDD, GND | VDD, GND | OK |
| 30, 31 | XI/CLKIN, XO | XI, XO | OK |
| 32..37 | SCSn, SCLK, MISO, MOSI, INTn, RSTn | SCSN, SCLK, MISO, MOSI, INTN, RSTN | OK |
| 38..42 | RSVD | RSVD2..6 | OK (label) |
| 43, 44, 45 | PMODE2, PMODE1, PMODE0 | same | OK |

Strap and passive connections:

| Item | Datasheet / reference | Code | Result |
|---|---|---|---|
| PMODE[2:0] | Internal pull-ups; `111` = "All capable, Auto-negotiation enabled" (DS Table 2 p.10) | all three to 3.3 V | OK |
| RSVD pin 23 | "It must be tied to GND" (DS p.9). Note REF-MAG draws it unconnected, which contradicts the datasheet; follow the datasheet | GND | OK |
| RSVD pins 38-42 | "NC", internal pull-down (DS p.10). Revision history v1.0.3: changed "from It must be tied to GND to NC (PIN38~42)". REF-MAG shows them unconnected | GND | **MISMATCH (minor)**. Leave them unconnected |
| DNC pin 7 | "Do Not Connect Pin" | unconnected | OK |
| NC 12, 13, 46, 47 | NC | unconnected | OK |
| VBG pin 18 | "Band Gap Output Voltage ... 1.2V ... It must be left floating" | unconnected | OK |
| EXRES1 | 12.4 k 1% to AGND (DS p.8, Figure 2 text p.11; REF-MAG R10) | 12.4 k to GND | OK (the 1% tolerance of LCSC C137798 was not checked: **UNVERIFIED**) |
| TOCAP | "must be connected to a 4.7uF capacitor", short trace (DS p.8; REF-MAG C18) | 4.7 uF to GND | OK |
| 1V2O | "must be connected to a 10nF capacitor" (DS p.8; REF-MAG C17) | 10 nF to GND | OK |
| SPDLED | Low = 100 Mbps, High = 10 Mbps | unused | OK |
| LINKLED | Low = link established | LED cathode side | active low confirmed |
| DUPLED | Low = full duplex | unused | OK |
| ACTLED | Low = carrier sense during TX/RX | LED cathode side | active low confirmed |
| RSTn | Internal pull-up, hold low at least 500 us | 10 k pull-up | OK |
| INTn | Active-low output | 10 k pull-up | OK |

Other datasheet facts relevant to the board:
- DS 5.5.6 p.62: "W5500 does not support auto-MDIX feature." A straight cable to a switch is fine; direct connection to another non-auto-MDIX device needs a crossover cable.
- DS 5.5.5 p.62: transformer 1:1 turns ratio, 350 uH on both sides. HR lists "OCL: 350uH Minimum" and 1CT:1CT, so the jack's magnetics meet this.

---

## 2. Analog front end vs. WIZnet reference (REF-MAG)

What REF-MAG shows, net by net (jack P1 = J1B1211CCD, an integrated-magnetics RJ45):

**Transmit**
- R1 49.9 R 1%: TXN to 3V3A. R2 49.9 R 1%: TXP to 3V3A.
- R3 10 R 1%: 3V3A to the TCT pin of the jack. C8 22 nF: TCT to GND.
- R21/R22 0 R in series with TXN/TXP, marked "Options (1) Damping resistor" (note text: "33ohm was best for EMI reduction").

**Receive**
- R23/R24 0 R in series with RXN/RXP (same option).
- R6 49.9 R 1% from RXP and R7 49.9 R 1% from RXN to a common node. Both resistors sit on the **chip side** of the coupling capacitors.
- C9 6.8 nF in **series** between RXP and jack RD+; C10 6.8 nF in **series** between RXN and jack RD-.
- Common node of R6/R7: C15 10 nF to GND, and the same node is wired to the jack's RCT pin.

**Shield / chassis**
- Jack GHs_GND (internal 1000 pF Bob-Smith return), CH_GND1 and CH_GND2 go to a separate CGND net. C16 1 nF / 2 kV joins CGND to GND. MH1/MH2 unconnected. No 1 M bleed resistor appears on this sheet.

**Supply**
- L1 ferrite bead (HH-1M1608-121JT) between 3V3D and 3V3A; note (g) asks for 100 to 2000 ohm at 100 MHz.
- 3V3A: C1..C6 6 x 0.1 uF + C7 10 uF. VDD (3V3D): C11 10 uF + C12 0.1 uF.

**LEDs**
- LED anodes (GRN+, YLW+) to 3V3D; cathodes through R8/R9 330 R to LINKLED (green) and ACTLED (yellow).

Line-by-line comparison with the code:

| Element | Reference | Code | Result and change |
|---|---|---|---|
| TX pull-ups | 49.9 R from TXP and TXN to 3V3A | R_TXP, R_TXN 49.9 R to V3_3 | OK |
| TX centre tap | TCT to 3V3A through 10 R, 22 nF to GND | `TCT: V33` direct, no capacitor | **MISMATCH.** Add R 10 R 1% from 3.3 V to a new net ETH_TCT, add 22 nF from ETH_TCT to GND, connect jack TCT to ETH_TCT |
| RX series capacitors | 6.8 nF in series in each of RXP and RXN | none; RXP/RXN go directly to the jack | **MISMATCH.** Add two 6.8 nF series capacitors between the chip-side nets and jack RD+/RD- (new nets for the jack side) |
| RX termination | 49.9 R pair on the chip side to a common node | 49.9 R pair to ETH_RXC | OK once the series capacitors are placed on the jack side of these resistors |
| RX centre capacitor | 10 nF from the common node to GND | C_RXC 6.8 nF | **MISMATCH.** Change C_RXC to 10 nF (6.8 nF belongs to the series capacitors) |
| RX centre tap | RCT tied to the R6/R7 common node | RCT on its own net with C_RCT 100 nF to GND | **MISMATCH.** Connect jack RCT to ETH_RXC and delete C_RCT |
| Series damping | 0 R positions in all four lines (33 R suggested for EMI) | none | Optional. Not needed for function |
| Shield | CGND net, 1 nF / 2 kV to GND | CHS, SH1, SH2 direct to GND | Differs from WIZnet but matches HanRun ("Notes: Connect CHS GND to PCB Ground", HR p.1). Acceptable. If PoE is added, a separate chassis net with 1 nF / 2 kV is the better choice |
| AVDD filter | Ferrite bead 3V3D to 3V3A | AVDD and VDD both on V3_3 | **MISMATCH (recommended option in reference).** Add a 120 R to 1 k @100 MHz bead feeding a V3_3A net for the six AVDD pins and the TX pull-ups / TCT |
| Decoupling | 6 x 0.1 uF + 10 uF on AVDD, 0.1 uF + 10 uF on VDD | 4 x 100 nF + 10 uF total | Short by three 100 nF and one 10 uF. Add at least two more 100 nF so each AVDD pin and VDD has one |
| LED drive | Anode to 3.3 V, 330 R in the cathode leg to the LED pin | 330 R in the anode leg, cathode direct to the LED pin | Electrically equivalent. OK in principle (but see section 3 for the pin error) |

Why the RX change matters: without the series capacitors the transformer winding ties RXP and RXN together at DC and the RCT capacitor is the only reference. This is not the circuit WIZnet characterised. Whether the code's version links reliably was not tested and no WIZnet document describes it: treat it as unvalidated.

---

## 3. HanRun HR911105A (HR p.1 schematic, p.2 mechanical, p.3 PCB layout)

Pin functions from the HR p.1 "Schematics" figure:

| Pin | HR datasheet | Code label | Result |
|---|---|---|---|
| P1 | TD+ | TDP | OK |
| P2 | TD- | TDN | OK |
| P3 | RD+ | RDP | OK |
| P4 | TX transformer chip-side centre tap | TCT | OK |
| P5 | RX transformer chip-side centre tap | RCT | OK |
| P6 | RD- | RDN | OK |
| P7 | NC | NC | OK |
| P8 | CHS GND (through internal 1000 pF 2 kV to the 4 x 75 R network) | CHS | OK |
| 9 | **Green LED anode** | LEDY_K | **WRONG** (colour and polarity) |
| 10 | **Green LED cathode** | LEDY_A | **WRONG** |
| 11 | **Yellow LED cathode** | LEDG_A | **WRONG** |
| 12 | **Yellow LED anode** | LEDG_K | **WRONG** |
| shield tabs | Two 1.63 mm shield posts on the PCB layout (HR p.3); the datasheet gives them no pin numbers | SH1, SH2 (pin13, pin14) to GND | Function OK. The pin13/pin14 numbering comes from the footprint, not from HanRun: **UNVERIFIED** against the JLC footprint |

LED detail (HR p.1, read at 320% zoom): in both LED symbols the triangle base is on the first-listed pin and the bar on the loop back to the second pin. Green: 9 = anode, 10 = cathode. Yellow: 12 = anode, 11 = cathode. HR p.2 front view: "Left LED = Green LED", "Right LED = Yellow LED" (front view with the contacts at the top, P1 at left, P8 at right). Both LEDs: 20 mA forward current, 1.8 to 2.8 V forward voltage.

Effect in the current code:
- R_LEDY ties pin 10 (green cathode) to 3.3 V and ACTLED drives pin 9 (green anode): reverse biased.
- R_LEDG ties pin 11 (yellow cathode) to 3.3 V and LINKLED drives pin 12 (yellow anode): reverse biased.
- Neither LED can light.

Fix (keeps green = link, yellow = activity, as in REF-MAG):

```
pin9: "LEDG_A", pin10: "LEDG_K", pin11: "LEDY_K", pin12: "LEDY_A"
```

The existing `connections` block then works unchanged (LEDG_A through 330 R to 3.3 V, LEDG_K to LINKLED, LEDY_A through 330 R to 3.3 V, LEDY_K to ACTLED). With 330 R the LED current is roughly (3.3 - 2.0) / 330 = 4 mA, inside the 20 mA rating.

PoE: HR p.1 shows the cable-side centre taps of both transformers and the spare pairs (J4+J5, J7+J8) each going to an internal 75 R resistor, with all four resistors joined at the 1000 pF 2 kV capacitor to P8. None of these nodes has a pin. **HR911105A cannot deliver PoE power to the board.** The belief in the task is confirmed.

Other HR data: isolation 1500 Vrms; operating temperature 0 to +70 C; PCB layout has 8 signal holes (0.89 mm), 4 LED holes (1.02 mm), two 3.25 mm pegs, two 1.63 mm shield holes.

---

## 4. Crystal (TKD sheet; DS 5.5.3 p.60; REF-MAG)

Pad numbering (TKD "Pin Connect" table and connection drawing): **#1 and #3 = Crystal, #2 and #4 = GND**. The code (`pin1: XI, pin2: GND1, pin3: XO, pin4: GND2`) is correct. REF-MAG draws Y1 the same way (1 and 3 crystal, 2 and 4 to GND).

Load capacitance of this exact part:
- The TKD sheet is a series sheet. It lists load capacitance as "6pF, 10pF, 12pF, 16pF (customisable)" and does not decode the part number.
- The LCSC product page for C20612981 lists SX32Y025000BC1T001 as 25 MHz, **12 pF**, +/-10 ppm, -40 to +85 C.
- So 12 pF is confirmed by the distributor listing only. A manufacturer document tying "BC1T001" to 12 pF was not found: **UNVERIFIED at manufacturer level**.

Other TKD series values: frequency tolerance +/-10 ppm at 25 C, stability +/-10 ppm over temperature (customisable), C0 3 pF max, drive level 100 uW typical, ESR 60 R max for 19.5 to 27 MHz, ageing +/-3 ppm/year.

W5500 requirements (DS 5.5.3): 25 MHz, +/-30 ppm at 25 C, shunt capacitance 7 pF max, drive level 59.12 uW, **load capacitance 18 pF**, ageing +/-3 ppm/year max.

Assessment:
- Tolerance (+/-10 ppm) and C0 (3 pF) are inside the W5500 limits.
- The datasheet names an 18 pF-CL crystal; this part is 12 pF. That is a different crystal from the one WIZnet specifies, though REF-MAG itself uses 18 pF capacitors, which give about 12 to 14 pF at the crystal, not 18 pF. WIZnet's two documents are inconsistent with each other on this point.
- With 18 pF capacitors: CL = 18/2 + stray = 9 pF + stray. With 3 to 5 pF of stray the crystal sees 12 to 14 pF. That is on target to slightly high for a 12 pF crystal, which pulls the frequency slightly low. The pulling sensitivity of this part is not in the TKD sheet (**UNVERIFIED**), so the exact ppm error cannot be stated.
- 18 pF is acceptable. 15 pF would centre better if the board stray is nearer 4 to 5 pF (7.5 + 4.5 = 12 pF). No change is required; 15 pF is the lower-risk value.
- The TKD drive level (100 uW typical) is above the 59.12 uW the W5500 sheet lists. Whether the W5500 figure is a requirement on the crystal or the level the oscillator delivers is not stated: **UNVERIFIED**.

Reference differences:
- REF-MAG has **R4 1 M across XI and XO** and R5 0 R in series between XO and the crystal. The code has neither. Add a 1 M resistor between ETH_XI and ETH_XO; a series position is optional.
- DS Figure 3 ("Crystal reference schematic", p.11) is an image and was not inspected: **UNVERIFIED**. The statement above rests on REF-MAG only.

LCSC C20612981: 80,930 in stock; 5+ $0.0818, 50+ $0.0644, 500+ $0.0492.

---

## 5. PoE options

The fact that drives everything: a PD needs the cable-side centre taps of the two data pairs and the two spare pairs. HR911105A exposes none of them (section 3). A 2-pin J_POE "isolated 12 V" header can only be fed by a module that has already been given those four jack signals, so the module cannot simply plug into two pins.

### (a) PoE-capable jack

**HanRun HR871150C, LCSC C19724786** ("Single Port RJ45 Connector with Integrated Magnetics and LED for 10/100Base-T PoE application"), HR-POE p.1 and p.3:

| Pin | Function (HR-POE p.1 schematic) |
|---|---|
| P1, P2 | Chip-side pair of the transformer wired to J1/J2 (cable pins 1, 2) |
| P3 | Chip-side centre tap, **common to both transformers** |
| P4, P5 | Chip-side pair of the transformer wired to J3/J6 (cable pins 3, 6) |
| P7 (VC1+) | Cable-side centre tap of the J1/J2 pair |
| P8 (VC1-) | Cable-side centre tap of the J3/J6 pair |
| P9 (VC2+) | Spare pair J4 + J5 |
| P10 (VC2-) | Spare pair J7 + J8 |
| SHIELD | Through internal 1000 pF 2 kV to the 4 x (22 nF 100 Vdc + 75 R) network |
| 11, 12 | Yellow LED, 11 = anode, 12 = cathode |
| 13, 14 | Green LED, 13 = anode, 14 = cathode |

There is no pin 6. Which of P1/P2 and P4/P5 is the + line is not labelled on the sheet and the trace was read from a small figure: **check against the footprint before layout**.

Footprint vs. HR911105A (HR p.3 against HR-POE p.3): same body family. Peg spacing 11.43 mm, LED pin spacing 13.25 mm / 2.54 mm, shield post spacing 15.49 mm and the 3.25 mm / 1.63 mm / 1.02 mm hole sizes are the same on both drawings. The signal row is **different**: 9 holes on a 1.27 mm stagger with pin 5 near the centreline instead of 8 holes, different numbering, LED pins renumbered 11 to 14, and row-to-peg dimensions differ slightly (10.40 / 4.08 mm vs 10.68 / 4.90 mm). It is not a drop-in: new footprint and re-route of the jack area.

Design consequence: one common chip-side centre tap. It must go to 3.3 V (via the 10 R + 22 nF of the reference) for the TX drivers, so the RX side must use the reference's series 6.8 nF capacitors (section 2 change) with the RX midpoint left on its 10 nF only.

Stock and price (LCSC page, 2026-11-18): **Out of Stock**. 1+ $2.1501, 10+ $1.8094, 87+ $1.3794. JLCPCB part page lists it as Extended, wave soldering; JLCPCB stock quantity not shown: **UNVERIFIED**.

Other candidates seen but not verified:
- HanRun HR953192A, LCSC C19724794: listed as "1x1 Port Tab upright RJ45 ... 10/100Base-TX PoE application". 47 in stock, 1+ $2.2212, 10+ $1.8794. Vertical (upright) jack, so a different mechanical arrangement. Datasheet not opened: pinout **UNVERIFIED**.
- HanRun HR911130A (C54408), HR911131A (C5184934), HR911130C (C50933): listed by LCSC/JLCPCB without a PoE attribute (search results only). Datasheets not opened: **UNVERIFIED**, and no evidence they expose centre taps.
- HanRun HR861153C: no LCSC listing found.
- Abracon ARJP11A-MASA-B-A-EMU2, LCSC C6125670: listing mentions PoE. Datasheet not opened: **UNVERIFIED**.

### (b) 802.3af PD modules for the plug-in position

| Module | Source | Output | Input pins needed from the jack | Bridges | Stock / price |
|---|---|---|---|---|---|
| SDAPO DP1435-12V (LCSC C5440760, listed as "DP1435") | DP14 | 12 V, 1 A typ / 1.2 A max, 13 W at 25 C, 1.5 kV isolation, input 37 to 57 V | Pin 1 VA1, 2 VA2 (centre taps of the pairs on RJ45 pins 1&2 and 3&6), 3 VB1 (pins 4&5), 4 VB2 (pins 7&8), 5 GND, 6 VOUT | Built in (2 channels) | 13 in stock; 1+ $5.2154, 10+ $4.3916, 90+ $3.4068. The LCSC listing does not state the output voltage; DP14 shows the 12 V variant but confirm the variant before ordering |
| SDAPO DP9900LP-12V (LCSC C5380107) | DP99 | 12 V, 12.95 W class, 1500 V DC isolation, input 36 to 57 V | Pins: +VDC, -VDC, ADJ, VIN+, VIN-. **No VA/VB pins**: VIN+/VIN- are the outputs of external bridge rectifiers | External: two bridges needed on the board | 25 in stock; 1+ $6.7756, 10+ $5.7252, 63+ $5.0867 |
| Silvertel Ag9712-2BR | AG Table 1, Table 3 | 12.0 V, 12 W, 1500 V isolation, input 36 to 57 V, 10-pin SIL | Pin 1 VA1, 2 VA2, 3 VB1, 4 VB2, 7 -VDC, 8 +VDC, 9 ADJ; 5 and 10 internal, 6 NC | Built in | Not looked up at LCSC/JLCPCB: **UNVERIFIED**. Distributor listings exist at Farnell/Mouser (search results only) |
| Silvertel Ag9712-S | AG Table 1, Table 2 | 12.0 V, 12 W | Pins 1/3 VIN+, 2/4 VIN-, 7 -VDC, 8 +VDC, 9 ADJ | External | **UNVERIFIED** availability |

Silvertel notes (AG): output capacitor C1 of at least 470 uF "must be fitted for output stability"; a minimum load is specified (200 mA row in the DC characteristics table; which variants it applies to was not checked). VA/VB inputs are not polarity sensitive on the bridged versions.

Board impact for any of these with a PoE jack: the plug-in connector grows from 2 pins to 6 (VA1, VA2, VB1, VB2, +12 V, 0 V), or the module is soldered in directly. The four input nets carry up to 57 V and sit on the cable side of the isolation barrier; AG section 5 asks for at least 3 mm clearance across the barrier.

### (c) External splitter (no board change)

An external 802.3af splitter delivers data on an RJ45 and 12 V on a barrel plug; the board keeps HR911105A and J_POE is fed from the splitter's 12 V lead. No specific splitter was researched and no datasheet was opened, so price and isolation are **UNVERIFIED**. Check that the chosen splitter is an isolated 802.3af type and gives 12 V, not a passive injector pair.

### Cost and board impact

| Option | Added parts cost (qty 10, LCSC figures above) | Board change | Risk |
|---|---|---|---|
| (c) External splitter | Splitter price **UNVERIFIED**; board BOM unchanged | None | Extra box and cable per unit |
| (a) + DP1435-12V | Jack +$0.49 over HR911105A ($1.81 vs $1.32) plus module $4.39 = about +$4.90 | New jack footprint, 6-pin module position, 4 high-voltage nets, isolation clearance, RX series capacitors | HR871150C is out of stock at LCSC today; only 13 modules in stock |
| (a) + Ag9712-2BR | Jack as above; module price **UNVERIFIED** | Same as above plus 470 uF output capacitor | Not confirmed as an LCSC/JLCPCB part |
| (a) + DP9900LP-12V | Jack as above plus $5.73 plus two bridge rectifiers | As above plus two bridges on board | Most parts, least attractive |

HR911105A reference price (LCSC C12074): over 34,000 in stock; 1+ $1.5212, 10+ $1.3212, 93+ $1.0002.

---

## Exact changes to `w5500-ethernet.tsx`

Required:
1. Jack `pinLabels`: `pin9: "LEDG_A", pin10: "LEDG_K", pin11: "LEDY_K", pin12: "LEDY_A"`.
2. Add two 6.8 nF series capacitors: ETH_RXP to a new jack-side net for RDP, ETH_RXN to a new jack-side net for RDN. Keep R_RXP / R_RXN on the chip-side nets.
3. C_RXC: 6.8 nF to 10 nF.
4. Jack `RCT` to `net.ETH_RXC`; delete C_RCT.
5. Jack `TCT` to a new net fed from 3.3 V through 10 R 1%, with 22 nF to GND.

Recommended:
6. Remove the GND connections on RSVD2..RSVD6 (pins 38 to 42). Keep RSVD1 (pin 23) at GND.
7. Add 1 M across ETH_XI / ETH_XO.
8. Add a ferrite bead (120 R to 1 k at 100 MHz) feeding an analog 3.3 V net for AVDD1..6, R_TXP, R_TXN and the TCT feed; add two more 100 nF.
9. Update the header comment: the 6.8 nF parts are series RX coupling capacitors, the RX centre capacitor is 10 nF, and TCT is fed through 10 R + 22 nF.

Optional: 15 pF load capacitors instead of 18 pF; 0 R / 33 R series positions in the four MDI lines; separate chassis net with 1 nF / 2 kV.

## Not verified

- DS Figure 2 and Figure 3 (images) were not inspected; the text and REF-MAG were used instead.
- Manufacturer confirmation that SX32Y025000BC1T001 is the 12 pF variant (LCSC listing only).
- LCSC part numbers of the passives in the code (values, tolerances, voltage ratings) were not checked.
- The jlcpcb:C12074 footprint's pad numbering against HR p.3, including which pads are 13/14.
- JLCPCB (as opposed to LCSC) stock for every part.
- All items marked UNVERIFIED in section 5.
