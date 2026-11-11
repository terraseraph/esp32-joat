# MQTT (Node-RED)

Firmware: [docs/features/mqtt.md](../../../docs/features/mqtt.md) · Manager: [manager/docs/mqtt.md](../../../manager/docs/mqtt.md)

## What Node-RED does with it
The `de-esp32-device` config node can use a Node-RED `mqtt-broker` node. With a broker it sends commands to `{prefix}/system/command` and listens to `{prefix}/io`; without one it uses HTTP + WebSocket. Scan can also find devices from retained MQTT topics. Node-RED never sends `mqtt.configure`: the broker must be set on the device elsewhere.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-device` | `broker` | — | optional `mqtt-broker` node; switches commands and live data to MQTT |
| `de-esp32-device` | `mqttRoot` | NVS `mqtt/root` (`mqtt.root` in status) | default `devices`; typed by hand or filled by Scan / Probe from `status.mqtt.root` or `api.root` |
| `de-esp32-device` | `topicId` | `device_topic_id()` (`topic_id`) | read-only; from Scan / Probe / rename reply |
| `de-esp32-device` | `deviceId` | `device_id()` (`id`) | read-only; used as the topic slug when `topicId` is empty |

Prefix = `${mqttRoot}/${topicId || deviceId}` (`mqttPrefix()` in `nodes/de-esp32-device.js`), the same as firmware `{root}/{topic_id}`.

## Messages
No node takes MQTT settings in `msg`. Live `io` frames are parsed the same as WebSocket frames (`lib/io.js`), see [status.md](status.md).

## Commands sent / events used
| What | Topic | When |
|---|---|---|
| any command (`pin.configure`, `pin.set`, `io.hydrate`) via `device.command()` | publish `{prefix}/system/command`, QoS 1, not retained | gpio-in/out deploy and per message; `io.hydrate` after subscribing |
| live I/O | subscribe `{prefix}/io`, QoS 1 | first gpio-in / module listener |
| Scan | subscribe `{root}/+/api` and `{root}/+/availability`, QoS 0, with a short-lived `mqtt.js` client | editor Scan button with a broker selected |

Scan reads from `api`: `id`, `name`, `topic_id`, `fw`, `prefix`, `root`; from `availability`: `online` / `offline`. `de-esp32-module` always uses HTTP (`http.postCommand`) for `module.list` / `module.add`.

## Code
- `nodes/de-esp32-device.js`: `mqttPrefix`, `command`, `_startMqtt`, `_stopMqtt`.
- `nodes/de-esp32-device.html`: `broker`, `mqttRoot`, `topicId` fields.
- `lib/discover.js`: `mqttDiscover`.
- `lib/fingerprint.js`: `summarize` (`mqtt_prefix`, `mqtt_root`, `topic_id`).

## Gaps
- Replies on `{prefix}/events` are not read. A command sent over MQTT always resolves `{ok:true, via:"mqtt"}`, so `pin.configure` errors are never shown when a broker is attached.
- No `mqtt.configure`, no MQTT status display, no `telemetry` / `status` / `availability` use outside Scan.
- A rename or root change on the device is not followed: `topicId` / `mqttRoot` stay as saved until the node is edited.
- Firmware cuts inbound MQTT payloads at 511 bytes; Node-RED does not check the size.
