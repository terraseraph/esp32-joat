# base-s3 power check: datasheet verification

Date: 2026-11-18. Scope: `lib/buck-5v.tsx`, `lib/power-footprints.tsx`, `lib/ina226-monitor.tsx`,
`lib/usb-c-device.tsx`, `lib/pluggable-terminal.tsx`, `designs/base-s3/index.tsx`.

Rule used: every rating, equation or pinout below was read from a document opened during this
check (source list at the end, cited as [S1]..[S17]). Anything not read from a manufacturer
document is marked **UNVERIFIED** or "LCSC listing". Calculations are mine, using the cited
equations. Stock and prices are LCSC web-API values on the day of the check; JLCPCB assembly
stock was **not** queried separately.

## Summary of problems (most important first)

| # | Problem | Fix |
|---|---|---|
| 1 | SMBJ26A cannot be used on a 24 V lead-acid system: VBR(min) 28.9 V [S5] is inside the 28.8-29.4 V charging range, so the TVS conducts continuously. Even "Vin up to 28 V" is above its 26 V standoff. | Regulated 12/24 V only: keep SMBJ26A or use SMBJ24A. Lead-acid: SMBJ30A/33A plus an 85 V monitor (INA237) and >=60 V load FETs. |
| 2 | INA226 abs max is 40 V on IN+/IN-/VBUS, and TI says "Do not apply more than 36 V" [S2]. SMBJ26A clamps at 42.1 V at Ipp [S5]. The board note is correct. | INA237AIDGSR (C2864837) is pin-compatible in VSSOP-10 and rated 85 V; firmware register map differs. |
| 3 | Compensation is sized for roughly 2.5x more output capacitance than fitted. 2 x 22 uF derates to ~27 uF at 5 V [S4]; the TI procedure then gives 6.7k / 10 nF / 78 pF, not 16.9k / 4.7 nF / 47 pF. With 16.9k the calculated crossover is ~68 kHz (> fsw/10). | R_COMP5 6.65k, C_COMP5 10 nF, C_COMPHF5 82 pF; or add a third 22 uF and use 8.06k / 12 nF / 68 pF. |
| 4 | "5-24 V" logic input is not real. The TPS54360 needs ~5.3-5.4 V at its VIN pin to regulate 4.88 V at 2 A and ~6.0 V for monotonic start-up at 2 A [S1 Eq. 1, 2]; the OR diode, shunt and polyfuse add ~0.6-1.2 V. Real minimum at the terminal is about 7 V at 2 A. | Label the input 7-24 V (regulated) and add the UVLO divider below. |
| 5 | 1.1 A polyfuse hold current [S9] limits low-voltage operation: 2 A out needs ~1.9 A in at 6 V and ~1.15 A at 10 V (85 % efficiency assumed). | Full 2 A output only above ~10.5 V in, or fit a larger polyfuse. |
| 6 | Input ceramics: 2 x 2.2 uF 50 V X7R derate to 2.8 uF at 24 V and 2.5 uF at 28 V [S4]; TI requires >= 3 uF effective [S1 8.2.2.6]. | Add a third 2.2 uF 50 V (or 2 x 4.7 uF 50 V). |
| 7 | 2 mOhm shunt footprint: the generic `2512` footprint builds 1.2 mm-long pads with a 4.7 mm gap; Yageo specifies 3.05 mm pads with a 1.27 mm gap for 1-4 mOhm parts [S8]. | Use the Yageo land pattern (or the EasyEDA one). |
| 8 | Inductor Isat 3.2 A (max column) / 3.5 A (typ) [S6] is below the TPS54360 current limit of 4.5-6.8 A [S1], so it saturates in an overload or short. Fine at 2 A normal load. | Accept for 2 A, or pick an inductor with Isat >= 5.5 A. |
| 9 | KT-0603R LED: in the EasyEDA/LCSC footprint pad 1 (anode) is on the right, pad 2 (cathode) on the left; the tscircuit `0603` footprint puts pin 1 on the left. Numbering matches, geometry is mirrored. | Expect a 180 degree CPL rotation correction for C2286; check in the JLCPCB placement preview. |
| 10 | PowerPAD land is 3.1 x 2.4 mm with no vias; TI's land pattern is 3.4 x 2.71 mm solder-mask opening with 0.2 mm vias on a 1.3 mm grid [S1]. | Enlarge to 3.4 x 2.71 mm and add the vias (GND net). |
| 11 | 20 A needs 12.3 mm of 1 oz or 6.1 mm of 2 oz external copper for a 20 C rise (IPC-2221) [S12]. No fuse, no reverse-polarity protection. AON6354 load FETs are 30 V parts (LCSC listing) behind a 42 V clamp. | Pours/2 oz, blade fuse, LM74700 + 60 V N-FET (section 3). |

---

## 1. TPS54360DDA buck (TI SLVSBB4G) [S1]

### 1.1 Pinout: correct

