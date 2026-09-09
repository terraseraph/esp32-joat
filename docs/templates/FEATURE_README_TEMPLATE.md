# Feature README template

Copy this file to `components/<name>/<name>_README.md` (or `docs/features/<name>_README.md` if there is no component). Add a row to [FEATURES_README.md](../FEATURES_README.md) in the same change. A component without both is incomplete.

## Purpose

What this feature does in one paragraph.

## User story

Which MVP story it serves (flash, provision, find, safe pins, GPIO, live control, Wi-Fi loss, BOOT recovery, telemetry, reboot/reset).

## Public API

- Headers / functions
- Kconfig symbols
- NVS namespace/keys
- REST `/api/v1/...` and MQTT topics (if any)

## Depends on

Links to other `*_README.md` files this code calls.

## Used by

Links to features that call this one.

## How to update and maintain

1. Change the schema or ABI only with a config schema bump (`RUNTIME_CONFIG_SCHEMA`) or a documented REST `v` field.
2. Keep HTTP, WebSocket, and MQTT going through `command_router` — do not add unique behaviour in the UI.
3. Update this README and the barrel row in the same change.
4. If you add a pin or peripheral rule, update `capability_manager` and `test/test_capability_spec.py`.

## How to test

Host vs hardware steps.

## Known limits

ESP32 flash/RAM/pin constraints that callers must respect.
