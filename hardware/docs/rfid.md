# RFID (MFRC522) (Hardware)

Firmware: [docs/features/rfid.md](../../docs/features/rfid.md) · Node-RED: [nodered/.../docs/rfid.md](../../nodered/node-red-contrib-de-esp32/docs/rfid.md) · Manager: [manager/docs/rfid.md](../../manager/docs/rfid.md)

## What it needs from the hardware
An SPI bus (VSPI default: SCK 18, MISO 19, MOSI 23; HSPI: SCK 14, MISO 12, MOSI 13), one chip-select per reader (up to 4), optional RST. 3.3 V module; no IRQ pin used.

## Provided today
Nothing yet. No design has an RC522 connector or footprint.

## Electrical limits
RC522 modules are 3.3 V devices. SPI runs at 1 MHz; keep wiring short. HSPI MISO is GPIO 12, a boot strap pin.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. A reader connector (SPI, CS, RST, 3.3 V) is not designed.
