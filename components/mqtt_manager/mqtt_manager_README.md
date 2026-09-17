# mqtt_manager_README.md

## Purpose

Optional MQTT client. Topics `{root}/{topic_id}/...` where `root` defaults to `devices` (`mqtt.root` in NVS) and `topic_id` is the sanitized device name, or the MAC id if unnamed.

## User story

Remote control and telemetry without the local UI. Device still works if MQTT is unset. Brokers can read `{root}/{topic_id}/api` (retained) for the OpenAPI URL and command topic. Rename or a root change publishes `mqtt/reconfigure` / `identity/rename`; this client clears old retained `availability`/`status`/`api` and reconnects.

## Public API

Subscribe: `system/command`, `config/set`, `components/+/set` (aliases of `command_dispatch`).
Publish: `availability` (retained online/offline), `status`, `telemetry` (15 s fat snapshot), `io` (per-pin live `{topic,data}` JSON, same as WebSocket — GPIO/PWM/servo edges, ADC-on-threshold, RFID UID present/absent; QoS 1, not retained; hydrate burst of one message per pin/module on connect), `events` (command replies), `api` (retained OpenAPI pointer).

Connected counts as a live sink so ADC samples without a browser.

`mqtt://host:1883` in NVS. TLS off in MVP.

Event `mqtt/reconfigure` restarts the client. Event `identity/rename` does the same after retiring the old prefix.

`mqtt_topics_json()` — full topic objects for OpenAPI. `mqtt_status_json()` includes `root`, `prefix`, `sub[]`, `pub[]`. `mqtt_topic_root()` is the configured root (`devices` if unset).

## Depends on

command_router, config, identity, event_bus, IDF `mqtt`.

## Used by

telemetry (publish), web (status + OpenAPI), boot (`mqtt_start`).

## How to update and maintain

Do not add commands here — add them in command_router (`ota.apply` / `ota.rollback` included). Add or rename a topic only in `kMqttTopics`. Keep client id = `device_id()` (MAC). Topics use `mqtt_topic_root()` + `device_topic_id()`. Change root via `mqtt.configure` `{ "root": "site/line1" }`.

## How to test

Mosquitto on LAN. Subscribe to `{root}/<topic_id>/io`. After connect you should see one message per configured pin and RFID instance, then edges immediately. ADC moves when millivolts cross `hysteresis_mv`. RFID publishes when UID appears or leaves. `telemetry` stays 15 s. Publish `{"cmd":"pin.set","gpio":4,"value":1}` to `{root}/<topic_id>/system/command`.

## Known limits

LAN plaintext MQTT. No broker in firmware. Wildcard subscribe requires broker support. `config/set` and `components/+/set` are aliases — `+` is not interpreted.
