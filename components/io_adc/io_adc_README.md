# io_adc_README.md

## Purpose

ADC1 oneshot (IDF 5.x driver). ADC2 is rejected by capability because Wi-Fi is always on.

## User story

ADC on GPIO 32–39 (ADC1). Values in millivolts when calibration exists.

## Public API

`io_adc_configure`, `io_adc_read`, `io_adc_refresh`, `io_adc_release`.

Atten `ADC_ATTEN_DB_12`. REST/MQTT via pin configure mode `adc`. A 250 ms task samples configured channels **only while** `RuntimeStatus::live_viewers() > 0` (a Hardware-tab WebSocket). Samples go on the event bus as `io/adc` (20 mV hysteresis) so the UI can paint without `GET /status`. MQTT does **not** get the 4 Hz stream — `io_adc_refresh()` runs on the 15 s telemetry tick for `adc_N` in the snapshot.

## Depends on

capability (ADC1 only), resource, state_registry, event_bus, runtime_core (`live_viewers`), `esp_adc`.

## Used by

command_router, telemetry (via state).

## How to update and maintain

Do not “just enable ADC2”. If a future profile is Wi-Fi-off, that is a new mode, not a silent change. Calibration uses line-fitting on ESP32.

## How to test

Pot on GPIO 34 (input-only ADC). Compare `io_adc_read` vs expected voltage.

## Known limits

GPIO 37/38 often not routed. 12 dB atten ≈ 0–3.3 V with reduced accuracy at the rails.
