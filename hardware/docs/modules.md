# Addon modules (Hardware)

Firmware: [docs/features/modules.md](../../docs/features/modules.md) · Node-RED: [nodered/.../docs/modules.md](../../nodered/node-red-contrib-de-esp32/docs/modules.md) · Manager: [manager/docs/modules.md](../../manager/docs/modules.md)

## What it needs from the hardware
Depends on the module type: `mfrc522` needs an SPI bus plus CS, `bme280` an I2C bus (see [rfid](rfid.md), [bme280](bme280.md)). Modules are software types; the firmware has no module type for expansion boards.

## Provided today
Partly. `hardware/designs/base-s3` (rev A, draft, not reviewed) has a 2x8 2.54 mm shrouded expansion header (`hardware/lib/expansion-bus.tsx`): 5 V x2, 3.3 V x2, GND x2, SDA (IO8), SCL (IO9), INT (IO48, 10k pull-up on the base), CS (IO10), SCK/MOSI/MISO (IO12/IO11/IO13, shared with the W5500), IO_A/IO_B/IO_C (IO4/IO5/IO6, intended for I2S). The base board fits 4.7k I2C pull-ups. `hardware/designs/relay-8` is an expansion board on the older 6-pin header (`hardware/lib/expansion-header.tsx`), with a PCA9554 at 0x20 and a 24C02 ID EEPROM at 0x50 (`hardware/lib/id-eeprom.tsx`).

## Electrical limits
Header pins are about 1 A each, so 5 V to expansion boards is limited to about 2 A total. I2C addresses taken on base-s3: INA226 at 0x40, 0x41, 0x44, 0x45. relay-8 puts about 576 mA of coils through its single 5 V pin; it is a tooling proof, not review-ready.

## Gaps
The firmware currently targets the classic ESP32; base-s3 uses an ESP32-S3, so it needs an S3 build and board profile before any of this runs. relay-8 still uses the 1x6 header and its own I2C pull-ups; it needs moving to the 2x8 bus (pull-ups DNP). Planned, not implemented: expansion auto-detect. No firmware reads the ID EEPROM and no record format is defined. There is no firmware module type for the PCA9554.
