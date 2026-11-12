# RFID MFRC522 (Manager)

Firmware: [docs/features/rfid.md](../../docs/features/rfid.md) · Node-RED: [nodered/.../docs/rfid.md](../../nodered/node-red-contrib-de-esp32/docs/rfid.md) · Hardware: [hardware/docs/rfid.md](../../hardware/docs/rfid.md)

## What the Manager does with it
Added, edited and removed through the generic Add-ons wizard ([modules.md](modules.md)); shown on the Add-ons card and as an RC522 tile on the Live tab.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Add-on wizard · Pins | SCK / MOSI / MISO / CS / RST selects | `pins.sck/mosi/miso/cs/rst` | roles and order from catalog; RST optional |
| · Pins | Bus | `bus` | `vspi` / `hspi` |
| · Settings | — | — | "This add-on has no settings." |
| Add-ons card | reading | `state.present`, `state.uid` | `Tag <uid>` / `No tag` (`describeReading`) |
| Live tile (`RfidTile`) | chip, UID, "Reader v0x.." | `present`, `uid`, `version` | `version` 0 or 0xFF with no card → "Reader not found" |
| Live tile | wiring line | `bus`, `pins` from `module.list` | `wiringOf()` |

`tx` is typed (`Mfrc522State.tx`) but not shown.

## Server side
Nothing RFID-specific. `Mfrc522State` in `server/src/types/device-api.ts` (`id`, `type:"mfrc522"`, `present`, `uid`, `version`, `tx`); WS topic `io/rfid` in the device frame union. Backups store the instance like any add-on.

## Fake device
`server/fake/commands.ts` `CATALOG` entry `mfrc522` and `installModuleState` (state `{present:false, uid:"", version:146, tx:3}`, emitted on add/configure). The fake never simulates a card. Differences from the firmware:

| Fake | Firmware (`mod_mfrc522.cpp`) |
|---|---|
| chip-select role `ss` | `cs` |
| pin order sck, miso, mosi, ss, rst | sck, mosi, miso, cs, rst |
| settings `poll_ms` (20-2000, def 100), `rx_gain` (0-7, def 4) | no settings |
| label "MFRC522 RFID reader", summary "13.56 MHz RFID reader (SPI)" | "RFID MFRC522", longer summary |
| no `delivery` | catalog `delivery:"reliable"` |

## Code
- `web/src/routes/device/addons/addonLogic.ts` — `describeReading`, `roleLabel` (maps `ss` → CS, only needed for the fake).
- `web/src/routes/device/live/model.ts` — `tileFor` (`mfrc522` branch); `live/Tiles.tsx` — `RfidTile`, `readerMissing`.
- `server/fake/commands.ts`, `server/fake/state.ts`.

## Gaps
- With real firmware the role is `cs`, but `/api/v1/hardware` buses name the pin `ss`, so `defaultPins()` cannot find a bus default and pre-selects the first free non-strap output pin instead of GPIO 5 / 15. Works by accident against the fake (role `ss`).
- The fake's `poll_ms` / `rx_gain` settings do not exist on the device; tests built on them do not reflect the firmware.
- `delivery` (default `reliable`) cannot be changed.
