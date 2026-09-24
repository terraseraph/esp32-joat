# web_flash_README.md

## Purpose

Browser installer for a blank or recovered classic ESP32. A static page under `install/` writes the bootloader, partition table, and app over Web Serial, then sends the existing UART JSON commands for the device name and Wi-Fi.

## User story

Flash once from Chrome or Edge: plug in the DevKit, type a name and Wi-Fi password, and land on the board's address without joining the setup SoftAP first.

## Public API

Page: `install/index.html`. Manifest: `install/manifest.json` (ESP32, DIO, 40 MHz, 4 MB).

Images committed under `install/firmware/` (refresh with the stage script after a build):

- `install/firmware/bootloader.bin` at `0x1000`
- `install/firmware/partition-table.bin` at `0x8000`
- `install/firmware/de_esp32_runtime.bin` at `0x20000`

After boot the page writes `{"cmd":"identity.set_name",...}` and `{"cmd":"network.wifi.set",...}` with a `corr` field. Scan uses `network.wifi.scan`. Stage script: `.\tools\stage_web_flash.ps1`.

## Depends on

[serial_session_README.md](../../components/serial_session/serial_session_README.md),
[command_router_README.md](../../components/command_router/command_router_README.md),
[device_identity_README.md](../../components/device_identity/device_identity_README.md),
[network_manager_README.md](../../components/network_manager/network_manager_README.md),
[toolchain_README.md](toolchain_README.md).

## Used by

People installing a DevKit from a browser. Already-provisioned boards still update over Wi-Fi ([lan_discover_ota_README.md](lan_discover_ota_README.md)).

## How to update and maintain

1. Do not add installer-only commands. Name and Wi-Fi stay `identity.set_name` and `network.wifi.set`.
2. Keep manifest offsets aligned with `partitions.csv` (`ota_0` at `0x20000`). Empty `otadata` boots that slot, which is why erase defaults on.
3. Classic ESP32 only. Reject chip names that look like S2, S3, C3, and the rest.
4. Console baud stays 115200 (`CONFIG_ESP_CONSOLE_UART_BAUDRATE`).

## How to test

1. `node --test install/test/console.test.js`.
2. Stage bins, serve `install/` with `python -m http.server`, open it in Chrome, flash one DevKit, and confirm the Overview name and STA address.

## Known limits

Firefox and Safari have no Web Serial. `file://` cannot open a port. Opening the port can reset the board; the page waits for a new `de-esp32>` prompt. Hold BOOT if auto-reset misses download mode. Erase drops NVS. This path rewrites the bootloader and `ota_0`; it is not the A/B OTA update.
