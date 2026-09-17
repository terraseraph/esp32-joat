# config_manager_README.md

## Purpose

NVS wrapper with schema version, generation counter, and factory reset of **non-identity** namespaces. Configuration is not runtime state.

## User story

Provision Wi-Fi and pin maps survive power-cycle. Factory reset returns to unprovisioned without changing the MAC identity.

## Public API

Namespaces: `system`, `network`, `mqtt`, `io`, `components`, `ota`, `security`, `stats`.

Keys (MVP):

- `system.schema` u8, `system.generation` u32, `system.provisioned` u8, `system.device_name` str
- `network.ssid` / `network.password` str
- `security.ap_password` str (empty / missing = open recovery AP)
- `mqtt.uri` / `mqtt.user` / `mqtt.password` / `mqtt.root` str (root default `devices`), `mqtt.enabled` u8
- `io.pins` blob (JSON). Pin objects may include `debounce_ms` (`in`), `sample_ms` / `hysteresis_mv` / `smooth` (`adc`); missing keys use firmware defaults.

`config_factory_reset()` erases those namespaces then reboots via the command router.

## Depends on

[runtime_core_README.md](../runtime_core/runtime_core_README.md) (`RUNTIME_CONFIG_SCHEMA`).

## Used by

identity (device name), network, mqtt, command_router, boot.

## How to update and maintain

Bump `RUNTIME_CONFIG_SCHEMA` and add a migration branch in `config_init()` before changing blob shapes. Never rewrite NVS from a tight telemetry loop. Generation increments on every successful write so clients can detect concurrent editors (last-write-wins).

## How to test

Set Wi-Fi, reboot, confirm STA reconnects. Factory reset, confirm AP returns open and pins are gone.

## Known limits

NVS blob ~2 KB for pin JSON. Do not store certificates here in MVP.
