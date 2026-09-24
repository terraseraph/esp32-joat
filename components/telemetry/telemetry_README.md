# telemetry_README.md

## Purpose

15 s diagnostic snapshot (heap, memory pools, uptime, reset reason, net, mqtt, ota, I/O state). This is the fat hydrate, not the live pin bus — GPIO/PWM/ADC-on-change go to MQTT `…/io` and WebSocket immediately. ADC channels are refreshed into the registry first (`io_adc_refresh`, no event bus). Published to MQTT and the event bus. No on-device history database.

## User story

Telemetry: MQTT consumers and the Overview page see health. SNTP (boot task) makes timestamps meaningful once STA is up — this snapshot still uses uptime primarily.

## Public API

`telemetry_snapshot()`, `telemetry_start_task()`. `memory_boot_mark`, `memory_admit`, and `memory_status_json` are declared from `telemetry.hpp` (via `memory_budget.hpp`) and implemented in runtime_core so module_manager can call `memory_admit` without a component cycle through MQTT. REST `GET /api/v1/telemetry` and `/api/v1/status` include `heap_free`, `heap_min`, and `memory`.

`memory` fields: `pressure` (`ok` / `warn` / `critical`), `alloc_failed`, `alloc_failed_size`, `reserve` (24576), `internal` (`total`, `free`, `min`, `largest`, `used`), `dma` (`free`, `largest`), `psram` (null when absent, otherwise the internal shape), `boot` (up to 8 `{stage, free, largest}` samples; first name wins), `tasks` (`{name, stack_min}` high-water mark in bytes, refreshed at most every 5 s), `tasks_truncated`.

Pressure uses internal DRAM only. Critical: largest under 12 KB or free under 24 KB. Warn: largest under 48 KB or free under 48 KB. `memory_admit` returns `ESP_ERR_NO_MEM` when pressure is already critical, the block will not fit, or free heap would fall under the reserve. The error string includes bytes needed, largest block, and free.

## Depends on

mqtt_manager, network, identity, runtime_core (`memory_budget`), state_registry, event_bus, ota_manager, io_adc (`io_adc_refresh`).

## Used by

web_server, mqtt publish path, boot.

## How to update and maintain

Keep the period ≥ 10 s to protect heap and flash (we do not write NVS here). Do not speed this up for live pins — that is `…/io`. Add fields in the snapshot only; Grafana belongs off-device.

## How to test

Watch the heap pill and the System tab Memory card while opening tabs. Confirm MQTT telemetry JSON `v=1` includes `memory.pressure` and `memory.boot` stages `boot`, `wifi`, `http`, `mqtt`, `modules`.

## Known limits

No timezone conversion. Reset reason is `esp_reset_reason()` numeric. Task list is a cap of 24 names, not a per-feature heap breakdown. `stack_min` is the FreeRTOS high-water mark (minimum free stack), not the allocated size.
