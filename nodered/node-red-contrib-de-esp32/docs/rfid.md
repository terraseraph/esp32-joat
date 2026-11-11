# RFID MFRC522 (Node-RED)

Firmware: [docs/features/rfid.md](../../../docs/features/rfid.md) · Manager: [manager/docs/rfid.md](../../../manager/docs/rfid.md)

## What Node-RED does with it
The generic `de-esp32-module` node ([modules.md](modules.md)) with `modType` `mfrc522`. Picker shows "RFID MFRC522 · VSPI" and "· HSPI".

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-module` | `modType` | `type` = `mfrc522` | |
| | `bus` | `bus` (`vspi`/`hspi`) | from `/api/v1/hardware` `buses` with `kind:"spi"` |
| | `pins.sck/mosi/miso` | `pins.sck/mosi/miso` | copied from the bus entry's pins |
| | `pins.cs` | `pins.cs` | default = bus `ss` (VSPI 5, HSPI 15); CS row lists free output pins |
| | — | `pins.rst` | not settable; the hint says "tie RST high" |

## Messages
`statusInfo()` detects RFID by a `present` field:

```json
{"topic":"rfid0","payload":{"id":"rfid0","present":true,"uid":"04A1B2C3"},"data":{...firmware state...}}
```

`payload.uid` is the firmware's uppercase hex `uid` (`""` when no card). Status: green `rfid0 · <uid>` or blue `rfid0 · no tag`. One message per firmware event, i.e. per card arrive/leave (firmware only publishes on change).

## Commands sent / events used
`module.add {type:"mfrc522", id, bus, pins}` on deploy (see [modules.md](modules.md)). Listens to `io/rfid` frames on WS `/api/v1/ws` or MQTT `{prefix}/io`, matched by `data.id`.

## Code
- `nodes/de-esp32-module.js` — `statusInfo` (the `present` branch).
- `nodes/de-esp32-module.html` — `wiring`, `applyChoice` (`ss` → `cs`), `csCandidates`.
- `lib/io.js` — `parseModuleEvent` (`present`, `uid`).

## Gaps
- `rst` pin cannot be set from the node.
- `version`/`tx` (reader not answering) are only in `msg.data`; the status does not flag a missing reader.
- `delivery` cannot be set (firmware default `reliable` applies).
