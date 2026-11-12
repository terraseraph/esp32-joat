# Digital in/out (Hardware)

Firmware: [docs/features/gpio.md](../../docs/features/gpio.md) · Node-RED: [nodered/.../docs/gpio.md](../../nodered/node-red-contrib-de-esp32/docs/gpio.md) · Manager: [manager/docs/gpio.md](../../manager/docs/gpio.md)

## What it needs from the hardware
Any output-capable GPIO for `out`; any input-capable GPIO for `in`. Not usable: GPIO 6-11 (SPI flash), 34-39 as outputs, 34-39 with internal pull-up/down. GPIO 0, 2, 5, 12, 15 are strapping pins; GPIO 0 is the BOOT button and GPIO 2 the status LED (see [system](system.md)); GPIO 1/3 are the UART console.

## Provided today
`hardware/designs/base-s3` (rev A, draft, not reviewed) switches loads through four MOSFET outputs on IO15-IO18 (see [pwm](pwm.md)); a GPIO set high turns its output on. Free S3 pins not used by the board: IO1, IO3, IO7, IO38-IO42, IO45, IO46, TXD0/RXD0; none reach a connector. The expansion header carries IO4-IO6 as IO_A-IO_C.

## Electrical limits
On base-s3 the outputs are low-side switches, not logic outputs, and there are no protected digital inputs. IO35-IO37 are used by the octal PSRAM on the N16R8 module. IO0, IO3, IO45 and IO46 are S3 strapping pins.

## Gaps
The firmware currently targets the classic ESP32; base-s3 uses an ESP32-S3, so it needs an S3 build and board profile before any of this runs. No protected digital inputs and no JST-XH signal connectors on base-s3 yet.
