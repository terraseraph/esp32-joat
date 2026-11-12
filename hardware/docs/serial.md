# UART console (Hardware)

Firmware: [docs/features/serial.md](../../docs/features/serial.md) · Node-RED: [nodered/.../docs/serial.md](../../nodered/node-red-contrib-de-esp32/docs/serial.md) · Manager: [manager/docs/serial.md](../../manager/docs/serial.md)

## What it needs from the hardware
UART0: GPIO 1 TX / GPIO 3 RX at 115200 8N1, wired to a USB-UART bridge or header. Do not use GPIO 1/3 as pins.

## Provided today
Nothing yet.

## Electrical limits
A USB-UART's DTR/RTS often resets the chip when a monitor opens. 3.3 V logic.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. The S3 has native USB, but the firmware's console is configured for UART0 only. Not designed on the hardware side either.
