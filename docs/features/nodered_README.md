# nodered_README.md

## Purpose

Host-side Node-RED palette for live de-esp32 boxes. It is an npm package under `nodered/node-red-contrib-de-esp32/`, not an IDF component. The editor talks to Node-RED; the runtime proxies HTTP and optionally MQTT/WebSocket. Mutation is always `command_router` JSON.

## User story

Drop a device config node, scan or paste an IP, rename the box, then wire GPIO in/out nodes that pick pads on the DevKitC header — the same silkscreen `GET /api/v1/hardware` already draws in the embedded UI.

## Public API

Package: `node-red-contrib-de-esp32` (semver independent of firmware; speaks REST `/api/v1`).

Nodes:

- `de-esp32-device` — config: MAC `id`, IP, optional `mqtt-broker`. Scan, `identity.set_name`.
- `de-esp32-gpio-out` — `pin.configure` mode `out`, then `pin.set` on `msg.payload`.
- `de-esp32-gpio-in` — live `{topic,data}` from MQTT `{prefix}/io` if a broker is set, else WebSocket `/api/v1/ws`.

Admin (Node-RED runtime, not the ESP): `GET /de-esp32/scan`, `GET /de-esp32/status`, `GET /de-esp32/hardware`, `POST /de-esp32/command`.

## Depends on

[web_server_README.md](../../components/web_server/web_server_README.md),
[command_router_README.md](../../components/command_router/command_router_README.md),
[mqtt_manager_README.md](../../components/mqtt_manager/mqtt_manager_README.md),
[board_profiles_README.md](../../components/board_profiles/board_profiles_README.md),
[network_manager_README.md](../../components/network_manager/network_manager_README.md),
[device_identity_README.md](../../components/device_identity/device_identity_README.md),
[capability_manager_README.md](../../components/capability_manager/capability_manager_README.md).

## Used by

Node-RED on the same LAN (or with MQTT reachability) as provisioned boards. Humans editing flows.

## How to update and maintain

1. Do not add Node-RED-only commands in firmware. New actions go in `command_router` (`dispatch` **and** `kCmds`).
2. Pin picker must use `hardware.header` + `hardware.pins[]` flags (`flash`, `input_only`, `output`). Do not hardcode GPIO 6–11 / 34–39 in the palette.
3. Stable key is MAC `id`. After `identity.set_name`, refresh `topic_id` / MQTT prefix.
4. Keep package README (install/UX) and this barrel file in the same change when the contract moves.
5. Palette changes do not require an ESP rebuild. Firmware mDNS (`_de-esp32._tcp`) does.

## How to test

```powershell
cd nodered/node-red-contrib-de-esp32
npm install
npm test
npm link
```

Cursor agents follow `.cursor/skills/nodered-push/SKILL.md`. Iterate: `.\tools\nodered_push.cmd` (packs + `POST http://<host>:1880/nodes`), then refresh the Node-RED tab. Point a device node at a live board (`.\tools\discover.cmd`). Scan, rename, toggle an output, watch an input.

## Known limits

Windows mDNS is flaky (same as `tools/discover.py`). No LAN `/24` sweep from the palette. PWM/ADC nodes are later. Max 4 ESP WebSocket clients — one config node shares the socket among gpio-in children. Two boards with the same name share MQTT topics.
