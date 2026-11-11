# OTA (Node-RED)

Firmware: [docs/features/ota.md](../../../docs/features/ota.md) · Manager: [manager/docs/ota.md](../../../manager/docs/ota.md)

## What Node-RED does with it
Not used for updates: no node uploads images or sends `ota.apply` / `ota.rollback`. Two `ota` status fields are read to recognise and describe a device.

## Node settings
None.

## Messages
None.

## Commands sent / events used
| Field read | From | Used for |
|---|---|---|
| `ota.project` | `GET /api/v1/status` | `fingerprint.isOurs()`: `de_esp32_runtime` marks a de-esp32 device |
| `ota.running_partition` | `GET /api/v1/status` | `fingerprint.summarize()` → `partition` in Scan / Probe results |

`ota/progress` WebSocket frames are ignored (`lib/io.js` only passes `io/*`).

## Code
`lib/fingerprint.js`.

## Gaps
All of OTA: upload, URL pull, rollback, progress and `image_state` / `pending_verify` display.
