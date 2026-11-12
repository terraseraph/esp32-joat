# MQTT (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/mqtt.md) · [Manager](../../manager/docs/mqtt.md) · [Hardware](../../hardware/docs/mqtt.md)

## What it does
Optional MQTT client. Commands arrive on `{prefix}/system/command` and go through `command_router`, replies go to `{prefix}/events`, live I/O goes out on `{prefix}/io`. The device works without it; there is no broker in the firmware.

## How it works on the ESP
- ESP-IDF `mqtt` client, MQTT 3.1.1, WebSocket transport off (`sdkconfig.defaults`). Network timeout 10 s. Client id = `device_id()` (MAC hex).
- `{prefix}` = `{root}/{topic_id}`. `root` from NVS (default `devices`), `topic_id` = `device_topic_id()` (sanitized device name, or the MAC id when unnamed).
- Last will: `{prefix}/availability` = `offline`, QoS 1, retained. On connect it publishes `online`, subscribes to the subscribe topics (QoS 1), publishes `status` and `api` (retained), then a hydrate burst (`io_emit_snapshot()`: one `io` message per state-registry key).
- On connect, when `topic_id` differs from the MAC id, the retained `availability` / `status` / `api` under `{root}/{mac}` are cleared (empty retained payload).
- Event bus `mqtt/reconfigure` (from `mqtt.configure`) and `identity/rename` restart the client. The old prefix's retained `availability` / `status` / `api` are cleared first when the root or topic id changed.
- Inbound payloads are copied into a 512-byte buffer: anything over 511 bytes is cut and fails to parse. Non-JSON is ignored with no reply. Every topic subscribed is treated as `system/command` (`+` in `components/+/set` is not interpreted).
- Connected MQTT counts as a live sink (`RuntimeStatus::set_live_mqtt`), so ADC/touch sample and telemetry runs without a browser.
- TLS: no CA or certificate is set in `mqtt_start()`. Whether an `mqtts://` URI connects is not verified.

Backpressure on `io` (measured as `esp_mqtt_client_get_outbox_size`, bytes not yet sent plus unacked QoS 1):

| Outbox | Effect |
|---|---|
| > 8 KB (`kOutboxHigh`) | backlog starts; `latest` sources are sent at QoS 0 |
| > 16 KB (`kOutboxMax`) | `latest` frames dropped (`io_dropped`++) |
| > 32 KB (`kOutboxReliableMax`) | `reliable` frames dropped too |
| back under 2 KB (`kOutboxLow`) | backlog ends; if anything was dropped, `io_emit_snapshot()` re-emits every pin/module once (on the event bus, so WS/serial/UDP see the burst too) |

Delivery class per source: `pin.configure` / `module.add` field `delivery` (`reliable` | `latest`). Default: `in` and `touch` pins `reliable`, other pin modes `latest`, modules use their type's `reliable_default` (`runtime_core/src/io_delivery.cpp`, `command_router.cpp` `apply_one_pin`).

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `uri` | string, < 128 chars | none | e.g. `mqtt://192.168.1.10:1883`. Not validated by the firmware. |
| `user` | string, < 64 chars | `""` | Written only when the request has `user` as a string. Empty = no auth. |
| `password` | string, < 64 chars | `""` | Written together with `user`. Never readable back. |
| `root` | `A-Z a-z 0-9 _ -` and `/`, < 48 chars | `devices` | Repeated, leading and trailing `/` removed; empty after cleaning = `devices`. |
| `enabled` | u8 | 0 | Set to 1 by every `mqtt.configure`. No command sets it back to 0 (only `system.factory_reset`). |

NVS namespace `mqtt`, keys `uri`, `user`, `password`, `root`, `enabled`. Read at boot (`mqtt_start()` in `main/app_main.cpp`) and applied immediately after `mqtt.configure` (client stop + start).

## Commands
Also on HTTP `POST /api/v1/mqtt` (body = the fields, `cmd` added by the server).
```json
{"cmd":"mqtt.configure","uri":"mqtt://192.168.1.10:1883","root":"devices","user":"u","password":"p"}
```
All fields optional, but a URI must be in the request or already stored.
```json
{"v":1,"ok":true,"result":{"uri":"mqtt://192.168.1.10:1883","root":"devices"}}
```
Errors: `uri required (mqtt://host:1883)`.

Any command can be sent over MQTT: publish the same JSON as `POST /api/v1/command` to `{prefix}/system/command`. The reply envelope (`{"v":1,"ok":...,"corr":...}`) is published to `{prefix}/events`.

## Events and state
Topics (`kMqttTopics` in `mqtt_manager.cpp`, the only list):

| Suffix | Dir | QoS / retain | Payload |
|---|---|---|---|
| `system/command` | sub | 1 | command JSON |
| `config/set` | sub | 1 | alias of `system/command` |
| `components/+/set` | sub | 1 | alias of `system/command` |
| `availability` | pub | 1, retained | `online` / `offline` (LWT) |
| `status` | pub | 1, retained | `{v,id,name,topic_id,fw}` |
| `telemetry` | pub | 0 | telemetry snapshot (bare data, see [status.md](status.md)), every 15 s |
| `io` | pub | 1 (0 under backlog for `latest`) | `{"topic":"io/gpio","data":{...}}`, same frame as WebSocket |
| `events` | pub | 1 | command replies |
| `api` | pub | 1, retained | `{v,id,name,topic_id,fw,openapi,ui,prefix,root,command}` |

`GET /api/v1/mqtt` and `mqtt` in `GET /api/v1/status` / telemetry (`mqtt_status_json()`):
`connected`, `uri` (in-RAM, `""` when never started), `reconnects`, `published`, `publish_fail`, `received`, `last_error` (`disconnected` / `error`), `backlog` (bool), `backlogs` (count of backlog starts), `io_dropped`, `outbox` (bytes), `root`, `prefix`, `topic_id`, `sub[]`, `pub[]` (suffixes).

`GET /api/v1/openapi.json` `x-mqtt`: `root`, `prefix`, `topics[]` of `{topic,suffix,subscribe,publish,retain,summary}`.

WebSocket: `mqtt/reconfigure` is published on the event bus with the raw request (including `password`) plus `old_root`, and the web server forwards every bus topic, so WebSocket viewers receive the password.

## Code
- `components/mqtt_manager/src/mqtt_manager.cpp`: `mqtt_init`, `mqtt_start`, `mqtt_stop`, `mqtt_event_handler`, `on_io`, `on_reconfigure`, `retire_topics`, `backlog_recover`, `mqtt_status_json`, `mqtt_topics_json`, `mqtt_publish_telemetry_raw`.
- `components/command_router/src/command_router.cpp`: `mqtt.configure` (NVS writes, root cleaning, `mqtt/reconfigure`).
- `components/runtime_core/src/io_delivery.cpp`: delivery classes.
- `components/web_server/src/web_server.cpp`: `GET/POST /api/v1/mqtt`, `x-mqtt`.
