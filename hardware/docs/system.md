# Reboot, factory reset, safe mode, password (Hardware)

Firmware: [docs/features/system.md](../../docs/features/system.md) · Node-RED: [nodered/.../docs/system.md](../../nodered/node-red-contrib-de-esp32/docs/system.md) · Manager: [manager/docs/system.md](../../manager/docs/system.md)

## What it needs from the hardware
GPIO 0 as the BOOT button (input with pull-up; low at reset enters ROM download mode), GPIO 2 for the status LED, UART0 (GPIO 1/3) for the console and flashing, and EN/reset.

## Provided today
`hardware/designs/base-s3` (rev A, draft, not reviewed): BOOT button on IO0, RESET button on EN (10k/1uF RC), status LED on IO2, native USB-C on IO19/IO20 (USB Serial/JTAG, no USB-UART chip).

## Electrical limits
Holding IO0 low during reset enters download mode. The S3's native USB serial replaces the classic ESP32's UART0 console.

## Gaps
The firmware currently targets the classic ESP32; base-s3 uses an ESP32-S3, so it needs an S3 build and board profile before any of this runs. The firmware's `board_profiles` need an S3 profile with these pins, and the console must move to USB Serial/JTAG.
