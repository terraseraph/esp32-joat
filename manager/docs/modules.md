# Modules (Manager)

Firmware: [docs/features/modules.md](../../docs/features/modules.md) · Node-RED: [nodered/.../docs/modules.md](../../nodered/node-red-contrib-de-esp32/docs/modules.md)

## What the Manager does with it
- Device → "Pins & add-ons" tab → **Add-ons** section (`AddonsSection.tsx`): one card per instance, enable switch, Edit, Remove, and the **Add add-on** wizard (`AddonWizard.tsx`, steps Type → Pins → Settings → Review; Edit skips Type). Everything is generated from `module.catalog`; no type is hard-coded in the wizard.
- Live tab: one tile per `mod_<id>` state (see [rfid.md](rfid.md), [bme280.md](bme280.md)).
- Backups: add-ons are saved and restored/cloned with `module.add` / `module.configure` / `module.remove`.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Add-on wizard · Type | type card | `type` | disabled when `instanceCount >= max_instances` |
| · Pins | Id | `id` | `ADDON_ID_PATTERN` `^[a-z][a-z0-9_]{0,15}$`; default `id_prefix` + lowest free n; fixed when editing |
| · Pins | Bus | `bus` | `/api/v1/hardware` `buses[]` with `kind` = catalog `bus` |
| · Pins | one select per role | `pins.<role>` | options from `freePinsFor` (cap fits, not flash, owner `""` or `mod_<editingId>` or a sibling's bus pin); `share:"bus"` roles pre-filled from a sibling or `buses[].pins[role]` |
| · Settings | one field per descriptor | `settings.<key>` | `enum` → Select of `choices`, `int` → NumberInput with `min`/`max` |
| Card | Enabled switch | `enabled` | sends `module.configure {id, enabled}` |
| Card | reading | `state` / live `mod_<id>` | `describeReading()` |
| Card | Remove | — | confirm dialog, then `module.remove {id}` |

`validateAddonForm()` mirrors the firmware checks (id, limit, bus, required pins, caps, unique pins, owner, shared bus pins, unique I2C `addr`, setting ranges) before sending.

## Server side
- No module-specific routes. Commands go through `POST /api/devices/:id/command` (or the browser WS `cmd`) unchanged to the device's `/api/v1/command`.
- `server/src/api/deviceCall.ts` `CONFIG_COMMANDS` (`module.add`, `module.configure`, `module.remove`, plus `pin.configure`): after success the live link pushes a fresh `GET /pins` snapshot (`link.configChanged`).
- `server/src/device/link.ts` `stateKey()`: a WS state with `type` is stored as `mod_<id>`.
- Backups: `backups/deviceState.ts` reads `module.list`; stored as `BackupModuleSchema` `{id, type, bus, enabled, pins, settings?}` (extra keys kept), max 8. `backups/planner.ts` removes target add-ons missing from the backup or of another type, then sends `module.add` (new id) or `module.configure` (same id and type, when `sameModule()` differs) with `{id, bus, enabled, pins, settings}`.
- Types: `server/src/types/device-api.ts` — `ModuleCatalog`, `ModuleCatalogType`, `ModuleCatalogPin`, `ModuleCatalogSetting`, `ModuleInstance`, `ModuleList`, `Module*Command`, `ModuleType = "bme280" | "mfrc522"`.

## Fake device
`server/fake/commands.ts`: own `CATALOG`, `normalizeSettings`, `validateModule`, `installModuleState`, `handleModuleCatalog/List/Add/Configure/Remove/Cmd`. `server/fake/state.ts`: `moduleInstances`, `ownerOf`, `ioTopic`, `BUSES`, demo seed (`DEMO_SEED.modules`: one BME280 `env0`). `MODULE_MEMORY` (bme280 6144, mfrc522 12288) is invented to exercise the "need N bytes" error.

Where it differs from the firmware (update these when the firmware changes):

| Fake | Firmware |
|---|---|
| catalog `def` and choice `value` are numbers | strings (`"118"`, `"1000"`) |
| no `delivery` in catalog types or listed instances; `delivery` validated on add then dropped | `delivery` in both |
| shared bus pins owned by `mod_<id>` (`ownerOf`) | `bus_vspi` / `bus_hspi` / `bus_i2c0`; only CS/RST are `mod_<id>` |
| `module.configure` keeps `enabled` when omitted | omitted `enabled` = `true` |
| int settings out of range are clamped | refused (`settings.<key> out of range`) |
| invalid id on add: `invalid module id (a-z, 0-9, _, max 16 chars)` | `id must be [a-z][a-z0-9_]{0,15}` |
| memory check on every enable using `MODULE_MEMORY` | both types declare 0 bytes |

## Code
- `web/src/routes/device/addons/AddonsSection.tsx`, `AddonWizard.tsx`, `addonLogic.ts` (`defaultForm`, `defaultPins`, `freePinsFor`, `validateAddonForm`, `buildModuleAdd`, `buildModuleConfigure`, `describeReading`).
- `web/src/routes/device/addons/addonFixtures.ts` — catalog fixtures; not imported anywhere at the moment.
- `web/src/routes/device/live/model.ts` (`tileFor`, `ADDON_NAME`), `live/Tiles.tsx`, `live/LiveTab.tsx`.
- `web/src/routes/backups/labels.ts` — add-on step labels.
- `server/src/api/deviceCall.ts`, `server/src/device/link.ts`, `server/src/backups/deviceState.ts`, `server/src/backups/planner.ts`, `server/src/types/api-backups.ts`, `server/src/types/device-api.ts`.

## Gaps
- Settings types: with real firmware, `def` and choice values are strings. `validateSetting()` requires `typeof v === "number"` for `int`, so a new BME280's `sample_ms` default `"1000"` fails ("Enter a whole number") until retyped. On Edit, saved numeric enum values (`addr: 118`) do not `===` the string choices (`"118"`), so they fail "Choose one of the listed values", and the I2C address clash check compares number to string.
- Editing the only instance on a bus: its bus pins are owned by `bus_<bus>`, not `mod_<id>`, so `validateAddonForm()` reports "GPIO 18 is in use (bus_vspi)" (same for `bus_i2c0`). Hidden by the fake's `ownerOf`.
- Edit of a disabled add-on: `buildModuleConfigure()` does not send `enabled`, and the firmware treats a missing `enabled` as `true`, so saving re-enables it.
- `delivery` is not shown or set anywhere; `ModuleCatalogType` and `ModuleInstance` lack the field; `ModuleConfigureFields` lacks `delivery` and `type`. Backup restore does not pass `delivery`, so restored add-ons get the type default.
- `i2c1` cannot be chosen: buses come from `/api/v1/hardware`, which lists only `i2c0`.
- `module.cmd` is never sent (no type has commands).
