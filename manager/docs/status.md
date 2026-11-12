# Status and live data (Manager)

Firmware: [docs/features/status.md](../../docs/features/status.md) · Node-RED: [nodered/.../docs/status.md](../../nodered/node-red-contrib-de-esp32/docs/status.md) · Hardware: [hardware/docs/status.md](../../hardware/docs/status.md)

## What the Manager does with it
- Health poller: `GET /api/v1/status` for every registered device, cached in the registry as `last`, turned into the device summary (Fleet, headers) and attention flags.
- Device link: at most one device WebSocket `/api/v1/ws` per device, open only while a browser watches it. Sends `io.hydrate`, caches `io` and the last `telemetry`, and fans out to browsers over the Manager's own WebSocket `/api/ws`.
- Screens: Device · Live (tiles + link chip, Wi-Fi / MQTT / memory chips), Device · System (Memory, Uptime & resets, Identity cards).

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Live | link chip Live / Connecting / Reconnecting / "WS full · polling every 5 s" / Not live | link state (`open`, `connecting`, `full`, `closed`) | `full` = socket open but no event frame in 20 s (device already has 4 viewers) |
| Live | tiles | `io` map (state keys) | from the `live` snapshot, then `io` messages |
| Live | Wi-Fi / MQTT / Memory chips | `telemetry.network.rssi`, `telemetry.mqtt.connected`, `telemetry.memory.pressure` | fall back to the summary |
| System · Memory | Free / Lowest ever / Largest block | `memory.internal.free`, `.min`, `.largest` | banner when largest < 48 KB |
| System · Memory | Reserve / DMA free / PSRAM / Allocation failures | `memory.reserve`, `memory.dma.free` + `.largest`, `memory.psram`, `memory.alloc_failed` + `alloc_failed_size` | |
| System · Memory | boot stages / task table | `memory.boot[]`, `memory.tasks[]` (`stack_min`), `memory.tasks_truncated` | |
| System · Uptime | Uptime / Boot count / Last reset / Boot state / Safe mode | `uptime_s`, `boot_count`, `reset_reason`, `boot_state`, `safe_mode` + `safe_reason` | |
| System · Identity | Device ID / MAC / Hostname / MQTT topic id / Board / Config schema | `id`, `mac`, `hostname`, `topic_id`, `chip`, `schema` + `generation` | |

System data comes from live `telemetry` while the link is `open`, else `GET v1/status` every 15 s (`useSystemData`, `REFRESH_MS`).

## Server side
- Health (`server/src/device/health.ts`): poll every `pollIntervalS` (10-300, default 30) with a per-device phase; timeout 2 s. States `unknown`, `online`, `unreachable` (1 failure), `offline` (2+ failures or > 2 intervals since `lastSeen`), `rebooting` (2 s polls for up to 60 s), `updating`. A reply whose `id` differs from the registered id is `host_mismatch`. While the link is live the timer skips the poll; frames call `liveFrame` (and telemetry refreshes `last`).
- Summary (`server/src/device/summary.ts`): `lastFromStatus` keeps `fw`, `ota.app_version`, `compile_date`/`compile_time`, `boot_state`, `safe_mode`, `safe_reason`, `uptime_s`, `network.rssi`, `network.state`, `memory.pressure`, `memory.internal.free`/`total`, MQTT configured/connected, `ota.running_partition`, `image_state`, `rollback_possible`, `busy`, `io_count` (non-`mod_` keys), `module_count`. Flags: `safe_mode`, `boot_unhealthy` (`boot_state !== "healthy"`), `memory_pressure`, `alloc_failed`, `ota_pending_verify`, `ota_error`, `mqtt_disconnected`, `wifi_recovery` (`network.state === "apsta_recovery"`).
- Link (`server/src/device/link.ts`): on open sends `{"cmd":"io.hydrate","corr":"mgr-hydrate"}`, collects frames until 300 ms quiet (max 1.5 s), then pushes one `live` message `{io, telemetry}`. After that `io/*` frames become `{t:"io"}` and other topics `{t:"event"}`; `mqtt/reconfigure` is never forwarded. Cache key = `data.id`, or `mod_<data.id>` when `data.type` is set. While `connecting` / `full` it polls `GET /pins` every 5 s and sends the changed keys as `io` messages. Commands go over the open socket with a `corr` (10 s timeout), except `system.reboot`, `system.factory_reset`, `ota.rollback`, `network.wifi.set`, `network.wifi.scan` (HTTP). Idle close 10 s after the last watcher; reconnect backoff 1-30 s.
- Proxy: `GET /api/devices/:id/v1/*` passes `status`, `pins`, `telemetry` etc. through; `v1/ws` is refused (`use_ws_link`); POST bodies over 1536 B are refused (the firmware's `read_body` limit).
- Browser WebSocket `/api/ws` (`server/src/ws/browserHub.ts`, `app.ts`): client sends `{t:"watch", ids}`; server messages `link`, `live`, `io`, `event`, `cmdResult` (types in `server/src/types/api.ts` `BrowserWsMessage`).

## Fake device
`server/fake/state.ts` `telemetrySnapshot` / `statusPayload`, `server/fake/fakeDevice.ts` (`emit`, `onWs`, telemetry timer `telemetryIntervalMs` 15000, `wsLimit` 4: later sockets get no events), `server/fake/commands.ts` `handleIoHydrate`. When firmware status changes, update these and `server/src/types/device-api.ts` (`TelemetrySnapshot`, `DeviceStatus`, `MemoryInfo`, `DeviceSinks`, `DeviceWsEvent`). The fake telemetry has no `cpu`; fake `sinks.rules` is a number (rule count) and there is no `sinks.udp`.

## Code
- `server/src/device/{health,link,summary,client}.ts`, `server/src/ws/browserHub.ts`, `server/src/api/proxy.ts`.
- `web/src/api/live.ts`, `web/src/api/watch.ts`, `web/src/api/ws.ts`, `web/src/routes/device/live/*`, `web/src/routes/device/system/{useSystemData.ts,MemoryCard.tsx,UptimeCard.tsx,IdentityCard.tsx}`.

## Gaps
- `sinks` is typed (`DeviceSinks`: `ws`, `mqtt`, `serial`, `rules`; `udp` missing) but not shown anywhere.
- `cpu` (per-core load) is typed but not shown. `heap_free` / `heap_min` are not used (memory comes from `memory.internal`).
- `MemoryInfo.tasks[].cpu` is typed but the firmware does not send it.
- `GET /api/v1/telemetry` is not used (status covers it).
