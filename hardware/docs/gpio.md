# Digital in/out (Hardware)

Firmware: [docs/features/gpio.md](../../docs/features/gpio.md) · Node-RED: [nodered/.../docs/gpio.md](../../nodered/node-red-contrib-de-esp32/docs/gpio.md) · Manager: [manager/docs/gpio.md](../../manager/docs/gpio.md)

## What it needs from the hardware
Any output-capable GPIO for `out`; any input-capable GPIO for `in`. Not usable: GPIO 6-11 (SPI flash), 34-39 as outputs, 34-39 with internal pull-up/down. GPIO 0, 2, 5, 12, 15 are strapping pins; GPIO 0 is the BOOT button and GPIO 2 the status LED (see [system](system.md)); GPIO 1/3 are the UART console.

## Provided today
Nothing yet. No design routes ESP32 GPIOs to connectors. The `relay-8` board does not use GPIOs for switching: its relays are driven through an I2C expander, which the firmware does not drive (see [modules](modules.md)).

## Electrical limits
The firmware only sets logic levels (3.3 V on the ESP32). Current limits are those of the pin; nothing in the repo adds protection or level shifting. The firmware offers no internal pull on 34-39.

## Gaps
The ESP32-S3 base board is planned but not designed; no `hardware/designs/` entry exists. The firmware currently targets the classic ESP32, so pin numbers here are classic-ESP32 pins. Planned, not designed: MOSFET outputs for switching, and screw terminals / JST-XH connectors for inputs and outputs.
