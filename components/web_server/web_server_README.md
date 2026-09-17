# web_server_README.md

## Purpose

ESP-IDF httpd: static UI embedded in the binary, REST `/api/v1`, WebSocket `/api/v1/ws`. No business logic that is not in command_router, except `POST /api/v1/ota` which streams a firmware binary into `ota_manager`. Route list lives in one `kRoutes` table: HTTP registration and `GET /api/v1/openapi.json` both walk it.

## User story

Find the device, configure pins from the Hardware pinout, provision, view logs, reboot, OTA — all from a tiny vanilla page. The API tab only renders the OpenAPI document; it does not duplicate paths.

## Public API

- `GET /` `/index.html` — UI
- Unmatched GET (captive probes) — 302 to `http://192.168.4.1/` with a body (iOS needs the body)
- `GET /api/v1/openapi.json` — OpenAPI 3.0 generated from `kRoutes` + `command_catalog()` + `mqtt_topics_json()`. CORS `*`. Vendor extensions: `x-commands`, `x-mqtt`, `x-discovery` (`mdns`, `service=_http._tcp`, `de_service=_de-esp32._tcp`, `board`, `port`)
- `GET /api/v1/status|hardware|pins|network|network/scan|mqtt|logs|telemetry|ota`
  - `hardware` — board profile, header pinout, buses, `chip` / `chip_info`, SoC `pins` capabilities plus live `owner` per GPIO
- `POST /api/v1/command|pins|network/wifi|mqtt|ota|system/reboot|system/factory_reset`
- `GET /api/v1/ws` — WebSocket; JSON commands in, event bus frames out. No frames when `live_viewers()==0`. ADC live-sample runs while `live_sinks()>0` (WS, MQTT, serial session, or an ADC-watching on-device rule). Browser closes the socket on hidden tabs.

Assets: `web/dist/index.html` via CMake `EMBED_FILES`.

## Depends on

command_router, identity, network, mqtt, logging, telemetry, ota, capability, board, config, event_bus, security (AP SSID display only), resource_manager (GPIO owners on `/hardware`).

## Used by

Humans (browser). Boot starts the server. Node-RED palette (`docs/features/nodered_README.md`) is an HTTP/WS/MQTT client of this API — it does not live in the binary.

## How to update and maintain

1. New HTTP path: add a row to `kRoutes` in `web_server.cpp` (handler + one-line summary). Do not list the path in the HTML.
2. New JSON command: add it in `command_router` (`dispatch` **and** `kCmds`). OpenAPI picks it up.
3. Edit `web/source/index.html`, run `python tools/sync_web.py`, rebuild firmware. Keep the file small — no npm/React/Swagger UI.
4. Status polling must not rebuild forms (phones lose focus/text). Gzip later if the binary grows; partitions are 1792 KB per OTA slot.

## How to test

Flash, join AP, open 192.168.4.1, exercise each tab. `GET /api/v1/openapi.json` must list every registered `/api/v1` path. Confirm `POST /api/v1/command` matches MQTT.

## Known limits

Unauthenticated on LAN. Max 4 WS clients. `httpd_ws_send_frame_async` sends immediately in this IDF. Captive portal needs extra HTTP sockets (`max_open_sockets` 13, `CONFIG_LWIP_MAX_SOCKETS` 20). OpenAPI is compact (no full JSON Schema per path) so it fits RAM. Live ADC is hysteresis-gated, not a raw 4 Hz MQTT flood.
