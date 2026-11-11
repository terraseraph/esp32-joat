# Features

Every user-facing feature has **three docs with the same file name**, one per part:

| Part | Folder | Explains |
|---|---|---|
| Firmware | `docs/features/<name>.md` | How it works on the ESP: hardware, settings, commands, events |
| Node-RED | `nodered/node-red-contrib-de-esp32/docs/<name>.md` | Which nodes use it, their properties, how they map to the firmware fields |
| Manager | `manager/docs/<name>.md` | Which screens and routes use it, the fake device, how they map to the firmware fields |

How the parts connect: [HOW-IT-FITS.md](HOW-IT-FITS.md). Templates: [templates/](templates/). Known mismatches to fix: [lockstep-issues.md](lockstep-issues.md).

## Index

| Feature | Firmware | Node-RED | Manager |
|---|---|---|---|
| Digital in/out, pull-ups, debounce | [gpio](features/gpio.md) | [gpio](../nodered/node-red-contrib-de-esp32/docs/gpio.md) | [gpio](../manager/docs/gpio.md) |
| PWM | [pwm](features/pwm.md) | [pwm](../nodered/node-red-contrib-de-esp32/docs/pwm.md) | [pwm](../manager/docs/pwm.md) |
| Hobby servo | [servo](features/servo.md) | [servo](../nodered/node-red-contrib-de-esp32/docs/servo.md) | [servo](../manager/docs/servo.md) |
| Analog in (ADC1) | [adc](features/adc.md) | [adc](../nodered/node-red-contrib-de-esp32/docs/adc.md) | [adc](../manager/docs/adc.md) |
| Capacitive touch | [touch](features/touch.md) | [touch](../nodered/node-red-contrib-de-esp32/docs/touch.md) | [touch](../manager/docs/touch.md) |
| On-device rules | [rules](features/rules.md) | [rules](../nodered/node-red-contrib-de-esp32/docs/rules.md) | [rules](../manager/docs/rules.md) |
| Addon modules (framework) | [modules](features/modules.md) | [modules](../nodered/node-red-contrib-de-esp32/docs/modules.md) | [modules](../manager/docs/modules.md) |
| RFID (MFRC522) | [rfid](features/rfid.md) | [rfid](../nodered/node-red-contrib-de-esp32/docs/rfid.md) | [rfid](../manager/docs/rfid.md) |
| BME280 environment sensor | [bme280](features/bme280.md) | [bme280](../nodered/node-red-contrib-de-esp32/docs/bme280.md) | [bme280](../manager/docs/bme280.md) |
| Device id and name | [identity](features/identity.md) | [identity](../nodered/node-red-contrib-de-esp32/docs/identity.md) | [identity](../manager/docs/identity.md) |
| Wi-Fi, SoftAP, mDNS | [wifi](features/wifi.md) | [wifi](../nodered/node-red-contrib-de-esp32/docs/wifi.md) | [wifi](../manager/docs/wifi.md) |
| MQTT | [mqtt](features/mqtt.md) | [mqtt](../nodered/node-red-contrib-de-esp32/docs/mqtt.md) | [mqtt](../manager/docs/mqtt.md) |
| UDP output | [udp](features/udp.md) | [udp](../nodered/node-red-contrib-de-esp32/docs/udp.md) | [udp](../manager/docs/udp.md) |
| Firmware updates (OTA) | [ota](features/ota.md) | [ota](../nodered/node-red-contrib-de-esp32/docs/ota.md) | [ota](../manager/docs/ota.md) |
| Status, telemetry, live events | [status](features/status.md) | [status](../nodered/node-red-contrib-de-esp32/docs/status.md) | [status](../manager/docs/status.md) |
| Reboot, factory reset, safe mode, password | [system](features/system.md) | [system](../nodered/node-red-contrib-de-esp32/docs/system.md) | [system](../manager/docs/system.md) |
| UART console | [serial](features/serial.md) | [serial](../nodered/node-red-contrib-de-esp32/docs/serial.md) | [serial](../manager/docs/serial.md) |

## Adding or changing a feature

1. Change the firmware and its doc in `docs/features/<name>.md`.
2. Update or create `nodered/.../docs/<name>.md` and `manager/docs/<name>.md`. Even if a part doesn't support it yet, its doc says so under **Gaps**, with the fields and commands it would need.
3. Update the fake device (`manager/server/fake/`) and `manager/server/src/types/device-api.ts` when a command or payload changes.
4. Add a row above. `node tools/precheck.mjs` fails if a feature is missing one of its three docs.

New addon module: follow the checklist in [features/modules.md](features/modules.md).

## Internal firmware components

Plumbing with no Node-RED or Manager side. Each keeps its README beside the code.

[runtime_core](../components/runtime_core/runtime_core_README.md) ·
[logging](../components/logging/logging_README.md) ·
[config_manager](../components/config_manager/config_manager_README.md) ·
[event_bus](../components/event_bus/event_bus_README.md) ·
[state_registry](../components/state_registry/state_registry_README.md) ·
[capability_manager](../components/capability_manager/capability_manager_README.md) ·
[board_profiles](../components/board_profiles/board_profiles_README.md) ·
[resource_manager](../components/resource_manager/resource_manager_README.md) ·
[command_router](../components/command_router/command_router_README.md) ·
[web_server](../components/web_server/web_server_README.md)

Build setup: [dev/toolchain.md](dev/toolchain.md). Boot sequence: [dev/boot.md](dev/boot.md).

Rules for firmware code: HTTP, WebSocket, MQTT and UART all go through `command_router`; never put behaviour only in `web/dist/index.html`. Avoid component cycles (`mqtt_manager` may depend on `command_router`, not the reverse; use the event bus).
