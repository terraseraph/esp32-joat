# mod_mfrc522_README.md

## Purpose

Native IDF MFRC522 (RC522) SPI RFID reader. Instances share one SPI host; each reader has its own chip-select. Polls for UIDs and publishes `io/rfid`.

## User story

Live control: place a token on a reader wired to VSPI; MQTT `{prefix}/io` and the Hardware tab show the UID. A second reader on the same MOSI/MISO/SCK uses another CS.

## Public API

`mod_mfrc522_init()` registers type `mfrc522` with [module_manager_README.md](../module_manager/module_manager_README.md).

Pin schema: `sck`/`mosi`/`miso` (shared bus), `cs` (required, unique), `rst` (optional). Default bus `vspi`. Max 4 instances.

State key `mod_<id>`. Event `{id,type,present,uid}` on `io/rfid` only when presence or UID changes. `uid` is uppercase hex.

Commands: none beyond catalog add/remove (poll is enough). `module.cmd` returns not-supported.

## Depends on

[module_manager_README.md](../module_manager/module_manager_README.md),
[resource_manager_README.md](../resource_manager/resource_manager_README.md),
[event_bus_README.md](../event_bus/event_bus_README.md),
[state_registry_README.md](../state_registry/state_registry_README.md).

## Used by

Boot (`mod_mfrc522_init` after `module_manager_init`).

## How to update and maintain

Keep one poll task for all CS lines. Do not pull Arduino MFRC522. IRQ pin is not in this slice.

## How to test

Wire SCK 18, MISO 19, MOSI 23, SS 5, RST on a free output. `module.add` then present a card — UID on WebSocket `io/rfid`. Second reader: same bus pins, new CS. `pin.configure` GPIO 18 as out must fail owned-by `bus_vspi`.

## Known limits

Classic ESP32 SPI2/SPI3 only, 1 MHz mode 0. Poll ~150 ms. No crypto/auth. Version `0x00`/`0xFF` usually means wiring; the instance still stays configured.