Datasheet section 5, "DDA Package 8-Pin HSOIC (Top View)" and Pin Functions table (p. 4):
1 BOOT, 2 VIN, 3 EN, 4 RT/CLK, 5 FB, 6 COMP, 7 GND, 8 SW, 9 thermal pad ("GND terminal must be
electrically connected to the exposed pad").

`buck-5v.tsx` pinLabels match exactly (pin 4 is labelled `RT`, same pin). PAD is tied to GND as
required. The EasyEDA symbol for C44377 has the same numbering [S13].

Footprint pad order in `So8PowerpadFootprint`: pins 1-4 along the bottom row left to right,
5-8 along the top row right to left. That matches the EasyEDA footprint for C44377 (pad 1 at
x -1.905, y -2.769; pad 5 at x +1.905, y +2.769) [S13].

### 1.2 Switching frequency

Eq. 8 (p. 16): fsw(kHz) = 92417 / RT(kOhm)^0.991. RT = 160k gives **605 kHz** (the file comment
says ~610 kHz; 158k would give 612 kHz). The datasheet example uses 162k for 600 kHz (Eq. 27).

Frequency limits, Eq. 9 and Eq. 10 (p. 17), with tON(min) 135 ns, Rdc 62 mOhm, RDS(on) 92 mOhm,
Vd 0.7 V:

| Vin | Eq. 9 pulse-skip limit | Eq. 10 foldback limit (ICL 4.7 A, Vout(sc) 0.1 V) |
|---|---|---|
| 28 V | 1480 kHz | 2290 kHz |
| 42.1 V (TVS clamp) | 990 kHz | 1530 kHz |

605 kHz is comfortably below both. **RT = 160k is fine.**

### 1.3 Minimum input voltage (5 V in cannot work)

- Internal UVLO: 4.3 V typ rising (4.1-4.48 V), 325 mV hysteresis (Electrical Characteristics, p. 7).
- Eq. 1 (p. 14) / Eq. 43 (p. 31): VIN(min) = (VOUT + VF + Rdc x IOUT) / 0.99 + RDS(on) x IOUT - VF.
  The operator signs did not survive text extraction; the form above reproduces the datasheet's
  own worked result (5.56 V in Eq. 43) so I am confident of it.
  - Typical (VF 0.5 V, Rdc 48 mOhm [S6], RDS(on) 0.12 Ohm as the datasheet uses for dropout): **5.27 V**
  - Worst case (VF 0.7 V [S7], Rdc 62 mOhm [S6], RDS(on) 190 mOhm max): **5.44 V**
- Eq. 2 (p. 15), monotonic start-up at heavy load with D(max) = 0.9 and the BOOT-dependent
  RDS(on) expression: at 2 A the output reaches 4.88 V only when VIN(pin) is about **6.0 V**
  (6.0 V gives 4.885 V; 5.5 V gives 4.41 V). The sign of the last Rdc term was not extractable;
  I used minus. Treat as +/-0.1 V.
- Upstream of the VIN pin: D_OR_DC SS56 (0.70 V max at 5 A [S7]; less at 2 A, curve not read),
  20 mOhm shunt (38 mV at 1.9 A), polyfuse 50-250 mOhm [S9] (0.1-0.5 V at 1.9 A).

Result: at the J_DC terminal the buck needs roughly **6.2-6.6 V to hold regulation at 2 A and
about 7 V to start into 2 A**. Below that the 5 V rail follows the input in dropout. At light
load the numbers are about 0.5 V lower.

### 1.4 Inductor: 10 uH SWPA6045S100MT (C79272)

Sunlord SWPA6045S series spec, table 12 [S6]: 10 uH +/-20 %, SRF 15 MHz, DCR 62 mOhm max /
48 mOhm typ, Isat 3.20 A / 3.50 A (30 % inductance drop), Irms 2.45 A / 2.70 A (40 C rise);
columns are headed Max / Typ.

Eq. 28 (p. 27) with KIND = 0.3, IOUT 2 A, VIN(max) 28 V, 605 kHz: **L(min) = 11.1 uH**.
10 uH gives KIND = 0.33, which is inside the 0.2-0.4 range the datasheet discusses.

Eq. 29-31 at 2 A:

| Vin | Ripple (pk-pk) | Peak | RMS |
|---|---|---|---|
| 6 V | 0.15 A | 2.08 A | 2.00 A |
| 12 V | 0.48 A | 2.24 A | 2.01 A |
| 24 V | 0.64 A | 2.32 A | 2.01 A |
| 28 V | 0.67 A | 2.33 A | 2.01 A |
| 28 V, L = 8 uH (-20 %) | 0.83 A | 2.42 A | |

- Peak 2.42 A < Isat 3.2 A and RMS 2.0 A < Irms 2.45 A: **adequate for 2 A**, with thin thermal margin.
- Ripple at 6 V is right at the 150 mA minimum the datasheet asks for (8.2.2.3).
- TI's conservative recommendation (8.2.2.3) is Isat >= the switch current limit (5.5 A nominal,
  4.5-6.8 A range). This part does not meet that; it will saturate during a short or overload.
