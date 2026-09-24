# module_manager_README.md

## Purpose

Compile-in catalog of optional hardware addons. Types register a pin schema and apply/teardown vtable. Instances are enabled at runtime, persisted in NVS `components.modules`, and never start unless configured.

## User story

Safe pins / GPIO: add an MFRC522 from the Hardware tab. Firmware rejects flash pins, input-only CS, a fifth reader, or a second reader whose SCK/MISO/MOSI do not match the first. Add a BME280 on i2c0; a second chip must share SDA/SCL and use the other address.

## Public API

- `module_manager_init()`, `module_register_type()`
- `module_catalog_json()`, `module_list_json()` (caller deletes)
- `module_add` / `module_configure` / `module_remove` / `module_cmd`
- `module_apply_saved()` (boot; command_router skips this in safe mode)
- `module_id_valid()` — `[a-z][a-z0-9_]{0,15}`
- Optional `ModuleTypeOps.memory_bytes(spec)`. Null means no declared cost. `module.add` and `module.configure` call `memory_admit` before apply (configure checks before teardown). A critical heap, a block that will not fit, or a request that would leave under 24 KB free is `ESP_ERR_NO_MEM` and is not written to NVS. `module_apply_saved` skips a refused instance, leaves it in NVS, and still returns `ESP_OK`.

NVS blob `components` / `modules` (~2 KB JSON): `{v:1, modules:[{id,type,bus,enabled,pins,settings?}]}`. Missing blob is empty. `settings` holds chip knobs (BME280 addr / oversampling). RFID instances omit it. Schema 4.

Commands: `module.catalog`, `module.list`, `module.add`, `module.configure`, `module.remove`, `module.cmd`.

## Depends on

[config_manager_README.md](../config_manager/config_manager_README.md),
[capability_manager_README.md](../capability_manager/capability_manager_README.md),
[state_registry_README.md](../state_registry/state_registry_README.md),
[runtime_core_README.md](../runtime_core/runtime_core_README.md) (`memory_admit`).

GPIO, SPI, and I2C claims happen in the type driver, not here. This component validates `bus_kind` (`spi` / `i2c`), shared bus pins, unique CS / unique I2C addr, and copies declared `settings`.

## Used by

[command_router_README.md](../command_router/command_router_README.md),
[mod_mfrc522_README.md](../mod_mfrc522/mod_mfrc522_README.md) (registers `mfrc522`),
[mod_bme280_README.md](../mod_bme280/mod_bme280_README.md) (registers `bme280`),
boot (`command_apply_saved_modules`).

## How to update and maintain

1. New type: new `components/mod_*` that calls `module_register_type` from its init. Do not `REQUIRES` the driver from this component.
2. Pin schema and settings descriptors live on the vtable so the UI does not hardcode roles or chip knobs.
3. Bump `RUNTIME_CONFIG_SCHEMA` if the blob shape changes.
4. Do not pass a `json_str` pointer back into the same object after `cJSON_DeleteItem*` — copy to a stack buffer first (SPI `bus` used to become garbage and fail as `unknown spi bus`).

## How to test

`python test/test_module_spec.py`. Hardware: `module.add` an RC522 on VSPI, reboot, `module.list` still shows it; factory reset clears it. Same for a BME280 on i2c0 with `settings.addr`.

## Known limits

Catalog is linked into the binary (no dlopen). Max 16 registered types. Blob cap 2048 bytes. UART bus kinds are not implemented yet. Named next types (WS281x, more I2C chips): [potential_modules_README.md](../../docs/features/potential_modules_README.md).
