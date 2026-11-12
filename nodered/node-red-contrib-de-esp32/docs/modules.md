# Modules (Node-RED)

Firmware: [docs/features/modules.md](../../../docs/features/modules.md) · Manager: [manager/docs/modules.md](../../../manager/docs/modules.md) · Hardware: [hardware/docs/modules.md](../../../hardware/docs/modules.md)

## What Node-RED does with it
One node, `de-esp32-module` (palette label "module"), outputs live events for one module instance. It can install the instance on deploy (`module.add`) or only listen to one already on the device. Per-type output: [rfid.md](rfid.md), [bme280.md](bme280.md).

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-module` | `device` | — | `de-esp32-device` config node (host, port, MQTT broker/prefix) |
| | `mode` | — | `add` (default) or `installed` (listen only, never sends `module.add`) |
| | `modId` | `id` | max 16 chars in the editor; default `<id_prefix>0` from the catalog |
| | `modType` | `type` | hidden; set by the picker from `module.catalog` `types[].type` |
| | `bus` | `bus` | hidden; one picker button per `hardware.buses[]` entry whose `kind` = catalog `bus` |
| | `pins` | `pins` | hidden JSON string `{role: gpio}`. `share:"bus"` roles come from `hardware.buses[].pins[role]`; `cs` defaults to the bus `ss` pin, changeable on the CS row |
| | `install` | — | "Install module on deploy" checkbox, default true; forced false in `installed` mode |
| | `name` | — | label only |

Not exposed: `settings`, `enabled`, `delivery`.

## Messages
No input. One output per state change of the instance:

```json
{"topic":"rfid0","payload":{"id":"rfid0","present":true,"uid":"04A1B2C3"},"data":{"id":"rfid0","type":"mfrc522","present":true,"uid":"04A1B2C3","version":146,"tx":131}}
```

`msg.topic` = `modId`; `msg.data` = raw firmware state; `msg.payload` shape depends on type (`statusInfo()` in the node). Unknown types: `payload` = `{id, ...state}`, status "ready" or "error" (from `state.ok`).

## Commands sent / events used
| When | Command / source |
|---|---|
| Editor open | `GET /api/v1/hardware` via `/de-esp32/hardware`; `module.catalog` and `module.list` via `/de-esp32/command` |
| Deploy, `add` + `install` | `module.list`; if `modId` is missing → `module.add {type,id,bus,pins}`; if present with same `type`, `bus`, `pins` → reuse; if different → warn "pins differ — left installed", nothing sent |
| Deploy, listen-only | `module.list` to show the current `state` |
| Live | device node subscribes WS `ws://host:port/api/v1/ws`, or MQTT `{prefix}/io` (QoS 1) when a broker is set, then sends `io.hydrate`. `lib/io.js` `parseModuleEvent` accepts any `io/*` frame whose `data` has `id` and no `gpio`; matched by `id` |

Never sends `module.configure`, `module.remove` or `module.cmd`.

## Code
- `nodes/de-esp32-module.js` — `ModuleNode`, `statusInfo`, `samePins`.
- `nodes/de-esp32-module.html` — editor picker (`paintAdd`, `applyChoice`, `wiring`, `busBusy`, `csCandidates`, `paintInstalled`).
- `nodes/de-esp32-device.js` — `subscribeModule`, `_dispatchIo`, `/de-esp32/command` and `/de-esp32/hardware` admin routes.
- `lib/io.js` — `parseModuleEvent`.

## Gaps
- No `settings`: BME280 is always added with firmware defaults (addr 0x76), so a second BME280 on the same bus fails with `i2c address must be unique on this bus`.
- No `delivery`, `enabled`, remove or reconfigure. Changing pins in the node leaves the old instance in place.
- `i2c1` (and any bus not in `/api/v1/hardware` `buses`) cannot be picked; the board profile lists only `vspi`, `hspi`, `i2c0`.
- Editor assumes SPI names: `busBusy()` checks only `sck`/`mosi`/`miso`, `wiring()` always adds "tie RST high", and the CS row is shown for I2C types too (see [bme280.md](bme280.md)).
- `/de-esp32/command` deletes `id` from the body before sending, so it cannot carry `module.remove`/`module.cmd`; the editor does not need them today.
