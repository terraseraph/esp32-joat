# base-s3 check: low-side MOSFET output (AON6354), SS56, SMBJ26A

Checked 2026-11-17 against `hardware/lib/mosfet-output.tsx` and `hardware/lib/power-footprints.tsx`.

Rule used: every number below was read from a datasheet opened during this check (URL + page/figure given). Anything else is marked **UNVERIFIED** or **ESTIMATE**. Values "read off a curve" are typical-device curves read by eye from a small plot, so treat them as +/-20 %.

## Verdict

**AON6354 driven directly from a 3.3 V GPIO is not trustworthy for 5 A.** It is a 4.5 V / 10 V gate-drive part. The datasheet guarantees nothing below Vgs = 4.5 V, the typical gate plateau sits at about 3 V, and a part at the top of the threshold spread (2.2 V) driven at 3.0-3.3 V can be current-limited below 5 A, at which point it leaves the switch region and dissipates watts to tens of watts. The pinout and the footprint pin assignment are correct; the part choice / drive voltage is the problem.

Second finding: the SMBJ26A cannot protect a 30 V FET. It does not start conducting until 28.9-31.9 V and clamps at 42.1 V.

Fix options, in order of robustness:

1. Add a 5 V low-side gate driver and move to a 40 V FET (AON6144 or similar). Fully specified, lowest loss, PWM-capable.
2. Drop-in swap to a FET that is specified at Vgs <= 3 V (WSD3042DN56 or CSD17307Q5A). Both are 30 V only and run 0.4-0.65 W per channel at 5 A, so they need more drain copper / thermal vias and the 30 V vs TVS issue remains.

No 40 V, DFN5x6, in-stock part with Rds(on) specified at 2.5 V was found.

## 1. AON6354

Source: Alpha & Omega AON6354 datasheet Rev 2.0, September 2017, https://www.aosmd.com/res/data_sheets/AON6354.pdf (6 pages). LCSC C404363, https://www.lcsc.com/product-detail/C404363.html

### Ratings and table values

| Parameter | Value | Where |
|---|---|---|
| Vds max | 30 V | p1 Absolute Maximum Ratings |
| Vds spike, 10 us | 36 V | p1 |
| Vgs max | +/-20 V | p1 |
| Id, Tc = 25 / 100 C | 83 / 52 A | p1 |
| Idsm, Ta = 25 / 70 C | 33 / 26 A | p1 (board-mounted, RthJA t<=10 s basis, note A) |
| Idm pulsed | 205 A | p1 |
| Ias / Eas (L = 0.01 mH) | 64 A / 20 mJ | p1 |
| Pd, Tc = 25 / 100 C | 36 / 14 W | p1 |
| Pdsm, Ta = 25 / 70 C | 5.6 / 3.6 W | p1 |
| RthJA t<=10 s | 18 typ / 22 max C/W | p1, 1 in2 2 oz FR-4, still air (note A) |
| RthJA steady state | 40 typ / 55 max C/W | p1, same board |
| RthJC | 2.8 typ / 3.5 max C/W | p1 |
| Vgs(th), Vds = Vgs, Id = 250 uA | 1.4 min / 1.8 typ / 2.2 max V | p2 |
| Rds(on), Vgs = 10 V, Id = 20 A | 2.75 typ / 3.3 max mOhm | p2 |
| Rds(on), Vgs = 10 V, Tj = 125 C | 3.6 typ / 4.4 max mOhm | p2 |
| Rds(on), Vgs = 4.5 V, Id = 20 A | 4 typ / 5.2 max mOhm | p2 |
| gfs, Vds = 5 V, Id = 20 A | 100 S typ | p2 |
| Ciss / Coss / Crss | 1330 / 360 / 55 pF typ | p2 |
| Rg | 0.7 / 1.5 / 2.3 Ohm | p2 |
| Qg (10 V) | 20 typ / 35 max nC | p2 |
| Qg (4.5 V) | 10 typ / 18 max nC | p2 |
| Qgs / Qgd | 3.5 / 3.5 nC typ | p2 |

**Rds(on) is specified at exactly two gate voltages: 10 V and 4.5 V. There is no 2.5 V or 3.3 V row.** The SOA plot (p4, Figure 9) is also captioned "VGS > or equal to 4.5V".

### What the curves show near 3.3 V (typical device, p3 and p4)