- Not adequate for the IC's full 3.5 A.

### 1.5 Output capacitors: 2 x 22 uF 25 V X5R 1206 (CL31A226KAHNNNE, C12891)

Samsung's own DC-bias data for CL31A226KAHNNN [S4]: -38.0 % at 5 V (-6.8 % at 2 V, -68 % at
10 V). Effective: 13.6 uF each, **27.3 uF for the pair** (24.6 uF with -10 % tolerance).

| Criterion | Equation | Required |
|---|---|---|
| Load step 1 A (50 %), 4 % deviation | Eq. 32 | 16.9 uF |
| Load step 2 A (full), 4 % deviation | Eq. 32 | 33.9 uF |
| Load dump 2 A to 0, 4 % overshoot | Eq. 33 | 20.6 uF |
| 25 mV ripple | Eq. 34 | 5.5 uF |

27 uF meets everything except a full 0-2 A step. Ripple with 27 uF is about 5 mV. Capacitor RMS
current (Eq. 36) is 0.19 A. **Acceptable; a third 22 uF is recommended** (41 uF effective).
Voltage rating 25 V is fine.

### 1.6 Input capacitors

- C_BUCK_IN1/2: CL31B225KBHNNNE 2.2 uF 50 V X7R 1206 (C50254). Samsung DC-bias data [S4]:
  -13 % at 12 V, -35.8 % at 24 V, -42.3 % at 28 V. Pair = 3.8 uF at 12 V, **2.8 uF at 24 V,
  2.5 uF at 28 V**. Datasheet 8.2.2.6 requires at least 3 uF effective. **Short at 24 V and above:
  add a third 2.2 uF 50 V.** LCSC stock for C50254 was 10 pieces on the day.
- Voltage rating: 50 V >= 42.1 V clamp. OK. The datasheet example uses 100 V parts only because
  its input is 60 V.
- C_BUCK_BULK: 100 uF 50 V electrolytic (C2836439), 146 mA ripple rating at 120 Hz (LCSC
  listing). 50 V is OK against the 42 V clamp. It is damping/bulk only; the ceramics carry the
  switching ripple (Eq. 38: up to 1.0 A RMS at Vin ~ 9.8 V), which is another reason to fit the
  third ceramic.
- Ripple on ceramics alone at 24 V (Eq. 39): about 290 mV.

### 1.7 Catch diode: SS56 SMA (MDD, C65009)

MDD SS52-SS5200 datasheet [S7]: VRRM 60 V, IF(AV) 5 A, IFSM 120 A, VF 0.70 V max at 5 A.
Junction capacitance and thermal resistance values (300/500 pF, 60 C/W on 5 x 5 cm copper) are in
the table but the column alignment was lost in extraction; treat those two as approximate.

- Reverse rating 60 V >= VIN(max) incl. 42 V clamp: OK (8.2.2.5 asks for >= VIN(max)).
- Eq. 37 at 2 A with Cj 500 pF: 0.62-0.86 W at 12 V, 0.89-1.21 W at 24 V, **0.95-1.28 W at 28 V**
  (range is VF 0.5-0.7 V). In an SMA at ~60 C/W that is a 55-75 C rise. It works but runs hot at
  sustained 2 A from 24 V; an SMB/SMC 5 A Schottky would be cooler. The datasheet example uses a
  B560C (SMC).

### 1.8 Boot capacitor

Datasheet 7.3.4 / 8.2.2.7: 0.1 uF ceramic, X5R or better, 10 V or higher. C_BOOT5 is 100 nF 50 V
X7R 0603 (C14663, LCSC listing). **Correct.**

### 1.9 Compensation (Eq. 44-51, p. 31-32)

Inputs: COUT 27.3 uF effective, IOUT(max) 2 A, VOUT 4.88 V, fsw 605 kHz, gmps 12 A/V,
gmea 350 uA/V, VREF 0.8 V.

| Step | Equation | Result |
|---|---|---|
| Modulator pole | Eq. 44 | 2.39 kHz |
| ESR zero (1.5-3 mOhm assumed, **UNVERIFIED** ESR) | Eq. 45 | 1.9-3.9 MHz |
| fco, geometric mean of pole and ESR zero | Eq. 46 | 68-96 kHz |
| fco, geometric mean of pole and fsw/2 | Eq. 47 | **26.9 kHz** (use the lower) |
| Compensation resistor | Eq. 48 | **6.70 kOhm** |
| Compensation capacitor | Eq. 49 | **9.9 nF** |
| Pole capacitor (larger of Eq. 50, 51) | Eq. 51 | **79 pF** |

Compared with the fitted 16.9k / 4.7 nF / 47 pF:

- 16.9k sets a calculated crossover of about 68 kHz, 2.5x the procedure's target and above
  fsw/10. The datasheet notes the real crossover is lower because slope compensation is ignored,
  so this may still be stable on the bench, but it is not what the procedure produces.
