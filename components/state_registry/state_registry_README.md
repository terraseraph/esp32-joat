# state_registry_README.md

## Purpose

RAM map of live I/O keys (`gpio_N`, `pwm_N`, `adc_N`) for `/api/v1/pins` and telemetry. Not written to NVS.

## User story

Overview and Hardware pinout show current levels without each driver exposing HTTP.

## Public API

`state_set(key, json)`, `state_get_clone(key)`, `state_snapshot()`. Max 48 keys.

## Depends on

cJSON.

## Used by

io_gpio, io_pwm, io_adc, web_server, telemetry.

## How to update and maintain

Keep keys stable (`gpio_4` not `GPIO4`). Config (desired) stays in NVS via config_manager; this registry is observed state only.

## How to test

Configure an output, `GET /api/v1/pins`, confirm level.

## Known limits

Snapshot duplicates JSON; do not call it in a hot ISR path.
