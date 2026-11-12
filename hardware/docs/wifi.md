# Wi-Fi, SoftAP, mDNS (Hardware)

Firmware: [docs/features/wifi.md](../../docs/features/wifi.md) · Node-RED: [nodered/.../docs/wifi.md](../../nodered/node-red-contrib-de-esp32/docs/wifi.md) · Manager: [manager/docs/wifi.md](../../manager/docs/wifi.md)

## What it needs from the hardware
The ESP32 module's radio and its antenna (a module with a PCB antenna, or a connector). Nothing else.

## Provided today
Nothing yet. No design includes an ESP32 module.

## Electrical limits
Keep copper and metal away from a module's PCB antenna area. Wi-Fi is always on, which is why ADC2 pins are refused.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. Planned, not designed: optional W5500 Ethernet and PoE. The firmware has no Ethernet driver, so this is a firmware gap too.