- Zero at 2.0 kHz (close to the 2.39 kHz pole: fine). Pole at 200 kHz (fine).
- 16.9k is roughly what the procedure gives for well over 100 uF of effective output capacitance.

Recommended E96/E12 values:

| Option | R_COMP5 | C_COMP5 | C_COMPHF5 |
|---|---|---|---|
| Keep 2 x 22 uF | **6.65k** | **10 nF** | **82 pF** |
| Fit 3 x 22 uF (41 uF eff.) | **8.06k** | **12 nF** | **68 pF** |

Feedback divider 51k / 10k gives 0.8 x (1 + 5.1) = 4.88 V (Eq. 3). Correct; 10k is well below
the 800k limit in 8.2.2.9.

### 1.10 EN and UVLO

- Floating EN is explicitly allowed: "Float to enable" (pin table) and section 7.4.1; internal
  pull-up I1 = 1.2 uA. **Acceptable**, but the converter then starts at 4.3 V where it cannot
  regulate (section 1.3), so the 5 V rail comes up low on a sagging supply.
- Divider for ~6 V start, Eq. 4 and 5 (p. 16), Ihys 3.4 uA, VENA 1.2 V:
  - Start 6.0 V / stop 5.5 V: RUVLO1 = 147.1k, RUVLO2 = 35.46k. E96: **147k (VIN to EN) and
    35.7k (EN to GND)** give start 5.96 V, stop 5.46 V.
  - EN pin abs max is 8.4 V (6.1). With that divider EN sits at 5.6 V for 28 V in and **8.36 V at
    the 42.1 V clamp**, which is at the limit. The datasheet (7.3.7) recommends a zener clamp on
    EN in this situation.
  - Better match to section 1.3: start 6.5 V / stop 6.0 V, **147k and 32.4k** (6.47 V / 5.97 V),
    EN = 5.2 V at 28 V and 7.7 V at 42.1 V. No zener needed.
  - These thresholds are at the IC pin; add ~0.5-0.7 V for the terminal.

### 1.11 IC dissipation (Eq. 52-57, 2 A)

0.25 W at 12 V, 0.32 W at 24 V, 0.37 W at 28 V. With theta-JA 42 C/W (6.4, standard board)
that is a 10-16 C rise. No concern, provided the pad is soldered and has vias.

### 1.12 PowerPAD land pattern

TI DDA0008B drawings at the end of [S1] (drawing 4214849/B):

| Item | TI | `So8PowerpadFootprint` |
|---|---|---|
| Package exposed pad | 2.8-3.4 mm (along pin rows) x 2.11-2.71 mm | |
| Thermal land, solder-mask opening | **3.4 x 2.71 mm** | **3.1 x 2.4 mm** |
| Copper under mask (optional heat spreader) | 4.9 x 2.95 mm | none |
| Thermal vias | **0.2 mm drill, 1.3 mm pitch** under the pad | none |
| Paste aperture, 0.125 mm stencil | 3.4 x 2.71 mm | |
| Signal pads | 8 x 1.55 x 0.6 mm, 1.27 mm pitch, rows 5.4 mm apart | 2.0 x 0.6 mm, rows 5.54 mm apart |

Notes 8-10 on the drawing: the package is designed to be soldered to a thermal pad; vias are
optional per application and should be filled, plugged or tented if under paste. Layout
guideline 10.1: connect the PowerPAD to internal ground planes with multiple vias directly under
the IC.

Assessment: orientation is right (long side along the pin rows). The land is 0.3 mm smaller than
TI's in both directions; a maximum-size package pad overhangs it by 0.15 mm per side. Enlarging
to 3.4 x 2.71 mm leaves 0.41 mm to the existing 2.0 mm-long pin pads. The via count is not
stated in text; a 2 x 3 array at 1.3 mm pitch fits the 3.4 x 2.71 mm opening. Via-count guidance
in SLMA002 was not opened (**UNVERIFIED**). The EasyEDA footprint for C44377 has only a
2.0 x 2.0 mm pad [S13], so it is not a better reference.

---

## 2. INA226 [S2]

### 2.1 Ratings (SBOS547C)

- Absolute maximum (5.1): IN+/IN- common-mode -0.3 to **40 V**; differential -40 to 40 V, with
  footnote 2 that each pin must stay within -0.3 to 40 V; VBUS -0.3 to **40 V**; VS 6 V.
- Recommended (5.3): only a nominal 12 V common-mode is listed. Electrical characteristics:
  bus voltage input range 0-36 V, with the footnote "While the input range is 36 V, the
  full-scale range of the ADC scaling is 40.96 V ... Do not apply more than 36 V." The same note
  appears in the feature description.
- Duration: **none is given.** Footnote 1 says operation outside abs max "may cause permanent
  device damage" and operation between recommended and abs max may affect reliability and
  lifetime. There is no transient allowance.
- Section 8.3 states the device "can withstand the full 0 V to 36 V range at the input
  terminals, regardless of whether the device has power applied".
- The datasheet's overload paragraph points to transient absorbers plus bulk capacitance and to
  TIDU473 (not opened).

