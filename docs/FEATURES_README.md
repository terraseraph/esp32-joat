# Feature barrel

This is the **only index** for product features. Humans and agents should start here, then follow the linked `*_README.md` files. Adding a component without a README **and** a row below is incomplete work.

Pinned toolchain: **ESP-IDF 5.4.2**, target **esp32** (classic WROOM-32 DevKitC, 4 MB, no PSRAM). Native IDF only — no Arduino.

Template: [templates/FEATURE_README_TEMPLATE.md](templates/FEATURE_README_TEMPLATE.md)

## Status key

- **mvp** — implemented in this tree for the generic GPIO box
- **spike** — present but incomplete
- **later** — named so we do not pretend it exists

## Index

| Feature | Status | README | One-line relationship |
|---|---|---|---|
| Toolchain | mvp | [toolchain_README.md](features/toolchain_README.md) | How to install IDF 5.4.2 and build this repo |
| Boot state machine | mvp | [boot_state_machine_README.md](features/boot_state_machine_README.md) | Orchestrates every other component from `app_main` |
| runtime_core | mvp | [runtime_core_README.md](../components/runtime_core/runtime_core_README.md) | Version, boot status, JSON helpers |
| logging | mvp | [logging_README.md](../components/logging/logging_README.md) | IDF logs + RAM ring for UI |
| config_manager | mvp | [config_manager_README.md](../components/config_manager/config_manager_README.md) | NVS persistence and schema |
| device_identity | mvp | [device_identity_README.md](../components/device_identity/device_identity_README.md) | MAC id; optional name for MQTT topics |
| security | mvp | [security_README.md](../components/security/security_README.md) | Open SoftAP; optional UI password |
| event_bus | mvp | [event_bus_README.md](../components/event_bus/event_bus_README.md) | In-process pub/sub |
| state_registry | mvp | [state_registry_README.md](../components/state_registry/state_registry_README.md) | Live I/O and system state |
| capability_manager | mvp | [capability_manager_README.md](../components/capability_manager/capability_manager_README.md) | ESP32 pin truth; reject before mutate |
| board_profiles | mvp | [board_profiles_README.md](../components/board_profiles/board_profiles_README.md) | DevKitC LED/BOOT + header pinout / buses |
| resource_manager | mvp | [resource_manager_README.md](../components/resource_manager/resource_manager_README.md) | One owner per GPIO; SPI and I2C host refcount |
| module_manager | mvp | [module_manager_README.md](../components/module_manager/module_manager_README.md) | Catalog + NVS instances; apply/teardown vtable |
| io_gpio | mvp | [io_gpio_README.md](../components/io_gpio/io_gpio_README.md) | Digital in/out + debounce IRQ |
| io_pwm | mvp | [io_pwm_README.md](../components/io_pwm/io_pwm_README.md) | LEDC PWM (8 ch, shared Hz) |
| io_servo | mvp | [io_servo_README.md](../components/io_servo/io_servo_README.md) | Hobby servo 50 Hz (8 ch, own timer) |
| io_adc | mvp | [io_adc_README.md](../components/io_adc/io_adc_README.md) | ADC1 only (Wi-Fi on) |
| io_rules | mvp | [io_rules_README.md](../components/io_rules/io_rules_README.md) | On-device if-this-then-that (input → output) |
| mod_mfrc522 | mvp | [mod_mfrc522_README.md](../components/mod_mfrc522/mod_mfrc522_README.md) | SPI RFID; shared bus, unique CS |
| mod_bme280 | mvp | [mod_bme280_README.md](../components/mod_bme280/mod_bme280_README.md) | I2C env sensor; shared bus, unique addr |
| Potential modules | later | [potential_modules_README.md](features/potential_modules_README.md) | More I2C chips + WS281x strip; not compiled in |
| command_router | mvp | [command_router_README.md](../components/command_router/command_router_README.md) | Single command API for HTTP/WS/MQTT |
| network_manager | mvp | [network_manager_README.md](../components/network_manager/network_manager_README.md) | STA + SoftAP + mDNS |
| provisioning | mvp | [provisioning_README.md](../components/provisioning/provisioning_README.md) | Captive DNS + test-before-commit Wi-Fi |
| web_server | mvp | [web_server_README.md](../components/web_server/web_server_README.md) | REST `/api/v1`, OpenAPI, WebSocket, embedded UI |
| mqtt_manager | mvp | [mqtt_manager_README.md](../components/mqtt_manager/mqtt_manager_README.md) | Remote commands and live `io` events |
| telemetry | mvp | [telemetry_README.md](../components/telemetry/telemetry_README.md) | 15 s diagnostics snapshot (hydrate), heap pools, module admission |
| serial_session | mvp | [serial_session_README.md](../components/serial_session/serial_session_README.md) | UART0 REPL + hello/hydrate NDJSON IO stream |
| ota_manager | mvp | [ota_manager_README.md](../components/ota_manager/ota_manager_README.md) | A/B apply, URL pull, pending confirm, rollback |
| Flash tool (Windows) | mvp | [flash_tool_README.md](features/flash_tool_README.md) | Lists COM ports, flashes, optional device name |
| LAN discover / OTA | mvp | [lan_discover_ota_README.md](features/lan_discover_ota_README.md) | mDNS+HTTP scan; Wi-Fi OTA push |
| Node-RED contrib | mvp | [nodered_README.md](features/nodered_README.md) | Host palette: discover/rename + GPIO in/out pinout |
| Browser flash installer | mvp | [web_flash_README.md](features/web_flash_README.md) | Chrome/Edge Web Serial flash, then name and Wi-Fi on UART |

## Dependency sketch

Boot → identity + config → capability + resources → safe pins → network → web + MQTT → apply I/O then modules then rules (unless safe mode).

HTTP, WebSocket, MQTT, and UART JSON must call `command_router`. Do not fork behaviour in `web/dist/index.html`.

## How to add a feature

1. Create `components/<name>/` with CMake + headers + sources.
2. Add `<name>_README.md` from the template, with Depends on / Used by links.
3. Add a row to this barrel.
4. Wire `REQUIRES` in CMake. Avoid cycles (`mqtt_manager` may depend on `command_router`, not the reverse — use the event bus).
5. If the feature is user-facing, add REST via the command router and a UI tab that only calls `/api/v1`.
