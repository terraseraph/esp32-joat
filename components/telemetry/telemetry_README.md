# telemetry_README.md

## Purpose

15 s diagnostic snapshot (heap, uptime, reset reason, net, mqtt, ota, I/O state). This is the fat hydrate, not the live pin bus — GPIO/PWM/ADC-on-change go to MQTT `…/io` and WebSocket immediately. ADC channels are refreshed into the registry first (`io_adc_refresh`, no event bus). Published to MQTT and the event bus. No on-device history database.

## User story

Telemetry: MQTT consumers and the Overview page see health. SNTP (boot task) makes timestamps meaningful once STA is up — this snapshot still uses uptime primarily.

## Public API

`telemetry_snapshot()`, `telemetry_start_task()`. REST `GET /api/v1/telemetry` and `/api/v1/status`.

## Depends on

mqtt_manager, network, identity, runtime_core, state_registry, event_bus, ota_manager, io_adc (`io_adc_refresh`).

## Used by

web_server, mqtt publish path, boot.

## How to update and maintain

Keep the period ≥ 10 s to protect heap and flash (we do not write NVS here). Do not speed this up for live pins — that is `…/io`. Add fields in the snapshot only; Grafana belongs off-device.

## How to test

Watch heap_free on Overview while opening tabs. Confirm MQTT telemetry JSON `v=1`.

## Known limits

No timezone conversion. Reset reason is `esp_reset_reason()` numeric.
