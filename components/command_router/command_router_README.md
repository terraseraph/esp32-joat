# command_router_README.md

## Purpose

One JSON command surface so REST, WebSocket, MQTT, and UART JSON lines cannot diverge. Validates pins, persists I/O JSON, test-then-commit Wi-Fi.

## User story

Live control and provision Wi-Fi: the same `cmd` works from the UI and `{root}/{topic_id}/system/command`.

## Public API

`command_dispatch(cJSON*)` → response object (caller deletes). `command_apply_saved_io(skip_if_safe_mode)`. `command_apply_saved_modules(skip_if_safe_mode)`. `command_apply_saved_rules(skip_if_safe_mode)`. `io_emit_snapshot()` republishes each pin and `mod_*` key on the event bus. `command_catalog()` → array of `{cmd, summary, example}` (OpenAPI `x-commands`; keep `kCmds` in sync with `command_dispatch`).

Commands: `pin.configure` (optional `debounce_ms` on `in`; `sample_ms`, `hysteresis_mv`, `smooth` on `adc`; `angle`, `min_us`, `max_us` on `servo`), `pin.set`, `io.hydrate`, `serial.hello`, `serial.bye`, `module.catalog|list|add|configure|remove|cmd`, `rule.set|remove|list`, `network.wifi.set|scan|clear`, `network.recovery_ap`, `network.ap.set_password`, `mqtt.configure`, `identity.set_name`, `system.reboot`, `system.factory_reset`, `ota.apply`, `ota.rollback`.

Payload `v` / `corr` echoed. REST `POST /api/v1/command`.

## Depends on

config, capability, io_*, io_rules, module_manager, network, provisioning, event_bus, identity, runtime_core, ota_manager, state_registry.

**Does not** depend on mqtt_manager, web_server, or serial_session (those call in).

## Used by

web_server, mqtt_manager, serial_session, boot (apply saved I/O, modules, and rules).

## How to update and maintain

New user actions = new `cmd` string in `command_dispatch` **and** a row in `kCmds` (OpenAPI). Then thin HTTP wrappers. Persist pin objects under `io.pins`. Persist modules under `components.modules`. Persist rules under `io.rules`. Wi-Fi set must call `network_try_sta` before `network_commit_wifi`.

## How to test

POST `{"cmd":"pin.configure","pin":{"gpio":6,"mode":"out"}}` → error. `module.add` with flash SCK → error. `module.add` BME280 with SDA 34 → error. Provision with wrong PSK → credentials not saved.

## Known limits

Last-write-wins. `system.reboot` may not return HTTP before reset.
