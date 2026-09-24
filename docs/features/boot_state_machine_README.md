# boot_state_machine_README.md

## Purpose

`main/app_main.cpp` is the only orchestrator. It walks BOOT → diagnostics → config → identity → capability → safe pins → network → management → MQTT → components → healthy (or safe mode).

## User story

Flash once; unprovisioned boot; survive crash loops without applying a bad I/O config; physical BOOT recovery after the app is running.

## Public API

Kconfig (`main/Kconfig.projbuild`):

- `CONFIG_RUNTIME_BOOT_RECOVERY_MS` (default 5000)
- `CONFIG_RUNTIME_BOOT_PROVISION_MS` (default 10000)
- `CONFIG_RUNTIME_BOOT_FACTORY_MS` (default 20000)
- `CONFIG_RUNTIME_CRASH_LOOP_THRESHOLD` (default 5)
- `CONFIG_RUNTIME_WIFI_FAIL_AP_MS` (default 60000)
- `CONFIG_RUNTIME_HEALTHY_CLEAR_MS` (default 30000)

UART console: `status`, `ota`, `name [new_name]`, `reboot`, `factory_reset`, `wifi_clear`, `recovery_ap`, plus `hello` / `bye` / `hydrate` and JSON lines (see [serial_session_README.md](../../components/serial_session/serial_session_README.md)). Windows flashing: [flash_tool_README.md](flash_tool_README.md).

RTC_NOINIT crash counter (`s_rtc_crash`) is not in NVS.

## Depends on

[runtime_core_README.md](../../components/runtime_core/runtime_core_README.md),
[config_manager_README.md](../../components/config_manager/config_manager_README.md),
[device_identity_README.md](../../components/device_identity/device_identity_README.md),
[security_README.md](../../components/security/security_README.md),
[capability_manager_README.md](../../components/capability_manager/capability_manager_README.md),
[network_manager_README.md](../../components/network_manager/network_manager_README.md),
[command_router_README.md](../../components/command_router/command_router_README.md),
[web_server_README.md](../../components/web_server/web_server_README.md),
[mqtt_manager_README.md](../../components/mqtt_manager/mqtt_manager_README.md),
[provisioning_README.md](../../components/provisioning/provisioning_README.md),
[ota_manager_README.md](../../components/ota_manager/ota_manager_README.md),
[serial_session_README.md](../../components/serial_session/serial_session_README.md),
[io_gpio_README.md](../../components/io_gpio/io_gpio_README.md),
[io_servo_README.md](../../components/io_servo/io_servo_README.md),
[io_rules_README.md](../../components/io_rules/io_rules_README.md),
[module_manager_README.md](../../components/module_manager/module_manager_README.md),
[mod_mfrc522_README.md](../../components/mod_mfrc522/mod_mfrc522_README.md),
[mod_bme280_README.md](../../components/mod_bme280/mod_bme280_README.md).

## Used by

Nothing calls the orchestrator except the IDF `app_main` entry. Status is read by telemetry and the web UI via `RuntimeStatus`.

## How to update and maintain

Keep init order: NVS before identity, capability before I/O, `module_manager_init` + type register before network, network before httpd/MQTT, **skip `command_apply_saved_io`, `command_apply_saved_modules`, and `command_apply_saved_rules` in safe mode**. After `mark_healthy()`, call `ota_mark_valid` so a pending image is confirmed (or rolled back in safe mode). Do not start driving outputs in `io_gpio_init`. BOOT hold must run **after** the ROM bootloader — holding GPIO0 at reset is download mode, not recovery.

## How to test

Hardware: power-cycle, panic loop (temporarily force abort) should enter safe mode after threshold. Hold BOOT 5/10/20 s after serial banner. Unplug router and wait `WIFI_FAIL_AP_MS` for SoftAP.

## Known limits

Status LED uses GPIO2 on DevKitC (also a strapping pin). Do not also configure GPIO2 as a user output. Crash counter lives in RTC RAM and is lost on deep power-down — acceptable for always-on MVP.