Pinout (figure 4-1): 1 A1, 2 A0, 3 Alert, 4 SDA, 5 SCL, 6 VS, 7 GND, 8 VBUS, 9 IN-, 10 IN+.
`ina226-monitor.tsx` matches. Addresses in the file comment match table 6-2 (GND/GND 0x40,
A1=GND A0=VS 0x41, A1=VS A0=GND 0x44, VS/VS 0x45).

### 2.2 Is the note's claim right?

Yes. MSKSEMI SMBJ26A (the actual C5331110 part) [S5]: VRWM 26 V, VBR 28.9-31.9 V at 1 mA,
**VC 42.1 V at IPP 14.26 A** (10/1000 us). 42.1 V exceeds the 40 V abs max and the 36 V
operating limit. At surge currents well below 14 A the clamp sits between 32 V and 42 V, so
small transients stay inside 40 V, but nothing guarantees it.

### 2.3 Higher-voltage alternatives

| Part | LCSC | Stock | Price (1 pc) | Common-mode / VBUS abs max | Notes |
|---|---|---|---|---|---|
| INA226AIDGSR (fitted) | C49851 | 56,535 | $0.68 | 40 V | |
| **INA237AIDGSR** | **C2864837** | **6,363** | **$1.85** | -0.3 to **85 V** [S3] | Same VSSOP-10 pinout as INA226 (pins 1-10 identical, [S3] table 5-1). 16-bit. |
| INA228AIDGSR | C2887910 | 0 | $6.84 | 85 V [S3] | 20-bit, energy/charge. Out of stock. |
| INA238AIDGSR | C2868250 | 0 | $23.57 | 85 V (LCSC listing; datasheet not opened) | Out of stock, price not sensible. |
| INA260 | not looked up | | | 40 V, same as INA226 [S3] | Integrated shunt, 15 A continuous max. Does not help. |

The board note says an 85 V monitor "was not found in JLCPCB stock". **INA237AIDGSR is stocked
at LCSC** (6,363); check the JLCPCB assembly library before relying on it.

Register model: **not the same as INA226.** INA237 [S3 table 7-3]: 0h CONFIG, 1h ADC_CONFIG,
2h SHUNT_CAL, 4h VSHUNT, 5h VBUS (3.125 mV/LSB), 6h DIETEMP, 7h CURRENT, 8h POWER (24-bit),
Bh DIAG_ALRT, then limit registers. INA226 has bus voltage at 02h with 1.25 mV/LSB [S2]. The
footprint is a drop-in; the driver needs a variant.

### 2.4 Lower-voltage TVS instead

MSKSEMI SMBJ series, 600 W, 10/1000 us [S5]:

| Part | VRWM | VBR min-max | VC at IPP | IPP |
|---|---|---|---|---|
| SMBJ22A | 22 V | 24.4-26.9 V | 35.5 V | 16.9 A |
| SMBJ24A | 24 V | 26.7-29.5 V | 38.9 V | 15.4 A |
| SMBJ26A (fitted) | 26 V | 28.9-31.9 V | 42.1 V | 14.3 A |
| SMBJ28A | 28 V | 31.1-34.4 V | 45.4 V | 13.2 A |
| SMBJ30A | 30 V | 33.3-36.8 V | 48.4 V | 12.4 A |
| SMBJ33A | 33 V | 36.7-40.6 V | 53.3 V | 11.3 A |

SMAJ24A (400 W) was not opened: **UNVERIFIED**. A 400 W part has a lower IPP, so it is a weaker
clamp for the same surge, not a tighter one.

By system type:

- **Regulated 12 V only**: any of these work; a 12-15 V-standoff part would protect far better
  but then the input is no longer 24 V capable.
- **Regulated 24 V (24 V +/-5 % = 25.2 V max)**: SMBJ24A is the lowest usable part (25.2 V is
  above its 24 V standoff but below VBR min 26.7 V, so leakage rises but it does not conduct).
  It clamps at 38.9 V: inside the INA226 40 V abs max, still above the 36 V operating limit.
  SMBJ22A would clamp under 36 V but its VBR min (24.4 V) is below a 25.2 V supply: not usable.
  **So no 600 W TVS both stands off a 24 V supply and clamps under 36 V.** A higher-power TVS of
  the same voltage (SMCJ24A / SMDJ24A, **UNVERIFIED**, not opened) clamps lower for the same surge.
- **24 V lead-acid (28.8-29.4 V charging, load dump)**: SMBJ26A is wrong (VBR min 28.9 V sits in
  the charging range; it will conduct and overheat). SMBJ28A (VBR min 31.1 V) or SMBJ30A is
  needed, clamping at 45-48 V. That is above the INA226 rating with no margin argument left, so
  this case needs the INA237. It also exceeds the 30 V AON6354 output FETs (LCSC listing value)
  and approaches the 50 V input capacitors. Load-dump energy was not analysed.

