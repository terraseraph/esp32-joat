# MQTT (Hardware)

Firmware: [docs/features/mqtt.md](../../docs/features/mqtt.md) · Node-RED: [nodered/.../docs/mqtt.md](../../nodered/node-red-contrib-de-esp32/docs/mqtt.md) · Manager: [manager/docs/mqtt.md](../../manager/docs/mqtt.md)

## What it needs from the hardware
No hardware dependency. It runs over Wi-Fi ([wifi](wifi.md)).

## Provided today
Not applicable.

## Electrical limits
None specific to this feature.

## Gaps
base-s3 (draft) has W5500 Ethernet, which would give MQTT a wired link; the firmware has no driver for it.
