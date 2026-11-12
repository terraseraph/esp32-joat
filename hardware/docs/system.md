# Reboot, factory reset, safe mode, password (Hardware)

Firmware: [docs/features/system.md](../../docs/features/system.md) · Node-RED: [nodered/.../docs/system.md](../../nodered/node-red-contrib-de-esp32/docs/system.md) · Manager: [manager/docs/system.md](../../manager/docs/system.md)

## What it needs from the hardware
GPIO 0 as the BOOT button (input with pull-up; low at reset enters ROM download mode), GPIO 2 for the status LED, UART0 (GPIO 1/3) for the console and flashing, and EN/reset.

## Provided today
Nothing yet. These are DevKitC conventions; no design provides a BOOT button, LED or USB-UART.

## Electrical limits
GPIO 2 is rewritten every 100 ms by the status LED task. Holding GPIO 0 low during reset enters download mode.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. It needs a BOOT button, reset, status LED and a USB or UART header, and the firmware's `board_profiles` would need an S3 profile for them. Not designed.
