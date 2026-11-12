# PWM (Hardware)

Firmware: [docs/features/pwm.md](../../docs/features/pwm.md) · Node-RED: [nodered/.../docs/pwm.md](../../nodered/node-red-contrib-de-esp32/docs/pwm.md) · Manager: [manager/docs/pwm.md](../../manager/docs/pwm.md)

## What it needs from the hardware
An output-capable GPIO (not 6-11, not 34-39); up to 8 pins sharing one frequency (50-20000 Hz). The pin is 3.3 V logic and drives a load only through whatever you add.

## Provided today
`hardware/designs/base-s3` (rev A, draft, not reviewed) has four low-side MOSFET outputs (`hardware/lib/mosfet-output.tsx`) on IO15-IO18 (OUT1-OUT4): AON6354 driven straight from the GPIO via 100R with a 100k pull-down, SS56 flyback diode to the load supply, red LED on the drive line. Each output is a 2-pin 5.08 mm pluggable terminal: load + and switched OUT-.

## Electrical limits
Target 5 A per channel, 20 A total, load supply up to 24 V on its own input (two terminals in parallel). The AON6354 has no Rds(on) rating at 3.3 V gate drive, so dissipation at 5 A is unverified. Switching losses at high PWM frequency are not analysed; the 100R gate resistor and direct GPIO drive suit low frequencies (up to a few kHz). There is no fuse or reverse-polarity protection on the load input.

## Gaps
The firmware currently targets the classic ESP32; base-s3 uses an ESP32-S3, so it needs an S3 build and board profile before any of this runs. No per-channel current sensing; the load INA226 reports total load current only. Thermal vias under the MOSFETs and wide load copper are not designed yet.
