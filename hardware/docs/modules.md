# Addon modules (Hardware)

Firmware: [docs/features/modules.md](../../docs/features/modules.md) · Node-RED: [nodered/.../docs/modules.md](../../nodered/node-red-contrib-de-esp32/docs/modules.md) · Manager: [manager/docs/modules.md](../../manager/docs/modules.md)

## What it needs from the hardware
Depends on the module type: `mfrc522` needs an SPI bus plus CS, `bme280` an I2C bus (see [rfid](rfid.md), [bme280](bme280.md)). Modules are software types; the firmware has no module type for expansion boards.

## Provided today
Partly. `hardware/designs/relay-8` is an expansion board with a 6-pin header (`hardware/lib/expansion-header.tsx`: V5, V3_3, GND, SDA, SCL, INT), a PCA9554 I2C expander at 0x20 and a 24C02 ID EEPROM at 0x50 (`hardware/lib/id-eeprom.tsx`, A0-A2 and WP tied low). The EEPROM is meant for auto-detect.

## Electrical limits
`relay-8` puts 8 relay coils (about 576 mA at 5 V) through one header pin; its own notes flag this as unresolved. INT is open-drain with no pull-up on that board, so the base board must supply one. The board is a tooling proof, not review-ready.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. Planned, not implemented: expansion auto-detect. The EEPROM exists on the board, but no firmware reads it and no record format is defined. There is no firmware module type for the PCA9554, so the firmware cannot switch the relay board today.
