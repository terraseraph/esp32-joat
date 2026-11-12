# Firmware updates (OTA) (Hardware)

Firmware: [docs/features/ota.md](../../docs/features/ota.md) · Node-RED: [nodered/.../docs/ota.md](../../nodered/node-red-contrib-de-esp32/docs/ota.md) · Manager: [manager/docs/ota.md](../../manager/docs/ota.md)

## What it needs from the hardware
No hardware dependency. It needs flash with two app slots (see `partitions.csv`), which the ESP32 module provides.

## Provided today
Not applicable.

## Electrical limits
None specific to this feature.

## Gaps
A base board with a different flash size than the current partition table is not accounted for. Not designed.
