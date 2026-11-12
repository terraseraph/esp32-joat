# Hobby servo (Hardware)

Firmware: [docs/features/servo.md](../../docs/features/servo.md) · Node-RED: [nodered/.../docs/servo.md](../../nodered/node-red-contrib-de-esp32/docs/servo.md) · Manager: [manager/docs/servo.md](../../manager/docs/servo.md)

## What it needs from the hardware
An output-capable GPIO (not 6-11, not 34-39) for a 50 Hz pulse signal, up to 8 servos. The servo's own supply (usually 5 V) and ground must come from the board; the firmware does not control power.

## Provided today
Nothing yet. No design has a servo connector or servo power rail.

## Electrical limits
Signal is 3.3 V. Servo current is not budgeted anywhere in the repo.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. A 3-pin servo connector and servo power budget are not designed.
