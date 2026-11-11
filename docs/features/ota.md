# OTA (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/ota.md) · [Manager](../../manager/docs/ota.md)

## What it does
A/B firmware updates. A new app image is written into the inactive slot (HTTP upload or URL pull), the device reboots into it as `pending_verify`, and confirms it once the runtime is healthy. A crash before that, or landing in safe mode, returns to the previous slot.

## How it works on the ESP
- Partition table `partitions.csv` (4 MB): `otadata` 0xf000, `ota_0` 0x20000 and `ota_1` 0x1E0000, each 0x1C0000 (1792 KB). `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` and `CONFIG_APP_ROLLBACK_ENABLE=y` in `sdkconfig.defaults`. Flash bootloader + table + app once over USB so the bootloader has rollback support.
- Checks while writing: first byte magic `ESP_IMAGE_HEADER_MAGIC` (0xE9), header `chip_id` = classic ESP32. At the end: size >= 32768 bytes (`kMinImage`), `esp_ota_end` validation, and `project_name` must equal the running app's (`de_esp32_runtime`). Then `esp_ota_set_boot_partition` and a reboot 800 ms later.
- One session at a time (mutex). `session`: `idle` → `writing` (upload) or `fetching` (URL) → `rebooting`; failures leave `error` (a new upload or `ota.apply` starts over from `error`).
- URL pull runs on task `ota_url` (12 KB stack): `esp_http_client`, 30 s timeout, 1 KB reads, user agent `de-esp32-runtime/<fw>`, `https://` uses the IDF CA bundle (`esp_crt_bundle_attach`). HTTP status must be 200. Content-Length is used as `total` when sent.
- Confirm: `app_main` calls `ota_mark_valid(safe_mode)` after `mark_healthy()` (config, network, MQTT, I/O, modules and rules are applied by then). A `pending_verify` image is marked valid; in safe mode it is marked invalid and the device reboots into the old slot.
- A hung image that never resets does not roll back until something resets it.
- Images must be the app binary (`build/de_esp32_runtime.bin`), not a merged flash dump. Signed images / anti-rollback are not enabled.

## Settings
None. NVS namespace `ota` is erased by factory reset but no keys are stored in it.

## Commands
Upload (the only HTTP path that is not a `command_router` command): `POST /api/v1/ota`, raw `application/octet-stream` body, `Content-Length` required. The image must fit the slot (`next_size`). Reply after the last byte, then reboot:
```json
{"v":1,"ok":true,"result":{ ...ota status, "session":"rebooting" ... }}
```
Errors (`{"v":1,"ok":false,"error":"..."}`): `Content-Length required`, `ota busy`, `no OTA slot`, `image larger than OTA slot`, `image too small`, `running image still pending verify`, `upload interrupted`, `not an ESP32 app image (bad magic)`, `image is not for classic ESP32`, `image failed validation`, `could not read new app description`, `image project name does not match de_esp32_runtime`, or an `esp_err_to_name` string.

URL pull (HTTP `POST /api/v1/command`, WebSocket, MQTT `{prefix}/system/command`, UART JSON):
```json
{"cmd":"ota.apply","url":"http://192.168.1.10/de_esp32_runtime.bin"}
```
Replies at once with the OTA status plus `"note":"fetching; device reboots when the image is written"`; the download continues in the background. Sync errors: `url must be http:// or https://`, `url too long` (>= 384 chars), `ota busy`, `no mem`, `could not start ota task`. Later failures (`HTTP not 200`, `HTTP read failed`, `http init failed`, the write/finish errors above) show as `session:"error"` + `last_error`.

```json
{"cmd":"ota.rollback"}
```
Reboots into the previous slot; on success no reply arrives (the device restarts inside the call). Errors: `ota busy`, `no valid previous slot`.

UART console: `ota` prints the status JSON.

## Events and state
`GET /api/v1/ota`, `ota` in `GET /api/v1/status` and telemetry (`ota_status_json()`):

| Field | Notes |
|---|---|
| `fw` | `RUNTIME_VERSION` |
| `idf`, `app_version`, `project`, `compile_date`, `compile_time` | from `esp_app_get_description()` of the running app |
| `running_partition`, `running_offset`, `running_size` | `ota_0` / `ota_1` |
| `image_state` | `new`, `pending_verify`, `valid`, `invalid`, `aborted`, `undefined` |
| `next_partition`, `next_size` | the slot the next image goes to |
| `rollback_possible` | `esp_ota_check_rollback_is_possible()` |
| `busy` | `session` is not `idle` and not `error` (so `rebooting` is busy) |
| `session`, `bytes`, `total`, `percent` | `total` 0 when unknown |
| `last_error`, `incoming_version`, `incoming_project` | only when set |

Event bus `ota/progress` `{session, bytes, total, percent, error?}`: on start, every 64 KB (`kProgressStride`), on errors and at the end. Reaches WebSocket `/api/v1/ws` only (MQTT and serial do not subscribe to it). The HTTP upload connection itself gets no progress.

## Code
- `components/ota_manager/src/ota_manager.cpp`: `ota_init`, `ota_mark_valid`, `ota_status_json`, `ota_begin_write` / `ota_write_chunk` / `ota_finish_write` / `ota_abort_write`, `ota_apply_url` + `fetch_task`, `ota_rollback`, `ota_schedule_reboot`.
- `components/web_server/src/web_server.cpp`: `api_ota`, `api_ota_upload`.
- `components/command_router/src/command_router.cpp`: `ota.apply`, `ota.rollback`.
- `main/app_main.cpp`: `ota_mark_valid` after `mark_healthy`, console `ota`.
- `tools/ota_push.py` (`tools/ota_push.cmd`): finds a device (mDNS + HTTP scan via `tools/discover.py`, or `--ip` / `--name`), POSTs `--bin` (default `build/de_esp32_runtime.bin`) to `/api/v1/ota` with a 150 s timeout, waits for `/status` to come back and prints `partition` (`ota.running_partition`) and `boot_state`. Remembers `last_ota_ip`.
