# state_registry_README.md

## Purpose

RAM map of live I/O keys (`gpio_N`, `pwm_N`, `adc_N`, `servo_N`, `mod_<id>`) for `/api/v1/pins` and telemetry. Not written to NVS.

## User story

Overview and Hardware pinout show current levels without each driver exposing HTTP.

## Public API

`state_set(key, json)`, `state_clear(key)`, `state_get_clone(key)`, `state_snapshot()`. Max 48 keys.

## Depends on

cJSON.

## Used by

io_gpio, io_pwm, io_adc, io_servo, mod_mfrc522, web_server, telemetry.

## How to update and maintain

Keep keys stable (`gpio_4` not `GPIO4`, `servo_4`, `mod_rfid0` for modules). Config (desired) stays in NVS via config_manager; this registry is observed state only.

## How to test

Configure an output, `GET /api/v1/pins`, confirm level.

## Known limits

Snapshot duplicates JSON; do not call it in a hot ISR path.