- Figure 1, on-region: curves are drawn for Vgs = 3 V, 3.5 V, 4.5 V, 10 V. At Vgs = 3 V the typical device saturates: about 13 A at Vds = 1 V, about 26 A at Vds = 5 V. At 5 A the 3 V curve sits at roughly Vds 0.1 V, i.e. on the order of 15-25 mOhm (coarse reading). At 3.5 V it is far better (about 55 A at Vds = 1 V).
- Figure 2, transfer (Vds = 5 V): at 25 C the typical device conducts essentially nothing below about 2.5 V, about 5 A at 2.7 V, about 20 A at 3.0 V, about 55-60 A at 3.3 V. The 125 C curve sits roughly 0.1-0.2 V to the left at low current.
- Figure 5, Rds(on) vs Vgs at Id = 20 A: the x-axis starts at 2 V but both curves leave the top of the plot (10 mOhm) at about Vgs = 3.3 V. Nothing is plotted below that. At 3.5 V the 25 C curve reads about 7 mOhm; at 4 V about 4.5 mOhm. So at 3.3 V a typical part is already above 10 mOhm and on a near-vertical slope.
- Figure 7, gate charge (Vds = 15 V, Id = 20 A): the Miller plateau is at about 3 V. A 3.3 V drive is only about 0.3 V above the typical plateau.
- Figure 4, Rds(on) vs temperature: about x1.3 at 125 C, about x1.5 at 150 C.

### Worst-case reasoning

Vgs(th) max is 0.4 V above typical. Shifting the typical curves by that amount:

- 3.3 V on a max-threshold part behaves like about 2.9 V on the typical curves: saturation current on the order of 15 A (Figure 2). 5 A still flows, but the device is barely enhanced and Rds is far above anything the datasheet states.
- 3.0 V at the gate (rail tolerance, GPIO droop) on a max-threshold part behaves like about 2.6 V typical: a few amps at most (Figure 2, 25 C). The FET then cannot carry 5 A as a switch. With a 24 V supply and a load that wants 5 A it sits in linear mode with volts across it. Cold makes this worse (the 25 C curve is to the right of the 125 C curve).

This is an extrapolation of typical curves, not a guaranteed limit. That is the point: there is no guaranteed limit at this gate voltage.

ESP32-S3 GPIO output-high level under load: **UNVERIFIED** (Espressif datasheet not opened in this check). The gate itself draws only the 100 k pull-down current, so droop comes from the 3.3 V rail tolerance more than from the pin.

### Dissipation at 5 A

| Case | Rds used | P = I^2 R | Basis |
|---|---|---|---|
| Driven at >= 4.5 V, hot | 5.2 mOhm max x 1.5 = 7.8 mOhm | 0.20 W | p2 table, Figure 4 |
| Driven at 10 V, 125 C | 4.4 mOhm max | 0.11 W | p2 table |
| 3.3 V, typical part, 25 C | > 10 mOhm | > 0.25 W | Figure 5, lower bound only |
| 3.0 V, typical part, 25 C | roughly 15-25 mOhm | roughly 0.4-0.6 W | Figure 1, coarse reading |
| 3.0-3.3 V, max-threshold part | not bounded | not bounded | no datasheet data |

Thermal: the only board figure in the datasheet is RthJA 55 C/W max steady state on 1 in2 of 2 oz copper. With modest copper and no thermal vias the real number will be higher; 60-90 C/W is an **ESTIMATE**, not a datasheet value.

- At 0.2 W (properly driven) the rise is about 11-18 C. Acceptable without thermal vias.
- At 0.5 W it is about 30-45 C per channel, with four channels side by side. Tolerable but not comfortable.
- The unbounded case is the one that matters, and no amount of copper fixes it.

### PWM

With 100 Ohm and a plateau near 2.7-3.0 V, gate current during turn-on is only (3.3 - 2.7..3.0) / 100 = 3-6 mA, so the 3.5 nC Qgd takes roughly 0.6-1.2 us; turn-off is faster (about 27-30 mA). Switching energy at 24 V, 5 A is then on the order of 40-80 uJ per cycle: negligible at 1 kHz (under 0.1 W), about 1 W or more at 20 kHz. These are derived estimates from Qgd (p2) and Figure 7. On a max-threshold part the plateau can be at or above the drive voltage and the transition may never complete.

### Pinout vs footprint

Datasheet p1, DFN5x6 Top View: pins 1, 2, 3 = S; pin 4 = G; pins 5, 6, 7, 8 = D. Pin 1 is opposite pin 8, pin 4 opposite pin 5. The bottom view shows the large exposed pad joined to the 5-8 (drain) side.

