# event_bus_README.md

## Purpose

In-process pub/sub so MQTT can reconfigure without `command_router` depending on `mqtt_manager`, and so the web server can stream events over WebSocket.

## User story

Live control: pin edges and telemetry appear in the UI without polling-only.

## Public API

`event_bus_subscribe(prefix, cb, ctx)`, `event_bus_publish(topic, json)`.

Prefix match is `strncmp`. Empty prefix matches all (web_server).

Topics used: `io/gpio`, `net`, `mqtt/reconfigure`, `identity/rename`, `telemetry`.

## Depends on

cJSON, FreeRTOS mutex. Max 12 subscribers.

## Used by

io_gpio, network, command_router (mqtt reconfigure), mqtt_manager, telemetry, web_server.

## How to update and maintain

Do not call `publish` from an ISR. Callbacks must not block or re-enter the bus with the mutex held (the bus copies the table first). Avoid router ↔ mqtt CMake cycles: publish `mqtt/reconfigure` instead.

## How to test

Toggle a GPIO input; WebSocket should refresh. Save MQTT URI; client should reconnect without reboot.

## Known limits

No wildcard `+/#` like MQTT. No persistence.
