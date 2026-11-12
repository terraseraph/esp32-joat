# Status, telemetry, live events (Hardware)

Firmware: [docs/features/status.md](../../docs/features/status.md) · Node-RED: [nodered/.../docs/status.md](../../nodered/node-red-contrib-de-esp32/docs/status.md) · Manager: [manager/docs/status.md](../../manager/docs/status.md)

## What it needs from the hardware
No hardware dependency of its own. It reports whatever the other features read. The status LED pin is described in [system](system.md).

## Provided today
`hardware/designs/base-s3` (rev A, draft, not reviewed) has an INA226 on each power input (I2C): DC input 0x40, PoE input 0x41, USB 0x44 (20 mOhm shunts) and load supply 0x45 (2 mOhm). Each reads bus voltage and current, so firmware can tell which source is live.

## Electrical limits
INA226 bus and shunt pins are rated to 36 V (40 V abs max); the input TVS (SMBJ26A) can clamp above 40 V on a large surge. ALERT pins are not connected.

## Gaps
The firmware currently targets the classic ESP32; base-s3 uses an ESP32-S3, so it needs an S3 build and board profile before any of this runs. The firmware has no INA226 driver and no telemetry shape for per-input power.