- `DfnFet5x6Footprint`: pins 1-4 along the bottom row left to right, pins 5-8 along the top row right to left (pin 5 above pin 4, pin 8 above pin 1), pad 9 offset +0.8 mm toward the 5-8 row. Matches the datasheet numbering and the drain tab side.
- `mosfet-output.tsx`: pin1-3 = S1-S3 to GND, pin4 = G to gate net, pin5-9 = D1-D5 to the switched net. Matches.

**Pin assignment: confirmed correct.**

Pad dimensions (0.6 x 1.0 mm leads, 1.27 mm pitch, rows at +/-2.92 mm, 4.2 x 3.5 mm tab) against the AOS DFN5x6 recommended land pattern: **UNVERIFIED**. The AON6354 datasheet contains no land pattern, the AOS package document was not opened, and the EasyEDA component API returned HTTP 403.

## 2. Replacements

Stock, price and Basic/Extended below come from the JLCPCB parts index mirror at jlcsearch.tscircuit.com, read 2026-11-17 (the lcsc.com product pages did not expose stock or price to the fetcher). All parts listed are **Extended** (`is_basic = false`). Recheck stock before ordering.

For reference, AON6354 C404363: stock 8334, about $0.27.

### 2a. Specified at Vgs <= 3 V, same footprint (drop-in)

Only two in-stock parts qualified. Both are 30 V.

| | WSD3042DN56 (Winsok) | CSD17307Q5A (TI) |
|---|---|---|
| LCSC | C148392 | C139362 |
| Parts page | https://www.lcsc.com/product-detail/C148392.html | https://www.lcsc.com/product-detail/C139362.html |
| Datasheet opened | https://www.lcsc.com/datasheet/C148392.pdf (Dec 2014, 8 p) | https://www.lcsc.com/datasheet/C139362.pdf (SLPS252A, Jul 2010) |
| Stock / price | 6031 / about $0.30 | 2367 / about $0.58 |
| Vds | 30 V (34 V transient, 100 ns) p1-2 | 30 V p1 |
| Vgs max | +/-12 V p1 | +10 / -8 V p1 |
| Vgs(th) min/typ/max | 0.5 / 0.85 / 1.3 V p2 | 0.9 / 1.3 / 1.8 V p2 |
| Rds(on) lowest spec point | **2.5 V, 5 A: 12 typ / 16 max mOhm** p2 | **3 V, 11 A: 12.8 typ / 17.3 max mOhm** p2 |
| Rds(on) 4.5 V | 9.6 typ / 12 max mOhm (7 A) | 9.7 typ / 12.1 max mOhm (11 A) |
| Rds(on) high drive | 10 V: 9 typ / 10.8 max mOhm | 8 V: 8.4 typ / 10.5 max mOhm |
| Id | 40 A (Tc 25 C); 9 / 7 A (Ta 25 / 70 C) p1 | 73 A (Tc 25 C); 14 A board-mounted p1 |
| RthJA | 84 C/W steady, 34 C/W t<=10 s, 1 in2 2 oz p1 | 41 C/W typ, 1 in2 2 oz p1 note 1 |
| Qg | 36 nC @ 10 V (index listing, not re-read in PDF) | 4 typ / 5.2 max nC @ 4.5 V p2 |
| Pinout | 1-3 S, 4 G, 5-8 D, package DFN5x6A-8_EP p1 | 1-3 S, 4 G, 5-8 D, SON 5x6 p1 |

Notes:

- WSD3042DN56 is the only part found with a true 2.5 V guarantee, with real margin at 3.0-3.3 V (the output plot on p4 shows the 3 V curve grouped with 4-10 V). Cost of that margin: it is a 16 mOhm part. At 5 A that is 0.40 W at 25 C; assuming the usual x1.5 hot factor (**ESTIMATE**, its temperature curve was not read) about 0.6 W. On its own 84 C/W figure that is about +50 C, more on modest copper. 5 A continuous on four channels then needs more drain copper or thermal vias. Its own ambient rating is 9 A at 25 C / 7 A at 70 C on 1 in2. The 0.5 V minimum threshold also means less noise margin while the GPIO floats at boot; the 100 k pull-down covers that.
- CSD17307Q5A is guaranteed at 3 V but not below, so a 3.0 V gate is exactly on the spec point with no margin. Dissipation is similar: 17.3 mOhm max gives 0.43 W at 25 C. Its gate limit is +10 / -8 V, fine for 3.3 V drive but it rules out a 12 V driver later.
- Mechanical: both datasheets show the same 1-3 S / 4 G / 5-8 D arrangement, but their land patterns against the hand-written footprint are **UNVERIFIED**.