Recommendation: decide the supply class. For "regulated 12/24 V only" the cheapest change is
SMBJ26A to SMBJ24A and a documented limit. For lead-acid, INA237 + SMBJ30A + 60 V FETs.

---

## 3. 20 A load path

### 3.1 Trace width (IPC-2221)

Formula as published with the Advanced Circuits calculator [S12]: I = k x dT^0.44 x A^0.725,
A in mil^2, k = 0.048 external / 0.024 internal; width = A / (1.378 mil x oz). The same page
warns the IPC-2221 charts only cover up to 35 A and 0.4 in width. IPC-2152 was not opened.

| Current | 1 oz external, 20 C rise | 2 oz external, 20 C rise |
|---|---|---|
| 20 A | **12.3 mm** (484 mil) | **6.1 mm** (242 mil) |
| 5 A | **1.8 mm** (71 mil) | **0.9 mm** (36 mil) |

For a 10 C rise multiply widths by about 1.5 (20 A: 18.7 mm / 9.4 mm). The 20 A figure at 1 oz
is beyond the chart's 0.4 in limit, i.e. extrapolated. Internal layers need about 2.6x the
width. Practical consequence: VLOAD_IN, VLOAD and the GND return must be pours, ideally 2 oz and
duplicated on two layers with via stitching.

### 3.2 Shunt

- `ina226-monitor.tsx` "2m": PA2512FKE7T0R002E, **2512** package, LCSC C375692 (stock 10,690,
  $0.33 at 5 pcs).
- Yageo PA_E 2512 datasheet [S8]: ordering code "7T" = "3 x standard power (3W)"; rated at 70 C.
- Dissipation at 20 A: 20^2 x 0.002 = **0.8 W**, 40 mV drop. That is 27 % of the 3 W rating. A
  1 W 2512 would be at 80 %; the 3 W version is the right choice. At 5 A: 50 mW.
- INA226 full scale 81.92 mV / 2 mOhm = 41 A, as the code comment says.
- **Footprint problem.** Yageo table 6 for 1-4 mOhm: overall length A 7.37 mm, gap B 1.27 mm,
  pad length C 3.05 mm, pad width D 3.68 mm. The built board (cached build) has pads 1.225 x
  3.35 mm at +/-2.96 mm: a 4.7 mm gap, so only the outer ~1.2 mm of each termination is
  soldered and all 20 A flows through that strip. The EasyEDA footprint for C375692 is
  3.0 x 3.4 mm pads at +/-2.55 mm [S13], much closer to Yageo's. Kelvin sense connections should
  be taken from the inner pad edges.
- The 20 mOhm 1206 shunt (LRAM12CJTR020, C5120998) was not checked; LCSC returned no data.

### 3.3 Terminal KF2EDGR-5.08-2P (C441204)

LCSC listing: 15 A, 300 V, -40 to +105 C (stock 41,770, $0.047). The manufacturer PDF [S10] is
pure vector artwork with no text layer and I could not render it, so **the 15 A figure is from
the LCSC listing, UNVERIFIED against the Kefa drawing.** Sibling Kefa 5.08 mm parts are listed
at both 15 A and 10 A, so this is worth a manual look.

With two connectors in parallel, 20 A is 10 A per pin if current shares evenly (67 % of 15 A).
Sharing depends on the wiring; one loose plug puts 20 A through a single 15 A pin. The mating
plug's rating was not checked.

### 3.4 Fuse

| Option | LCSC | Stock | Price | Rating | Comment |
|---|---|---|---|---|---|
| **Littelfuse 178.6165.0002** ATO blade holder, through-hole | C207061 | 1,188 | $2.34 | 80 V [S11] | Current rating is in a graphic I could not read; a distributor lists the sibling .0001 at 30 A: **UNVERIFIED**. Fit a 25 A ATO fuse. |
| Littelfuse 01530007Z MINI blade holder | C206906 | 983 | $3.10 | 32 V, **15 A** (LCSC listing) | Too small for 20 A. |
| prosemi 2410BP-25A SMD fuse | C2838931 | **0** | $0.36 | 25 A, 72 V DC (LCSC listing) | Out of stock. |
| Bourns SF-2410F2500T-2 | C3158756 | discontinued at LCSC (search result) | | 25 A | Not available. |

Recommendation: the ATO holder with a 25 A blade fuse (20 A continuous is 80 % of rating).
The holder is not an SMT-assembly part; plan it as hand-fitted.

### 3.5 Reverse polarity

Dissipation at 20 A:

