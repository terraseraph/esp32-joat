# PWM (Hardware)

Firmware: [docs/features/pwm.md](../../docs/features/pwm.md) · Node-RED: [nodered/.../docs/pwm.md](../../nodered/node-red-contrib-de-esp32/docs/pwm.md) · Manager: [manager/docs/pwm.md](../../manager/docs/pwm.md)

## What it needs from the hardware
An output-capable GPIO (not 6-11, not 34-39); up to 8 pins sharing one frequency (50-20000 Hz). The pin is 3.3 V logic and drives a load only through whatever you add.

## Provided today
Nothing yet for PWM. `hardware/lib/relay-channel.tsx` has an AO3400A low-side switch (100R gate resistor, 100k pull-down), but it drives a relay coil from the expander, not from a PWM pin.

## Electrical limits
The `relay-8` notes say AO3400A is fine at 3.3 V gate drive. It is not analysed for PWM there (no switching-loss or flyback review at PWM frequencies).

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. Planned, not designed: MOSFET outputs for PWM.