### 2b. Looked at and rejected for direct 3.3 V drive

All of these specify Rds(on) only at 4.5 V and 10 V (datasheets fetched from lcsc.com/datasheet/Cxxxx.pdf):

| Part | LCSC | Vds | Vgs(th) min/typ/max | Note |
|---|---|---|---|---|
| CSD17581Q5A (TI) | C471056 | 30 V | 1.0 / 1.3 / 1.7 V | 3.5 typ / 4.2 max mOhm @ 4.5 V. Rds-vs-Vgs curve (p1) has its knee near 3 V; typical only. Stock 6064, about $0.45 |
| CSD17577Q5A (TI) | C475504 | 30 V | 1.1 / 1.4 / 1.8 V | 4.8 typ / 5.8 max mOhm @ 4.5 V. Stock 836 |
| NCEP4045GU (NCE) | C502973 | 40 V | 1.0 / 1.6 / 2.0 V | 6 typ / 6.6 max mOhm @ 10 V |
| NCEP3045GU (NCE) | C502962 | 30 V | 1.0 / 1.5 / 2.0 V | 5.8 typ / 6.4 max mOhm @ 10 V |
| HYG030N03LQ1C2 | C5121294 | 30 V | 1.0 / 1.4 / 3.0 V | 3.5 typ / 4.2 max mOhm @ 4.5 V |
| SiRA60DP (Vishay) | C467954 | 30 V | 1.1 min / 2.2 max V | 4.5 V and 10 V only |
| SiR426DP (Vishay) | C52893 | 40 V | 1.2 min / 2.5 max V | 4.5 V and 10 V only |
| WSD4076DN56 (Winsok) | C5242072 | 40 V | 1.5 / 1.6 / 2.5 V | |
| WSD40120DN56G (Winsok) | C507088 | 40 V | 1.2 / 1.6 / 2.2 V | |
| WSD40200DN56G (Winsok) | C5185344 | 40 V | 1.1 / 1.8 / 2.5 V | |
| WSD30150ADN56 (Winsok) | C5242056 | 30 V | 1.2 / 1.6 / 2.5 V | |

Search coverage: about 1150 single N-channel parts across 25 spellings of the 5x6 package name in the JLCPCB index (top 100 by stock per spelling), plus named lookups of the TI CSD17xxx/CSD18xxx, Winsok, Vishay and AOS families. The index only returns the 100 highest-stock parts per package name, so a low-stock 40 V / 2.5 V part could have been missed.

### 2c. Gate driver instead

A low-side driver powered from the existing 5 V rail puts about 5 V on the gate, above the 4.5 V spec point of ordinary logic-level FETs.

What it buys:

