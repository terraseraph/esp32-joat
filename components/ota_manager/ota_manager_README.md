# ota_manager_README.md

## Purpose

A/B firmware updates on the 4 MB partition table. Write a new app image into the inactive slot, boot it as **pending**, and either confirm it after a healthy runtime or roll back.

## User story

Flash once over USB, then ship firmware over Wi-Fi: upload a `.bin` from the System tab, or pull `http(s)://` from MQTT / REST. A crash before the runtime marks itself healthy restores the previous slot.

## Public API

- `ota_init()`, `ota_mark_valid(safe_mode)`, `ota_status_json()`, `ota_is_busy()`
- Stream: `ota_begin_write` / `ota_write_chunk` / `ota_finish_write` / `ota_abort_write` / `ota_schedule_reboot`
- `ota_apply_url(url)` — background GET, then reboot
- `ota_rollback()` — reboot into the previous valid slot (does not return on success)

REST:

- `GET /api/v1/ota` — status (also nested under `/api/v1/status`)
- `POST /api/v1/ota` — raw `application/octet-stream` body (the image is not JSON, so this is the one HTTP path that does not go through `command_router`)

Commands (HTTP `POST /api/v1/command`, WebSocket, MQTT `devices/{id}/system/command`):

- `ota.apply` `{ "url": "http://192.168.1.10/de_esp32_runtime.bin" }`
- `ota.rollback`

UART: `ota` prints the status JSON.

NVS namespace `ota` is reserved; this MVP does not store keys there.

Event `ota/progress` `{session, bytes, total, percent, error?}`.

Kconfig: `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` (in `sdkconfig.defaults`). Partition table `partitions.csv` (`ota_0` / `ota_1` / `otadata`).

## Depends on

[runtime_core_README.md](../runtime_core/runtime_core_README.md),
[event_bus_README.md](../event_bus/event_bus_README.md),
IDF `app_update`, `esp_http_client`, mbedtls certificate bundle.

## Used by

[command_router_README.md](../command_router/command_router_README.md),
[web_server_README.md](../web_server/web_server_README.md),
[telemetry_README.md](../telemetry/telemetry_README.md),
boot (`ota_mark_valid` after healthy).

## How to update and maintain

1. Do not shrink OTA slots without measuring `idf.py size`.
2. Confirm only after config + event loop + network + I/O apply (`app_main` calls `ota_mark_valid` after `mark_healthy`). Safe mode on a pending image rolls back immediately.
3. Reject images whose `project_name` is not `de_esp32_runtime` and whose chip id is not classic ESP32.
4. Signed images / anti-rollback secure version are Phase 6 — do not add `CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK` yet.
5. New JSON control stays in `command_router`. Keep `POST /api/v1/ota` as the binary pipe only.

## How to test

1. `idf.py partition-table` shows two app slots ~0x1C0000.
2. Flash **bootloader + table + app** so rollback support is in the bootloader (not only the app).
3. From the System tab upload the freshly built `de_esp32_runtime.bin`. After reboot, `running_partition` should be the other slot and `image_state` should become `valid` once healthy.
4. MQTT: publish `{"cmd":"ota.apply","url":"http://<host>/de_esp32_runtime.bin"}` to `devices/<id>/system/command`.
5. Panic the new image before the healthy log line — next reset should return to the previous slot.

## Known limits

- Images must be this project's app binary (`project(de_esp32_runtime)`), not a merged flash dump.
- HTTPS pull uses the public CA bundle. Self-signed LAN servers should use `http://`.
- No upload progress on the HTTP POST itself beyond `GET /api/v1/ota` / `ota/progress` (the POST connection is busy sending the file).
- `ota.rollback` / reboot may not return an HTTP body.
- A hung image that never resets will not roll back until a reset happens.
