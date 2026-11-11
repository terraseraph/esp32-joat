# Modules (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/modules.md) · [Manager](../../manager/docs/modules.md)

Per-type docs: [rfid.md](rfid.md) (MFRC522), [bme280.md](bme280.md).

## What it does
A catalog of optional hardware add-ons compiled into the firmware. Each type registers a pin schema, settings and apply/teardown functions. Instances are created at runtime with `module.add`, saved in NVS and re-applied at boot. Nothing starts unless an instance is configured.

## How it works on the ESP
- Types register from their component's init with `module_register_type(&kOps)` (`main/app_main.cpp`: `module_manager_init`, `mod_mfrc522_init`, `mod_bme280_init`). Max 16 types (`kMaxTypes`). No dynamic loading.
- Registered types today: `mfrc522` (SPI, max 4), `bme280` (I2C, max 2).
- Validation (`validate_spec`, `module_manager.cpp`) runs before anything is applied:
  - id must match `[a-z][a-z0-9_]{0,15}` (`module_id_valid`). An empty id on `module.add` is filled with `<id_prefix><n>`, lowest free n (`suggest_id`).
  - `bus`: `vspi`/`hspi` for `spi` types, `i2c0`/`i2c1` for `i2c` types. Missing = the type's `default_bus`.
  - every pin goes through `capability_allows(gpio, role.cap)` (flash pins 6-11 refused, input-only 34-39 refused for `out` roles). Pins in one instance must be unique.
  - instances on the same bus must use the same GPIOs for roles with `share:"bus"`; SPI `cs` must differ; I2C `settings.addr` must differ.
  - per-type instance limit (`max_instances`).
  - settings checked against the type's descriptors (`apply_settings`): `enum` must match a choice, `int` must be in `min..max`. Missing keys get the default. Stored as numbers when the value looks like an integer, else strings.
- Memory: `admit_one` calls `memory_admit(ops->memory_bytes(spec), 0)` before apply (configure checks before teardown). Both current types leave `memory_bytes` null (0 bytes), so they are only refused when heap pressure is critical or free heap would drop under the reserve. Refusal = `ESP_ERR_NO_MEM`, nothing written to NVS.
- Bus and GPIO claims happen in the type driver through `resource_manager` (`resource_spi_claim`, `resource_i2c_claim`, `resource_claim`). Shared bus pins are owned by `bus_<busid>` (for example `bus_vspi`, `bus_i2c0`); per-instance pins (CS, RST) by `mod_<id>`. These owner strings show in `GET /api/v1/hardware`.
- `delivery` (`reliable` / `latest`) picks the MQTT backpressure class of the instance's events (`io_delivery_set_module`). Default per type: `mfrc522` reliable, `bme280` latest.
- Boot: `command_apply_saved_modules(true)` → `module_apply_saved()`; skipped in safe mode. An instance refused by memory or failing apply is logged and left in NVS; boot continues.

## Settings
Instance spec (saved per instance):

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `id` | `[a-z][a-z0-9_]{0,15}` | `<id_prefix><n>` | `rfid0`, `env0` ... |
| `type` | registered type | required on add | |
| `bus` | `vspi`,`hspi` / `i2c0`,`i2c1` | type `default_bus` | |
| `enabled` | bool | `true` | false = saved but torn down. Not inherited on `module.configure` (see Commands) |
| `delivery` | `reliable` / `latest` | type default | always written back in the saved copy |
| `pins` | `{role: gpio}` | none | roles from the type; unknown roles are dropped |
| `settings` | `{key: value}` | descriptor defaults | only types with settings (BME280) |

Saved in NVS namespace `components`, key `modules`, as JSON `{"v":1,"modules":[{id,type,bus,enabled,delivery,pins,settings?}]}`. Blob cap 2048 bytes (`kBlob`); a bigger blob fails with "failed to persist modules" / `ESP_ERR_NO_MEM`. Missing blob = no modules. Applied immediately on add/configure and at boot. Factory reset clears it.

## Commands
All go through `components/command_router` (HTTP `/api/v1/command`, WS, MQTT, UART). Responses use the normal envelope `{"v":1,"ok":true,"result":...}` / `{"v":1,"ok":false,"error":"..."}`.

```json
{"cmd":"module.catalog"}
```
Result `{"types":[{"type","label","summary","bus","default_bus","id_prefix","max_instances","delivery","pins":[{"role","required","share","cap"}],"settings":[{"key","label","kind","def","min?","max?","choices?":[{"value","label"}]}]}]}`. `def` and choice `value` are always **strings** (`"118"`, `"1000"`); `min`/`max` only for `kind:"int"`.

```json
{"cmd":"module.list"}
```
Result `{"v":1,"modules":[{...saved spec..., "state":{...}}]}`. `state` is the live `mod_<id>` value when one exists.

```json
{"cmd":"module.add","type":"bme280","id":"env0","bus":"i2c0","pins":{"sda":21,"scl":22},"settings":{"addr":118}}
```
Fields can also be nested: `{"cmd":"module.add","module":{...}}`. Result = `module.list` result.

```json
{"cmd":"module.configure","id":"rfid0","pins":{"sck":18,"miso":19,"mosi":23,"cs":15}}
```
Missing `type`, `bus`, `delivery`, `pins`, `settings` are copied from the saved instance. `enabled` is **not** copied: omitted means `true`. Old instance is torn down, new one applied; on failure the old one is re-applied. Result = list.