- AON6354 becomes fully specified: 5.2 mOhm max, about 0.13 W at 5 A cold, 0.2 W hot. No thermal vias needed.
- A 40 V FET becomes usable, which fixes the TVS mismatch in section 3. Example: AON6144 (AOS, C133142, https://www.lcsc.com/product-detail/C133142.html, datasheet https://www.lcsc.com/datasheet/C133142.pdf): 40 V, Rds(on) < 3.5 mOhm at Vgs = 4.5 V and < 2.4 mOhm at 10 V (p1 summary), 2.7 typ / 3.5 max mOhm at 4.5 V (p2), Vgs(th) 1.4 / 1.85 / 2.4 V, Qg(4.5 V) 22 typ / 34 max nC. Stock 7065, about $0.65, Extended. Its pin diagram was not rendered in this check, so pinout is **UNVERIFIED** (same AOS DFN5x6 family as AON6354).
- Amps of gate current instead of 3-6 mA, so PWM edges are tens of nanoseconds and switching loss stops mattering at any sensible frequency.

What it costs: two dual drivers (or one quad) plus decoupling, and the 100 Ohm gate resistors should drop to roughly 10 Ohm. Specific driver part numbers, their 3.3 V input thresholds and LCSC numbers are **UNVERIFIED**; none were opened in this check.

Worth it? Yes if any channel is PWM'd above about 1 kHz at 5 A, or if the outputs must survive 24 V inductive loads with margin. For plain on/off loads at moderate current, the WSD3042DN56 swap with added copper is the cheaper fix.

## 3. SS56 (LCSC C65009)

Source: MDD (Microdiode) "SS52 THRU SS5200" datasheet, Rev 2024A4, https://www.lcsc.com/datasheet/C65009.pdf. Parts page https://www.lcsc.com/product-detail/C65009.html. Package DO-214AC / SMA.

| Parameter | SS56 value | Where |
|---|---|---|
| Vrrm / Vdc | 60 V | p1 table |
| Vrms | 42 V | p1 |
| I(AV) | 5.0 A | p1 |
| Ifsm, 8.3 ms half sine | 120 A | p1 |
| Vf max at 5.0 A | 0.70 V | p1 (column shared by SS55 and SS56) |
| Vf at 5 A, typical | about 0.63-0.65 V | p2 Fig. 3, SS56 curve, read off |
| Vf at 1 A, typical | about 0.40 V | p2 Fig. 3, read off |
| Ir at rated Vdc | 1.0 mA at 25 C, 50 mA at 100 C | p1 |
| Cj typical | 300 pF | p1 |
| RthJA typical | 60 C/W on 2 x 2 inch copper pad areas | p1 note 2 |
| Tj range | -55 to +150 C | p1 |

There is no guaranteed Vf at 1 A; only the typical curve.

Polarity: the datasheet says "Color band denotes cathode end" (p1, Mechanical Data). It does not number the pads. The pad-1-to-cathode convention of the LCSC/EasyEDA footprint for C65009 is **UNVERIFIED** (EasyEDA API returned 403).

Check before ordering: all five SS56 instances use `footprint="sma"` with `pinLabels={{ pin1: "cathode", pin2: "anode" }}` (`mosfet-output.tsx`, `buck-5v.tsx`, and three in `designs/base-s3/index.tsx`). Whether that override really makes physical pad 1 the cathode, and whether JLCPCB's placement rotation for C65009 agrees, was not verified here. A reversed flyback diode is a dead short across the load supply, so confirm it on the rendered board against the silkscreen band.

Implications:

- As a flyback diode for on/off loads it only conducts for the inductive decay. 60 V / 5 A is adequate for 24 V / 5 A.
- Under PWM into an inductive load it carries the load current for the whole off-time: 0.70 V x 5 A x (1 - D), up to about 1.75 W at 50 % duty. At 60 C/W (and that figure assumes 2 x 2 inch pads) that is over 100 C of rise. An SMA SS56 is undersized for 5 A PWM freewheeling.
- As an OR-ing diode at a continuous 5 A it would dissipate about 3.5 W, which is not viable in SMA. At 1 A it is about 0.4 W, fine. The actual OR-ing current was not checked.
- 50 mA reverse leakage at 100 C is worth remembering for the OR-ing use (back-feed between sources).

## 4. SMBJ26A (LCSC C5331110)

Source: MSKSEMI "SMBJXXX(C)A" datasheet, https://www.lcsc.com/datasheet/C5331110.pdf, electrical table row SMBJ26A. Parts page https://www.lcsc.com/product-detail/C5331110.html. Package DO-214AA / SMB, unidirectional.

| Parameter | Value |
|---|---|
| Standoff Vr (Vrwm) | 26.0 V |
| Ir at Vr | 1 uA |
| Breakdown Vbr at It = 1 mA | 28.90 V min / 31.90 V max |
| Clamping Vc max at Ipp | 42.1 V |
| Ipp | 14.26 A |
| Peak pulse power | 600 W, 10/1000 us waveform |

Polarity: "Color band denotes cathode except bi-directional models" (p1).

Implication: with a 24 V supply the TVS is correctly sized for standoff, but it does nothing below 28.9 V and lets the rail reach 42.1 V at rated pulse current. A 30 V FET (AON6354: 30 V, 36 V for 10 us) is therefore not protected by it; the FET would avalanche first (Eas 20 mJ). A 40 V FET clears the breakdown band but still sits just under the 42.1 V full-current clamp, so 40 V is the minimum sensible rating, not a generous one.

## Not verified

- ESP32-S3 GPIO VOH and drive strength.
- DFN5x6 land-pattern dimensions for any of the FETs against `DfnFet5x6Footprint`.
- LCSC/EasyEDA pad numbering for the SMA footprint of C65009, and the tscircuit `sma` pin-to-pad mapping.
- Gate driver part selection.
- AON6144 pin diagram; WSD3042DN56 Qg and Rds-vs-temperature.
- Live LCSC stock and price (figures are from the JLCPCB index mirror).
- Board copper thermal resistance (60-90 C/W is an estimate).
