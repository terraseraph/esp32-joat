# Wi-Fi, SoftAP, mDNS (Hardware)

Firmware: [docs/features/wifi.md](../../docs/features/wifi.md) · Node-RED: [nodered/.../docs/wifi.md](../../nodered/node-red-contrib-de-esp32/docs/wifi.md) · Manager: [manager/docs/wifi.md](../../manager/docs/wifi.md)

## What it needs from the hardware
The ESP32 module's radio and its antenna (a module with a PCB antenna, or a connector). Nothing else.

## Provided today
`hardware/designs/base-s3` (rev A, draft, not reviewed) uses an ESP32-S3-WROOM-1-N16R8 module with the antenna at the top board edge. It also has W5500 Ethernet on SPI (`hardware/lib/w5500-ethernet.tsx`: CS IO14, INT IO21, RST IO47, HR911105A RJ45 with magnetics).

## Electrical limits
Keep copper and metal away from the module's antenna area; base-s3 cuts its inner1 and bottom GND pours back under the antenna (a 24 x 8 mm notch at the top edge); the designer flags any pour that covers the keep-out. Wi-Fi is always on, which is why ADC2 pins are refused.

## Gaps
The firmware currently targets the classic ESP32; base-s3 uses an ESP32-S3, so it needs an S3 build and board profile before any of this runs. The firmware has no Ethernet driver. The RJ45 has no PoE taps, so PoE needs a different jack or magnetics (see the base-s3 notes); the PoE plug-in connector on base-s3 only takes 12 V in.
