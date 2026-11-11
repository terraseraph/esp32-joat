# Status and live data (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/status.md) · [Manager](../../manager/docs/status.md)

## What it does
`GET /api/v1/status` is one JSON snapshot of the device: identity, heap, uptime, network, MQTT, OTA and every live I/O value. Live changes are pushed as `{topic, data}` frames over WebSocket `/api/v1/ws`, MQTT `{prefix}/io`, the UART session and UDP. `io.hydrate` re-sends every current value.

## How it works on the ESP
- `state_registry` is a RAM map (max 48 keys, no NVS) of observed I/O: `gpio_N`, `pwm_N`, `servo_N`, `adc_N`, `touch_N`, `mod_<id>`. Drivers call `state_set(key, json)` and publish the same JSON on the event bus (`io/gpio`, `io/pwm`, `io/servo`, `io/adc`, `io/touch`, `io/rfid`, `io/env`).
- `event_bus` prints each event once as `{"topic":"<topic>","data":<payload>}` and shares that frame with every sink.
- Sinks:

| Sink | Gets | When |
|---|---|---|
| WebSocket `/api/v1/ws` | every bus topic | only while `live_viewers() > 0`. Max 4 clients (`s_ws_fds[4]`); a 5th connects but gets no events (command replies still work). |
| MQTT `{prefix}/io` | `io/*` | while connected (see [mqtt.md](mqtt.md)) |
| UART session | `io/*` as NDJSON | after `serial.hello` / `hydrate` until `serial.bye` |
| UDP | `io/*` | when `udp.configure` has targets |

- ADC and touch only sample live while `live_sinks() > 0` (WS viewers + MQTT + serial + UDP + rules). ADC publishes when the value moves past `hysteresis_mv`; `GET /status`, `GET /pins`, telemetry and `io.hydrate` first call `io_adc_refresh()` / `io_touch_refresh()`.
- Telemetry task (`telemetry`, 4 KB stack): every 15 s, only if MQTT is connected or a WebSocket viewer is open. Builds `telemetry_snapshot()`, publishes it to MQTT `{prefix}/telemetry` (bare data) and the bus topic `telemetry` (WebSocket). Nothing is stored on the device.
- Memory pressure (`runtime_core/src/memory_budget.cpp`, internal DRAM only): `critical` when the largest block < 12 KB or free < 24 KB; `warn` when largest < 48 KB or free < 48 KB; else `ok`. `memory_admit` refuses module allocations when already critical, when the block will not fit, or when free heap would drop under the 24576-byte reserve.

## Settings
None.

## Commands
```json
{"cmd":"io.hydrate"}
```
```json
{"v":1,"ok":true,"result":{"pins":5}}
```
Re-publishes every registry key on its `io/*` topic, so all sinks get a full burst. `pins` counts every key emitted, modules included. No errors.

UART console `status` prints identity and network (not the JSON below).

## Events and state
`GET /api/v1/status` = `GET /api/v1/telemetry` plus status-only fields:

| Field | Source / notes |
|---|---|
| `v` | 1 |
| `id` | MAC hex (12 chars) |
| `fw` | `RUNTIME_VERSION` |
| `uptime_s`, `boot_count`, `reset_reason` | `reset_reason` is the numeric `esp_reset_reason()` |
| `heap_free`, `heap_min` | `esp_get_free_heap_size()`, `esp_get_minimum_free_heap_size()` |
| `memory` | `pressure`, `alloc_failed`, `alloc_failed_size`, `reserve` (24576), `internal` {`total`,`free`,`min`,`largest`,`used`}, `dma` {`free`,`largest`}, `psram` (null when absent), `boot[]` {`stage`,`free`,`largest`} (max 8; stages `boot`, `wifi`, `http`, `mqtt`, `modules`), `tasks[]` {`name`,`stack_min`} (max 24, refreshed at most every 5 s), `tasks_truncated` |
| `cpu` | `{load:[core0 %, core1 %], window_s}`; a load is null until two samples 5 s apart exist |
| `boot_state` | `boot` … `healthy`, `safe_mode` |
| `safe_mode` | bool |
| `network` | `network_status_json()` |
| `mqtt` | `mqtt_status_json()`, see [mqtt.md](mqtt.md) |
| `ota` | `ota_status_json()`, see [ota.md](ota.md) |
| `io` | `state_snapshot()`: object keyed by state key |
| status only: `name`, `topic_id`, `hostname`, `mac`, `chip`, `chip_info`, `ap_ssid`, `schema`, `generation`, `safe_reason` | |
| status only: `sinks` | `ws` (number of open viewers), `mqtt`, `serial`, `rules`, `udp` (bools) |

`GET /api/v1/pins` returns only the `io` object. UART `serial.hello` returns `{v,id,name,topic_id,host,fw,heap}`.

WebSocket `/api/v1/ws`: send any command JSON, get the reply envelope on the same socket (no `topic`). Event frames have `topic` and `data`:

| Topic | Data |
|---|---|
| `io/gpio`, `io/pwm`, `io/servo`, `io/adc`, `io/touch` | pin state (`id` = state key, `gpio`, `mode`, value fields per driver) |
| `io/rfid`, `io/env` | module state (`id` = module id, `type`) |
| `telemetry` | telemetry snapshot, every 15 s |
| `net` | `{state, sta_ip}` |
| `ota/progress` | `{session, bytes, total, percent, error?}` |
| `identity/rename` | `{old_topic_id, topic_id, name}` |
| `mqtt/reconfigure` | the raw `mqtt.configure` request, password included, plus `old_root` |

## Code
- `components/telemetry/src/telemetry.cpp`: `telemetry_snapshot`, `telemetry_task`, `telemetry_start_task`.
- `components/runtime_core/src/memory_budget.cpp`: `memory_status_json`, `cpu_status_json`, `memory_admit`, `memory_boot_mark`.
- `components/runtime_core/src/runtime_status.cpp`: `live_viewers`, `live_mqtt`, `live_serial`, `live_rules`, `live_udp`, `live_sinks`.
- `components/state_registry/src/state_registry.cpp`: `state_set`, `state_clear`, `state_get_clone`, `state_snapshot`.
- `components/event_bus/src/event_bus.cpp`: `event_bus_frame`, `event_bus_print_frame`, `event_bus_publish_framed`.
- `components/web_server/src/web_server.cpp`: `status_json` (`sinks`), `api_status`, `api_telemetry`, `api_pins`, `api_ws`, `ws_add` / `ws_remove`, `ws_broadcast`, `on_bus`.
- `components/command_router/src/command_router.cpp`: `io_emit_snapshot` (`io.hydrate`).
