# OTA (Manager)

Firmware: [docs/features/ota.md](../../docs/features/ota.md) · Node-RED: [nodered/.../docs/ota.md](../../nodered/node-red-contrib-de-esp32/docs/ota.md) · Hardware: [hardware/docs/ota.md](../../hardware/docs/ota.md)

## What the Manager does with it
Keeps a firmware library, pushes an image to one device or many with `POST /api/v1/ota` (as jobs), rolls a device back with `ota.rollback`, and checks the result from `GET /api/v1/status`. Screens: Firmware page (library, target, bulk update), Device · System · Firmware card (status, Update sheet, Roll back).

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| System · Firmware card | Version / Built / ESP-IDF / Runtime | `ota.app_version`, `ota.compile_date` + `compile_time`, `ota.idf`, `ota.fw` | |
| System · Firmware card | Running slot + state chip | `ota.running_partition`, `ota.image_state` | `pending_verify` shows a banner |
| System · Firmware card | Next slot / Rollback possible | `ota.next_partition`, `ota.rollback_possible` | Roll back is disabled when false |
| System · Firmware card | Incoming version | `ota.incoming_version` | only when present |
| System · Firmware card | progress bar | `ota/progress` event `{session,bytes,total,percent}`, else `ota.session/bytes/total/percent` | labels for `writing`, `fetching`, `rebooting` |
| System · Firmware card | error | `ota.last_error` | |
| Firmware page | image version / date / time / IDF | image header `esp_app_desc_t` `version`, `date`, `time`, `idf_ver` | parsed by `server/src/firmware/image.ts` |
| Firmware page | Parallel, Stop after | bulk `concurrency` (1-4, default 2), `stopOnFailures` (default 1) | the page sends `skipSame: false` |
| Fleet / Firmware | matches target | `app_version` + `compile_date` + `compile_time` vs the target image | `matchesTarget` in `server/src/device/summary.ts` |

## Server side
Routes (`server/src/api/firmware.ts`): `GET/POST /api/firmware` (library; raw body, `X-Filename`), `POST /api/firmware/latest` (fetches `<firmwareBaseUrl>/firmware/de_esp32_runtime.bin`), `PUT /api/firmware/target`, `DELETE /api/firmware/:fid`, `POST /api/firmware/update` (bulk job), `POST /api/devices/:id/ota` `{firmwareId}`, `POST /api/devices/:id/rollback`. The proxy refuses `POST v1/ota` (`use_ota_endpoint`).

Image checks before storing (`image.ts`): first byte 0xE9, chip id 0 at offset 12, app desc magic 0xABCD5432 at offset 32, `project_name` = `de_esp32_runtime`, non-empty `version`, 288 B to 4 MB. Stored as `<dataDir>/firmware/<sha256>.bin` + `index.json`.

Update of one device (`server/src/firmware/update.ts`), steps `checking` → `uploading` → `rebooting` → `verifying`:
1. `GET /status`; refuse `ota_busy` (`ota.busy` or `session` `writing`/`fetching`), `pending_verify` (`image_state`), `image_too_large` (image > `ota.next_size`).
2. `POST /api/v1/ota`, `Content-Type: application/octet-stream`, `Content-Length` = file size; stall timeout 30 s, answer timeout 60 s. A reply without `ok:true` = `device_refused` with the device's `error`.
3. Poll `/status` every 2 s for up to 120 s until it restarted (went offline, `uptime_s` dropped, `session` left `rebooting`, or `running_partition` changed).
4. Same `running_partition` = `rolled_back`; `app_version` ≠ image `version` = `version_mismatch`; then wait up to 60 s for `image_state` to leave `pending_verify` / `new` (`valid` or `undefined` = done, else `not_confirmed`).

Rollback: requires `ota.rollback_possible`, sends `{cmd:"ota.rollback"}` over HTTP (`HTTP_ONLY` in `device/link.ts`, restart-expected in `device/client.ts`), then the same restart wait; same partition = `rollback_failed`.
Health shows `updating` while a job owns the device and `rebooting` during the restart window. Attention flags: `ota_pending_verify`, `ota_error` (`session === "error"`).

## Fake device
- `server/fake/fakeDevice.ts` `otaUpload`: needs `Content-Length`, refuses `ota busy` / `running image still pending verify`, emits `ota/progress` per 64 KB, reboots after `otaRebootDelayMs` (800), new image is `pending_verify` and turns `valid` after `verifyMs` (1000). Faults: `otaFailAtBytes`, `otaRollback`.
- `server/fake/ota.ts` `parseFakeImage` / `makeFakeImage`: checks 0xE9, app desc magic and project. No chip-id check, minimum 288 B (firmware: 32768 B), error strings differ from the firmware's.
- `server/fake/commands.ts` `handleOtaApply` / `handleOtaRollback`; `server/fake/state.ts` `otaStatus`. Fake `busy` is true only for `writing` / `fetching` (firmware: also `rebooting`). Fake `ota.apply` refuses `pending_verify` synchronously (firmware fails later in the fetch task with `session:"error"`) and its `note` text differs.

## Code
- `server/src/firmware/{index,update,image,store}.ts`, `server/src/api/firmware.ts`, `server/src/device/client.ts` (`upload`).
- `web/src/routes/device/system/{FirmwareCard,UpdateSheet,useSystemData}.tsx|ts`, `web/src/routes/FirmwarePage.tsx`, `web/src/routes/firmware/*`, `web/src/api/firmware.ts`.
- Types: `server/src/types/device-api.ts` `OtaStatus`, `OtaProgress`, `OtaApplyCommand`, `OtaRollbackCommand`; `server/src/types/api-firmware.ts`.

## Gaps
- `ota.apply` (URL pull) is typed but never sent.
- Images under 32768 B pass the Manager's check but the device refuses them (`image too small`).
- `tools/ota_push.py` is separate and does not use the Manager.
