# runtime_core_README.md

## Purpose

Shared types: firmware version (`RUNTIME_VERSION`, `RUNTIME_IDF_PINNED`), `RuntimeStatus` (boot state, safe mode, boot count, uptime, live sinks), and cJSON helpers.

## User story

Overview page and serial banner show firmware, boot state, and safe mode. Every module reports through this status object.

## Public API

- `runtime_version.hpp` — compile-time constants; bump `RUNTIME_CONFIG_SCHEMA` when NVS layout changes
- `runtime_status.hpp` — `RuntimeStatus::instance()` including `live_viewers()` (open UI WebSockets), `live_mqtt()`, `live_serial()`, `live_rules()`, and `live_sinks()` (ADC live-sample when any of those is active)
- `json_util.hpp` — `json_str` / `json_int` / `json_bool`
- `memory_budget.hpp` — `memory_boot_mark`, `memory_admit`, `memory_status_json`, `memory_hooks_init`. Heap pools, pressure, boot marks, and cached task stacks. Lives here so module admission does not depend on telemetry.

No NVS, REST, or MQTT of its own.

## Depends on

ESP-IDF `json`, `esp_timer`, `heap`, FreeRTOS.

## Used by

[boot_state_machine_README.md](../../docs/features/boot_state_machine_README.md), config, telemetry, web, command_router.

## How to update and maintain

Add boot states in both the enum and `boot_state_name()`. Keep this component free of Wi-Fi/GPIO so it stays leaf-level. Schema bumps belong here (`RUNTIME_CONFIG_SCHEMA`) and in config_manager init.

## How to test

Serial log after boot lists version and state transitions. Unit-test JSON helpers later on the IDF linux target if needed.

## Known limits

`safe_mode_reason()` returns an unsynchronized C string; treat as diagnostic only.