| Scheme | Parts (LCSC) | Dissipation at 20 A | Comment |
|---|---|---|---|
| **Ideal-diode controller + N-FET** | LM74700QDBVRQ1 (C2941042, stock 11,480, $2.76) + NTMFS5C628NLT1G 60 V (C145537, stock 8,560, $0.77) | 20^2 x 2.4 mOhm = **0.96 W max** (0.8 W at 2.0 mOhm typ), before temperature rise of RDS(on) | LM74700-Q1 [S14]: 3.2-65 V input, -65 V reverse, regulates 20 mV forward drop (13-29 mV); it suggests RDS(on) between 20 mV/I and 50 mV/I, i.e. 1.0-2.5 mOhm at 20 A, which this FET meets (2.0 typ / 2.4 max at VGS 10 V [S15]). Also blocks reverse current. |
| Same controller + existing AON6354 | C404363 | 20^2 x 3.3 mOhm = 1.3 W (LCSC listing value) | 30 V VDS is too low for a 24 V input with a 42 V clamp. Not recommended. |
| P-FET high side | TDM3405, -40 V, 9.4 mOhm max at -10 V [S16] (C380237, stock 1,155, $0.63) | 20^2 x 9.4 mOhm = **3.8 W** for one; 0.94 W each for two in parallel | Needs a gate zener and resistor (VGS abs max +/-25 V, LCSC listing). -40 V is below the 42 V clamp. Worse than the N-FET scheme on every count. |
| Series Schottky | none selected | about 0.5 V x 20 A = **10 W** (generic forward drop, **UNVERIFIED**, no 20 A part opened) | Impractical. |
| None + keyed connector + fuse | | 0 W | The pluggable header is already polarised. With a fuse fitted, a reversed supply forward-biases the unidirectional SMBJ26A, the FET body diodes and the flyback diodes until the fuse opens. Whether those parts survive a 25 A fuse's let-through was not checked. |

Recommendation: LM74700 + NTMFS5C628NL, placed after the fuse, with the TVS moved to the
protected side (a unidirectional TVS ahead of the ideal diode conducts on reverse polarity).
If the board is only ever wired once by the builder, "fuse + keyed connector" is defensible,
but say so in the docs.

---

## 4. Polarity, footprints and USB

### 4.1 Cathode pad

Symbol pin names and footprint pad positions from the EasyEDA/LCSC library [S13]; marking from
the part datasheets.

| Part | EasyEDA symbol | EasyEDA footprint | Datasheet marking | Design |
|---|---|---|---|---|
| **C2286 KT-0603R** (LED) | pin 1 = A, pin 2 = K | `LED-SMD_L1.6-W0.8-R-RD`: **pad 2 (cathode) at x -0.75, pad 1 (anode) at x +0.75** | KENTO datasheet [S17]: tape drawing shows a polarity symbol only; the package outline with the cathode mark is vector artwork I could not render. **Marking UNVERIFIED.** | `<led>` pin 1 = anode at x -0.83, pin 2 = cathode at x +0.83 (cached build). |
| **C65009 SS56** (SMA) | pin 1 = K, pin 2 = A | `SMA_L4.3-W2.6-LS5.2-RD`: **pad 1 (cathode) at x -2.2**, silk bar on the pad 1 side | MDD [S7]: "Color band denotes cathode end" | pin 1 = cathode at -x. Matches. |
| **C5331110 SMBJ26A** (SMB) | pin 1 = C, pin 2 = A | `SMB_L4.3-W3.6-LS5.4-RD`: **pad 1 (cathode) at x -2.59**, silk bar on the pad 1 side | MSKSEMI [S5]: "Color band denotes cathode except bi-directional models" | pin 1 = cathode at -x. Matches. |

So: **cathode = pad 1 for both diodes, cathode = pad 2 for the LED.** The board note (10) is
right about numbering. The catch is geometric: the LCSC LED footprint is drawn with pad 1 on the
right, while the generic tscircuit `0603` has pin 1 on the left. If JLCPCB's rotation reference
follows its library footprint, every C2286 needs a 180 degree CPL correction (the status LED
plus the output indicators in `mosfet-output.tsx`). The two diode footprints agree geometrically
and should need no correction. Confirm all three in the JLCPCB placement preview.

Wiring checks while here: D_CATCH anode to GND, cathode to SW (correct for a buck catch diode);
both TVS cathodes to the positive rail (correct for a unidirectional part).

### 4.2 USB-C CC resistors

Microchip AN1953 section 3.2 and table 7 [S16b]: an upstream-facing port must connect a valid
pull-down to GND on **both CC1 and CC2**; 5.1k is the nominal value, and +/-10 % (or better) is
required if the sink wants to detect the 1.5 A / 3.0 A current advertisement.

`usb-c-device.tsx` has separate 5.1k 1 % resistors (C23186) on CC1 and CC2. **Correct for a
5 V-only sink.** (Sharing one resistor between both CC pins is the classic mistake; this design
does not make it.)

### 4.3 D+/D- series resistors

Espressif ESP32-S3 Hardware Design Guidelines, schematic checklist, USB section [S18]: "It is
recommended to reserve series resistors (initial value can be 22/33 Ohm) and capacitors to
ground on the traces" (capacitors may start unpopulated) "and place them close to the chip."

So they are **recommended to reserve, not mandatory.** The board has none. Add two 0402/0603
footprints (start with 22 Ohm, or 0 Ohm) in D+ and D- next to the module, with optional
unpopulated capacitor pads to GND. The same section notes USB_D+ fluctuates at power-up and
suggests an external pull-up if a defined level is needed; not required here.