```json
{"cmd":"module.remove","id":"rfid0"}
```
Teardown, clear `mod_<id>` state, delete from NVS. Result = list.

```json
{"cmd":"module.cmd","id":"rfid0"}
```
Whole request is passed to the type's `cmd` hook. Neither current type has one: error `module has no commands`.

Errors (exact strings): `id must be [a-z][a-z0-9_]{0,15}`, `unknown module type`, `id already in use`, `unknown module id`, `<type> limited to <n> instances`, `bus must be vspi or hspi`, `bus must be i2c0 or i2c1`, `delivery must be reliable or latest`, `pins object required`, `pin <role> required`, `module pins must be unique`, `shared <spi|i2c> bus pins must match`, `cs must be unique per reader`, `i2c address must be unique on this bus`, `settings.<key> invalid`, `settings.<key> must be a number`, `settings.<key> out of range`, `failed to persist modules`, `id required` (remove/cmd with an invalid id), `need N bytes, largest L, free F` (memory), capability errors (`gpio reserved for SPI flash`, `gpio is input-only`, ...), resource errors (`spi <bus> pins must match sck=.. miso=.. mosi=..`, owned-by errors), and driver errors from apply.

## Events and state
- State key `mod_<id>` in the state registry: in `GET /api/v1/pins`, in `module.list` (`state`), re-emitted by `io.hydrate` (`io_emit_snapshot` maps `mfrc522` → `io/rfid`, `bme280` → `io/env`).
- Event bus topic per type (`io/rfid`, `io/env`). Frames are `{"topic":"io/rfid","data":{...}}` on WS `/api/v1/ws`, MQTT `{root}/{topic_id}/io` (QoS 1, QoS 0 for `latest` under backlog), UART session and UDP sink.
- Payload fields: see [rfid.md](rfid.md) and [bme280.md](bme280.md).

## Adding a new module
Firmware:
1. New `components/mod_<name>/` with a `ModuleTypeOps` (`type`, `label`, `summary`, `bus_kind`, `default_bus`, `id_prefix`, `max_instances`, `pins`, `apply`, `teardown`, optional `cmd`, `settings`, `memory_bytes`, `reliable_default`). Call `module_register_type` from `mod_<name>_init()`. Do not `REQUIRES` the driver from `module_manager`.
2. Claim buses/pins only through `resource_manager` (`resource_spi_claim` / `resource_i2c_claim` + `resource_i2c_add_device`, `resource_claim(gpio, "mod_<id>")`). Release all of it in `teardown`.
3. Publish state with `state_set("mod_<id>", ...)` and `event_bus_publish("io/<topic>", ...)`; include `id` and `type`.
4. Add the type → topic mapping in `io_emit_snapshot` (`command_router.cpp`).
5. Call init in `main/app_main.cpp` after `module_manager_init`, add the component to `main/CMakeLists.txt`.
6. Update `test/test_module_spec.py` (`TYPES`). Bump `RUNTIME_CONFIG_SCHEMA` (`runtime_version.hpp`) only if the blob shape changes.
7. Write `docs/features/<name>.md` and its two sister docs.

Node-RED (`nodered/node-red-contrib-de-esp32/`):
8. `nodes/de-esp32-module.js` `statusInfo()`: add a status text / payload shape for the new state (otherwise it shows "ready"/"error").
9. `nodes/de-esp32-module.html`: the picker is catalog-driven, but `wiring()`, `busBusy()` and the CS row assume SPI pin names; check they make sense for the new bus. Settings are not sent by the node.

Manager (`manager/`):
10. `server/src/types/device-api.ts`: `ModuleType`, a `<Name>State` interface, add it to `IoState`, `ModuleInstance.state` and the WS topic union.
11. `server/fake/commands.ts` `CATALOG` (copy pins/settings exactly as the firmware's `module.catalog` prints them, strings included), `installModuleState`, and `server/fake/state.ts` `ioTopic`.
12. `web/src/routes/device/addons/addonLogic.ts` `describeReading`; `web/src/routes/device/live/model.ts` `tileFor` + `ADDON_NAME`, and a tile in `live/Tiles.tsx`. The wizard (`AddonWizard.tsx`) is catalog-driven.

## Code
- `components/module_manager/include/module_manager.hpp` — `ModuleTypeOps`, `ModulePinRole`, `ModuleSettingDesc`.
- `components/module_manager/src/module_manager.cpp` — `validate_spec`, `apply_settings`, `suggest_id`, `normalize_copy`, `module_catalog_json`, `module_list_json`, `module_add`, `module_configure`, `module_remove`, `module_cmd`, `module_apply_saved`.
- `components/resource_manager/` — GPIO owners, SPI/I2C host refcounts (internal notes in `resource_manager_README.md`).
- `components/command_router/src/command_router.cpp` — `module.*` dispatch, `command_apply_saved_modules`, `io_emit_snapshot`.
- `components/board_profiles/src/board_profiles.cpp` — `buses` list in `/api/v1/hardware` (`vspi`, `hspi`, `i2c0`; no `i2c1` entry).
- `test/test_module_spec.py` — host-side mirror of the validation rules.
