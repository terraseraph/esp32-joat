# io_adc_README.md

## Purpose

ADC1 oneshot (IDF 5.x driver). ADC2 is rejected by capability because Wi-Fi is always on.

## User story

ADC on GPIO 32–39 (ADC1). Live state is millivolts (`mv`) plus 12-bit counts (`raw`, 0–4095, UI scale 4096). Per-pin `sample_ms` (default 50, 20–1000), `hysteresis_mv` (default 20, 5–500, vs last **sent** filtered mV), and `smooth` (default 70, 0–90 = percent weight of the previous filtered value).

## Public API

`io_adc_configure(gpio, sample_ms, hysteresis_mv, smooth, …)`, `io_adc_read`, `io_adc_refresh`, `io_adc_release`.

Atten `ADC_ATTEN_DB_12`. Each tick averages 4 oneshot reads, then EMA: `filt = (smooth * prev + (100-smooth) * mv) / 100` (`smooth` 0 = raw). Event bus `io/adc` only when `|filt - last_sent| >= hysteresis_mv` (or first sample). Live task runs only while `RuntimeStatus::live_sinks() > 0` (UI, MQTT, serial, or an ADC-watching on-device rule). `io_adc_refresh()` updates the registry on the 15 s telemetry tick without moving last-sent or flooding the bus.

## Depends on

capability (ADC1 only), resource, state_registry, event_bus, runtime_core (`live_sinks`), `esp_adc`.

## Used by

command_router, telemetry (via state), [io_rules_README.md](../io_rules/io_rules_README.md).

## How to update and maintain

Do not “just enable ADC2”. If a future profile is Wi-Fi-off, that is a new mode, not a silent change. Calibration uses line-fitting on ESP32. Keep last-sent hysteresis (not last-reading) so slow drift still reports after smooth.

## How to test

Pot on GPIO 34. With default smooth 70 and 20 mV threshold, MQTT `…/io` should not chatter every sample; turning the pot should still move. `smooth` 0 + low threshold chatters on Wi-Fi noise.

## Known limits

GPIO 37/38 often not routed. 12 dB atten ≈ 0–3.3 V with reduced accuracy at the rails. Oversample is fixed at 4 (not a UI knob).