---

## Not verified / open

- KF2EDGR-5.08-2P 15 A rating and KT-0603R cathode mark: manufacturer PDFs have no text layer.
- Littelfuse 178.6165 holder current rating.
- SS56 junction capacitance and thermal resistance (table columns ambiguous); SS56 VF at 2 A.
- Output capacitor ESR (only affects Eq. 45/50, neither of which sets a chosen value).
- TPS54360 Eq. 1 and Eq. 2 operator signs (cross-checked against the datasheet's worked 5.56 V).
- SLMA002 PowerPAD via guidance, TIDU473, IPC-2152, SMAJ24A, SMCJ/SMDJ24A, INA238 datasheet.
- AON6354 ratings are LCSC listing values, not from the AOS datasheet.
- JLCPCB assembly-library stock (all stock figures are LCSC).
- Loop stability is calculated, not simulated or measured. Run WEBENCH or a load-step test.

## Sources

- [S1] TI TPS54360 datasheet, SLVSBB4G (June 2018): https://www.ti.com/lit/ds/symlink/tps54360.pdf
- [S2] TI INA226 datasheet, SBOS547C: https://www.ti.com/lit/ds/symlink/ina226.pdf
- [S3] TI INA237 (SBOSA20A), INA228 (SLYS021A), INA260 (SBOS656C):
  https://www.ti.com/lit/ds/symlink/ina237.pdf , https://www.ti.com/lit/ds/symlink/ina228.pdf ,
  https://www.ti.com/lit/ds/symlink/ina260.pdf
- [S4] Samsung Electro-Mechanics component library, DC-bias chart data:
  https://weblib.samsungsem.com/mlcc/mlcc-ec-data-sheet.do?partNumber=CL31A226KAHNNN and
  ...partNumber=CL31B225KBHNNN
- [S5] MSKSEMI SMBJxxx(C)A datasheet (C5331110):
  https://datasheet.lcsc.com/datasheet/pdf/3ccae3acbd26076f24236778f0912340.pdf?productCode=C5331110
- [S6] Sunlord SWPA6045S series specification SWPA07160000, table 12:
  https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/196/SWPA6045-Series.pdf
- [S7] MDD SS52 thru SS5200 datasheet, rev 2024A4 (C65009):
  https://datasheet.lcsc.com/datasheet/pdf/3d29bdcdc3c46ec127d6db22edd72e83.pdf?productCode=C65009
- [S8] Yageo PA_E series 2512 datasheet V.10 (C375692):
  https://datasheet.lcsc.com/datasheet/pdf/5b6b15592a49e0e574b8071c20ab494b.pdf?productCode=C375692
- [S9] Techfuse mSMD110-33V specification (C70119):
  https://datasheet.lcsc.com/datasheet/pdf/83a52b00a3fb00da0260c29eb7f73d7d.pdf?productCode=C70119
- [S10] Kefa KF2EDGR-5.08-2P drawing (C441204), no text layer:
  https://datasheet.lcsc.com/datasheet/pdf/50dc2d683fb501b638dea6cde12ab25d.pdf?productCode=C441204
- [S11] Littelfuse FLR PCB fuse holder datasheet (C207061):
  https://datasheet.lcsc.com/datasheet/pdf/0e07c97b9bd07e2df008e51002483122.pdf?productCode=C207061
- [S12] Advanced Circuits trace width calculator (IPC-2221 formula and limits):
  https://www.4pcb.com/trace-width-calculator.html
- [S13] EasyEDA/LCSC component library (symbol pins, footprint pads), per part:
  https://lceda.cn/api/products/C2286/components?version=6.4.19.5 (also C65009, C5331110, C44377,
  C375692, C79272, C441204)
- [S14] TI LM74700-Q1 datasheet, SNOSD17G: https://www.ti.com/lit/ds/symlink/lm74700-q1.pdf
- [S15] onsemi NTMFS5C628NL datasheet (C145537):
  https://datasheet.lcsc.com/datasheet/pdf/b879f965d95444bf811caba2a8f12cf6.pdf?productCode=C145537
- [S16] Techcode TDM3405 datasheet (C380237):
  https://datasheet.lcsc.com/datasheet/pdf/32a9ce06cc5fbb9fe5587d4ac7cee528.pdf?productCode=C380237
- [S16b] Microchip AN1953, Introduction to USB Type-C:
  https://ww1.microchip.com/downloads/en/appnotes/00001953a.pdf
- [S17] KENTO KT-0603R specification (C2286):
  https://datasheet.lcsc.com/datasheet/pdf/011ec3e8cb1e825f6961d29bc4db4c7a.pdf?productCode=C2286
- [S18] Espressif ESP32-S3 Hardware Design Guidelines, schematic checklist, USB:
  https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/schematic-checklist.html
- LCSC stock, price and listing parameters: https://wmsc.lcsc.com/ftps/wm/product/detail?productCode=<Cxxxx>
