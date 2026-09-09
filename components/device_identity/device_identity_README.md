# device_identity_README.md

## Purpose

Stable device id from factory STA MAC (`aabbccddeeff`), hostname `esp32-<last6>`, human name in NVS. MQTT topic slug is the sanitized name when set, otherwise the MAC id.

## User story

Serial and UI show who this board is. Factory reset does not change id. mDNS hostname stays MAC-derived; the instance name and MQTT prefix follow the human name.

## Public API

`device_id()`, `device_topic_id()`, `hostname()`, `ap_ssid()`, `mac_colon()`, `chip_model()`, `chip_info_json()`, `device_name()`, `set_device_name()`.

`chip_model()` — `"ESP32 rev3"` from `esp_chip_info`.
`chip_info_json()` — `{model, revision, cores, features[]}` (`wifi`, `bt`, `ble`, `emb_flash`, `psram`). Caller deletes.

`device_topic_id()` — letters, numbers, `_`, `-` from the name (space/dot → `_`). Empty/invalid name falls back to MAC id.

Command: `identity.set_name` (REST/MQTT) and UART `name [new_name]` (used by `tools/flash.ps1`). Publishes `identity/rename` `{old_topic_id, topic_id, name}` so MQTT resubscribes and mDNS TXT updates.

## Depends on

[config_manager_README.md](../config_manager/config_manager_README.md) for the optional name,
[event_bus_README.md](../event_bus/event_bus_README.md) for rename.

## Used by

network (SSID/mDNS), mqtt topics (slug) and client id (MAC), web overview, security (MAC hash input is read again from eFuse).

## How to update and maintain

Do not persist the MAC; always re-read `esp_read_mac`. If hostname format changes, document it — existing mDNS bookmarks will break. Two boards with the same name share MQTT topics — that is the operator's problem.

## How to test

Compare serial `device_id` with `esptool read_mac`. Rename from Overview; MQTT prefix becomes `devices/<name>/`. Factory reset keeps MAC id, drops the name.

## Known limits

Classic ESP32 has no native USB serial number; identity is Wi-Fi MAC only. Name max 31 characters.
