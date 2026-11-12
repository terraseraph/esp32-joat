# UDP (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/udp.md) · [Manager](../../manager/docs/udp.md) · [Hardware](../../hardware/docs/udp.md)

## What it does
Sends every live io event as one UDP datagram to up to two IPv4 targets, with no broker or WebSocket needed. Optionally it also sends a periodic announce datagram so listeners can find the device without mDNS. Output only: nothing is received, acknowledged or retried.

## How it works on the ESP
- One UDP socket (lwIP), open while the io stream or the announce is on. `SO_BROADCAST` is set, multicast TTL is 1 (local network only). Targets may be unicast, broadcast or multicast.
- io stream: subscribes to `io/` on the event bus. For each event it takes the shared frame `{"topic":..,"data":..}` and sends `{"id":"<device id>","seq":<n>,` + the frame without its `{` (scatter/gather, no copy).
- `seq` goes up by 1 per event (not per target) so a receiver can spot gaps. It is not saved; it restarts at 0 on boot.
- Max datagram 1400 bytes (no IP fragmentation). Larger events are dropped and counted in `oversize`.
- Sends use `MSG_DONTWAIT`: a datagram that cannot go now is dropped and counted in `failed`.
- While the stream is active it counts as a live sink (`RuntimeStatus::live_udp`), so ADC sampling and touch raw updates keep running.
- Announce: an `esp_timer` sends one datagram every `announce_s` seconds to `announce_addr`. It does not count as a live sink and runs without io targets.
- Boot: `udp_init` (bus subscribe, timer) before the network; `udp_start` after `mqtt_start` loads NVS and opens the socket.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `targets` | array of 0-2 `"ipv4:port"` strings, port 1-65535 | `[]` | Omitted = keep saved. `[]` = stream off. Hostnames are not accepted. |
| `enabled` | bool | on when there is at least one target | Omitted = on if targets exist (it does not keep a saved `false`). Always off with no targets. |
| `announce` | bool | false | |
| `announce_addr` | `"ipv4:port"` | `239.255.77.1:7701` | |
| `announce_s` | int 2-60 | 5 | Out of range is an error. |

NVS namespace `udp`:

| Key | Type | Field |
|---|---|---|
| `t0`, `t1` | str | `targets[0]`, `targets[1]` (`""` = unused) |
| `enabled` | u8 | `enabled` |
| `ann` | u8 | `announce` |
| `ann_addr` | str | `announce_addr` |
| `ann_s` | u8 | `announce_s` |

Applied immediately, then saved; read at boot by `udp_start`. Only fields present in the request are saved (`enabled` always). Erased by `system.factory_reset`.

## Commands
```json
{"cmd":"udp.configure","targets":["192.168.1.10:9000"]}
```
```json
{"cmd":"udp.configure","announce":true,"announce_addr":"239.255.77.1:7701","announce_s":5}
```
Same body without `cmd` on `POST /api/v1/udp`. Reply (also `GET /api/v1/udp` without the envelope):
```json
{"v":1,"ok":true,"result":{"enabled":true,"active":true,"targets":["192.168.1.10:9000"],"sent":0,"failed":0,"oversize":0,"seq":0,"announce":true,"announce_addr":"239.255.77.1:7701","announce_s":5,"announced":0}}
```
| Result field | Meaning |
|---|---|
| `enabled` | saved setting |
| `active` | socket open and stream sending |
| `sent` / `failed` | datagrams per target sent / refused by the stack |
| `oversize` | events over 1400 bytes, dropped |
| `seq` | last sequence number used |
| `announced` | announce datagrams sent |

Errors: `targets must be an array of up to 2 "ipv4:port"`, `target must be "ipv4:port", e.g. 192.168.1.10:9000`, `announce must be true or false`, `announce_addr must be "ipv4:port", e.g. 239.255.77.1:7701`, `announce_s must be 2-60`, `applied but not saved: <esp_err>`. Validation happens before anything changes.

## Events and state
io datagram (same `topic`/`data` as WS, MQTT and serial):
```json
{"id":"a0b1c2d3e4f5","seq":42,"topic":"io/gpio","data":{"id":"gpio_4","mode":"in","gpio":4,"level":1}}
```
Announce datagram:
```json
{"announce":"de-esp32","id":"a0b1c2d3e4f5","name":"..","host":"esp32-xxxxxx","ip":"192.168.1.50","fw":"..","http":80}
```
`ip` is the STA IP, or the AP IP when STA has none. `http` is always 80.

- `GET /api/v1/status` `sinks.udp`: bool, stream active.
- `GET /api/v1/udp`: status object above.
- No WS or MQTT event of its own.

## Code
- `components/udp_sink/src/udp_sink.cpp`: `udp_init`, `udp_start`, `udp_configure`, `udp_status_json`, `on_io`, `announce_cb`, `parse_target`, `reopen_locked`.
- `components/command_router/src/command_router.cpp`: `udp.configure`. `components/web_server/src/web_server.cpp`: `api_udp`, `sinks.udp`.
- `components/runtime_core/src/runtime_status.cpp`: `set_live_udp`, `live_sinks`.
