# Capacitive touch (Hardware)

Firmware: [docs/features/touch.md](../../docs/features/touch.md) · Node-RED: [nodered/.../docs/touch.md](../../nodered/node-red-contrib-de-esp32/docs/touch.md) · Manager: [manager/docs/touch.md](../../manager/docs/touch.md)

## What it needs from the hardware
A touch-capable GPIO (classic ESP32: T0-T9 = GPIO 4, 0, 2, 15, 13, 12, 14, 27, 33, 32) wired to a bare pad, wire or copper tape. No external parts needed.

## Provided today
Nothing yet. No design has a touch pad.

## Electrical limits
Keep the trace short; a long trace or nearby ground pour shifts the baseline. GPIO 0, 2, 12, 15 are strapping pins.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. The S3 has a different touch pin set, so the table in the firmware doc will not carry over.
