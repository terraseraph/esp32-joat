# board_profiles_README.md

## Purpose

Board-level constants separate from SoC capability: DevKitC status LED GPIO2 (active high), BOOT GPIO0, physical header order, and default SPI/I2C/UART pin groups.

## User story

Unprovisioned boot blinks the onboard LED. Physical recovery uses the BOOT button **after** app start. The Hardware tab draws this profile's 38-pin DevKitC layout. VSPI filter highlights the usual RFID/SD SPI pins (RC522 "SDA" is chip-select).

## Public API

`board_profile()` → `{id, name, status_led_gpio, status_led_active_high, boot_gpio}`.

`board_profile_json()` → same plus `header.left/right` pads (`silk`, `gpio`, `kind`) and `buses[]` (`id`, `kind` spi/i2c/uart, `label`, `hint`, `pins`). USB is at the bottom of the diagram.

## Depends on

[capability_manager_README.md](../capability_manager/capability_manager_README.md) (documentation only; LED pin is still a strap pin).

## Used by

boot orchestrator (LED + button tasks), web hardware tab, Node-RED pinout ([nodered_README.md](../../docs/features/nodered_README.md)).

## How to update and maintain

Add a new profile struct **and** its header/bus tables; select via Kconfig later. Do not put flash-pin rules here. Keep silkscreen order in sync with the physical board.

## How to test

LED slow blink in AP-only, solid when STA has IP (and not safe mode).

## Known limits

One profile compiled in. WROVER/PSRAM boards are not a Phase 1 target. 30-pin DevKit variants omit flash GPIOs 6–11; this profile is the 38-pin silkscreen. Bus tables are the default pin mux for the UI; a live SPI host is claimed when an MFRC522 instance is enabled, and i2c0 when a BME280 is enabled.
