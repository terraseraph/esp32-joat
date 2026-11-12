# MQTT (Manager)

Firmware: [docs/features/mqtt.md](../../docs/features/mqtt.md) · Node-RED: [nodered/.../docs/mqtt.md](../../nodered/node-red-contrib-de-esp32/docs/mqtt.md) · Hardware: [hardware/docs/mqtt.md](../../hardware/docs/mqtt.md)

## What the Manager does with it
The Manager does not speak MQTT (no MQTT client; it talks HTTP and WebSocket only). It shows the device's MQTT status and sends `mqtt.configure`: Device · Network tab (MQTT card + Configure sheet), MQTT chips on Device · Live and Fleet, the `mqtt_disconnected` attention flag, and the MQTT step of backup restore.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Network · MQTT card | state chip | `mqtt.uri` (`""` = "Not set up"), `mqtt.connected` | |
| Network · MQTT card | Broker / Topic root / Topic id | `mqtt.uri`, `mqtt.root`, `mqtt.topic_id` | prefix shown from `mqtt.prefix` |
| Network · MQTT card | Published / Failed / Received / Reconnects / Last error | `published`, `publish_fail`, `received`, `reconnects`, `last_error` | |
| Network · MQTT card | Topics list | `sub[]`, `pub[]` | |
| Configure sheet | Broker URI | `uri` | must match `^mqtts?://host(:port)?$` (`validateMqttUri`) |
| Configure sheet | Topic root | `root` | `A-Za-z0-9_-/`, empty = `devices`; preview `mqttPrefixPreview(root, topic_id)` |
| Configure sheet | Change credentials / Username / Password | `user`, `password` | both sent only when the box is ticked (firmware writes them only when `user` is a string) |
| Live, Fleet | MQTT chip | summary `mqtt.configured` (`uri !== ""`), `mqtt.connected` | live telemetry `mqtt.connected` wins on Live |

The sheet sends only changed fields (`buildMqttConfigure`); no change = no request. The card is refreshed from `GET v1/mqtt` and from live `telemetry.mqtt` (`useFresh`).

## Server side
- `POST /api/devices/:id/command` (or the WS `cmd` path) with `{cmd:"mqtt.configure", uri?, root?, user?, password?}`; `POST v1/mqtt` through the proxy is mapped to `mqtt.configure` by `commandFor` in `server/src/device/client.ts`.
- `GET /api/devices/:id/v1/mqtt` → device `GET /api/v1/mqtt`.
- Health poll stores `last.mqtt_configured` / `last.mqtt_connected` in the registry (`lastFromStatus`); `attentionFromStatus` adds `mqtt_disconnected` when `uri` is set and not connected.
- Device link drops `mqtt/reconfigure` frames (they carry the password) before fan-out or logging (`server/src/device/link.ts` `onEvent`).
- Backups store `mqtt: {uri, root}` only, with gap `mqtt_credentials` (`server/src/backups/snapshot.ts`). Restore adds an `mqtt.configure` step `{uri, root?}` when the target's `uri` or `root` differs (`server/src/backups/planner.ts`); MQTT cannot be switched off, so a backup without MQTT leaves the device's settings.

## Fake device
`server/fake/commands.ts` `handleMqttConfigure`: same `uri required (mqtt://host:1883)` error, keeps credentials only when `user` is a string, sets `enabled` and `connected` true, emits `mqtt/reconfigure` with the password (like the firmware). `server/fake/state.ts` `mqttStatus` builds the status. Root cleaning only strips invalid characters; it does not collapse or trim `/` like the firmware. `backlog` is a number and `backlogs` an object in the fake.

## Code
- `web/src/routes/device/network/MqttCard.tsx`, `logic.ts` (`validateMqttUri`, `validateMqttRoot`, `buildMqttConfigure`, `mqttPrefixPreview`), `NetworkTab.tsx`.
- `web/src/routes/device/live/LiveTab.tsx`, `web/src/routes/fleet/logic.ts` (`mqttInfo`).
- `server/src/device/summary.ts`, `server/src/device/link.ts`, `server/src/backups/{snapshot,planner,deviceState}.ts`.
- Types: `server/src/types/device-api.ts` `MqttStatus`, `MqttConfigureCommand`, `MqttConfigureResult`, `MqttReconfigureEvent`.

## Gaps
- `MqttStatus.backlog` is typed `number` and `backlogs` an object; the firmware sends `backlog` as a bool and `backlogs` as a count. Neither, nor `io_dropped` / `outbox`, is shown.
- The sheet accepts `mqtts://`; the firmware sets no CA or certificate, so TLS is unverified.
- No way to read topic traffic, `telemetry` or `availability` from the broker.
