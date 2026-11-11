# Status and live data (Node-RED)

Firmware: [docs/features/status.md](../../../docs/features/status.md) · Manager: [manager/docs/status.md](../../../manager/docs/status.md)

## What Node-RED does with it
- `GET /api/v1/status` is used by Scan and Probe in the `de-esp32-device` editor to recognise a device and fill its fields.
- The `de-esp32-device` runtime keeps one live connection (WebSocket `ws://host:port/api/v1/ws`, or MQTT `{prefix}/io` when a broker is set) while any gpio-in or module node listens, sends `io.hydrate` when it opens, and routes `io/*` frames to the listening nodes.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-device` | `host`, `port` | HTTP server port 80 | used for `/status`, `/command` and `/ws` |
| `de-esp32-device` | `deviceId` | `status.id` | filled by Scan / Probe |
| `de-esp32-device` | `deviceName` | `status.name` | |
| `de-esp32-device` | `topicId` | `status.topic_id` (or `status.mqtt.topic_id`) | |
| `de-esp32-device` | `mqttRoot` | `status.mqtt.root` | |

Scan / Probe result (`fingerprint.summarize`): `ip`, `id`, `name`, `hostname`, `fw`, `topic_id`, `mqtt_prefix` (`mqtt.prefix`), `mqtt_root` (`mqtt.root`), `board` (`status.board`), `boot_state`, `partition` (`ota.running_partition`), `via`.
`fingerprint.isOurs`: `ota.project === "de_esp32_runtime"`, or `hostname` starts with `esp32-`, or `chip` starts with `ESP32` and `id` is 12 chars.

## Messages
Frames are `{topic, data}`; anything whose `topic` does not start with `io/` is dropped (`telemetry`, `net`, `ota/progress`, `identity/rename`, `mqtt/reconfigure`, command replies).

| Parser (`lib/io.js`) | Matches | Output |
|---|---|---|
| `parseIoMessage` | `data.gpio` is a number | `{gpio, value, mode, id, topic, data}`; `value` = `mv` (adc), `duty` (pwm), `angle` (servo), else `level`, `duty`, `value`, `mv` |
| `parseModuleEvent` | `data.id` set, no `gpio` | `{id, present, uid, topic, data}` |

gpio-in sends `{payload: value, gpio, mode, topic: id || "gpio_<n>", data}`.

## Commands sent / events used
| Command | When |
|---|---|
| `io.hydrate` | each time the WebSocket opens, or after the MQTT `{prefix}/io` subscribe |
| `GET /api/v1/status` | editor Scan (per mDNS candidate, 800 ms timeout) and Probe (1500 ms) via `/de-esp32/status` |
| `GET /api/v1/pins` | editor `/de-esp32/pins` admin route |

WebSocket reconnects every 3 s while wanted; it closes when the last listener unsubscribes.

## Code
- `nodes/de-esp32-device.js`: `_ensureLive`, `_startWs`, `_scheduleWs`, `_dispatchIo`, admin routes `/de-esp32/scan`, `/de-esp32/status`, `/de-esp32/pins`.
- `lib/http.js`: `getStatus`, `getPins`, `postCommand`.
- `lib/io.js`, `lib/fingerprint.js`, `lib/discover.js`.

## Gaps
- `status.board` does not exist in the firmware status, so `board` is always `""`.
- When the device already has 4 WebSocket viewers the socket opens but gets no frames; Node-RED shows it as live and has no polling fallback.
- `telemetry`, heap/memory, `sinks`, `net` and `identity/rename` events are not used.
