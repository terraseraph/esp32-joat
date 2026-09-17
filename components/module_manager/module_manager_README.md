# module_manager_README.md

## Purpose

Compile-in catalog of optional hardware addons. Types register a pin schema and apply/teardown vtable. Instances are enabled at runtime, persisted in NVS `components.modules`, and never start unless configured.

## User story

Safe pins / GPIO: add an MFRC522 from the Hardware tab. Firmware rejects flash pins, input-only CS, a fifth reader, or a second reader whose SCK/MISO/MOSI do not match the first.

## Public API

- `module_manager_init()`, `module_register_type()`
- `module_catalog_json()`, `module_list_json()` (caller deletes)
- `module_add` / `module_configure` / `module_remove` / `module_cmd`
- `module_apply_saved()` (boot; command_router skips this in safe mode)
- `module_id_valid()` — `[a-z][a-z0-9_]{0,15}`

NVS blob `components` / `modules` (~2 KB JSON): `{v:1, modules:[{id,type,bus,enabled,pins}]}`. Missing blob is empty. Schema 2.

Commands: `module.catalog`, `module.list`, `module.add`, `module.configure`, `module.remove`, `module.cmd`.

## Depends on

[config_manager_README.md](../config_manager/config_manager_README.md),
[capability_manager_README.md](../capability_manager/capability_manager_README.md),
[state_registry_README.md](../state_registry/state_registry_README.md),
[runtime_core_README.md](../runtime_core/runtime_core_README.md).

GPIO and SPI claims happen in the type driver, not here.

## Used by

[command_router_README.md](../command_router/command_router_README.md),
[mod_mfrc522_README.md](../mod_mfrc522/mod_mfrc522_README.md) (registers `mfrc522`),
boot (`command_apply_saved_modules`).

## How to update and maintain

1. New type: new `components/mod_*` that calls `module_register_type` from its init. Do not `REQUIRES` the driver from this component.
2. Pin schema lives on the vtable so the UI does not hardcode roles.
3. Bump `RUNTIME_CONFIG_SCHEMA` if the blob shape changes.

## How to test

`python test/test_module_spec.py`. Hardware: `module.add` an RC522 on VSPI, reboot, `module.list` still shows it; factory reset clears it.

## Known limits

Catalog is linked into the binary (no dlopen). Max 8 registered types. Blob cap 2048 bytes. I2C/UART bus kinds are not implemented yet.
