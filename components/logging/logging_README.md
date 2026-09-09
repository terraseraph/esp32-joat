# logging_README.md

## Purpose

Wraps ESP-IDF `esp_log` and keeps a RAM ring (80 × 160 bytes) for the web Logs tab. Does not write logs to flash.

## User story

I can view recent logs from the UI without a serial cable.

## Public API

- `logging_init()` — installs `esp_log_set_vprintf` hook
- `logging_dump()` — cJSON string array (caller deletes)
- REST: `GET /api/v1/logs` (via web_server)

No NVS. No MQTT log stream in MVP.

## Depends on

[runtime_core_README.md](../runtime_core/runtime_core_README.md) (indirect via web).

## Used by

[web_server_README.md](../web_server/web_server_README.md), boot orchestrator.

## How to update and maintain

Increase ring size only after checking BSS/RAM (`idf.py size`). Do not add NVS persistence for log lines. Keep secrets out of `ESP_LOGI` (do not log the optional AP PSK).

## How to test

Open Logs tab; generate a pin error; confirm the line appears. Serial still shows the same logs.

## Known limits

vprintf hook adds a small cost on every log line. High-rate GPIO IRQs should not log in the ISR.
