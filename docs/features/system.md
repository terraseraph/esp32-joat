# System: reboot, factory reset, safe mode, password, LED (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/system.md) · [Manager](../../manager/docs/system.md) · [Hardware](../../hardware/docs/system.md)

## What it does
Reboot and factory reset on command, from the UART, or with a BOOT-button hold. A crash loop puts the board in safe mode, where saved I/O is not applied. The only password is an optional WPA2 password for the recovery SoftAP. The onboard LED shows the boot and network state.

## How it works on the ESP
**Boot recovery.** The boot order and boot states are in [dev/boot.md](../dev/boot.md). Only the behaviour is summarised here.

**Crash loop and safe mode** (`app_main.cpp:247-263`)
- An `RTC_NOINIT` counter `s_rtc_crash`, not stored in NVS:
  - is set to 1 on power-on;
  - goes up by 1 on every other reset, including `system.reboot`, OTA and panic;
  - is reset to 0 by `healthy_clear_task` after `CONFIG_RUNTIME_HEALTHY_CLEAR_MS` (default 30000) of runtime outside safe mode.
- When the counter is above `CONFIG_RUNTIME_CRASH_LOOP_THRESHOLD` (default 5), safe mode turns on with reason `crash loop — I/O config skipped`.
- In safe mode:
  - saved pins, modules and rules are not applied;
  - the recovery AP and captive DNS start;
  - a pending OTA image is marked invalid and the device reboots into the previous slot (`ota_mark_valid(true)`).
- `healthy_clear_task` does not clear the counter while in safe mode, and every software reset raises it again.
- So safe mode survives `system.reboot`, `factory_reset` and OTA reboots. It is left only by a power-on reset, which sets the counter back to 1.
- Six software reboots in a row, each within 30 s of the previous boot, also trigger safe mode.

**BOOT button** (`boot_button_task`)

| Setting | Value |
|---|---|
| Pin | `board_profile().boot_gpio` (GPIO 0), input with pull-up |
| Polling | every 50 ms |
| When it works | only after the app is running; holding GPIO 0 during reset enters ROM download mode |

Each hold time fires once, while the button is still held:

| Hold | Kconfig | Default | Action |
|---|---|---|---|
| ≥ 5 s | `CONFIG_RUNTIME_BOOT_RECOVERY_MS` | 5000 | `network_enable_recovery_ap()` + captive DNS |
| ≥ 10 s | `CONFIG_RUNTIME_BOOT_PROVISION_MS` | 10000 | `network_clear_wifi()` + captive DNS |
| ≥ 20 s | `CONFIG_RUNTIME_BOOT_FACTORY_MS` | 20000 | `config_factory_reset()` then `esp_restart()` |

**Factory reset** (`config_factory_reset`)
- Erases these NVS namespaces: `network`, `mqtt`, `udp`, `io`, `components`, `ota`, `security`, `stats`, `system`.
- That covers Wi-Fi, MQTT, UDP, pins, modules and rules, OTA state, the AP password, the device name and the config generation.
- The MAC id and hostname are not stored, so they do not change.
- The RTC crash counter is not cleared.
- After the reset the board boots unprovisioned with an open SoftAP.

**Passwords** (`components/security`)
- The recovery SoftAP is open until an AP password is set. Blank means open; otherwise 8-63 chars after trimming spaces and tabs, and the AP uses WPA2-PSK.
- The password is never logged or returned. Do not reuse it for MQTT or anything else.
- There is no UI or API password. HTTP, WebSocket, MQTT command topics and UART are all unauthenticated.
- An open recovery AP can be joined by anyone in range. That is intended for first setup and recovery. Set an AP password if a board stays in AP mode on a shared bench.

**Status LED** (`status_led_task`)

| Setting | Value |
|---|---|
| Pin | `board_profile().status_led_gpio` (GPIO 2) |
| Polarity | `status_led_active_high` (true) |
| Update | every 100 ms |

| Condition (checked in order) | LED |
|---|---|
| safe mode | 400 ms on, 400 ms off |
| boot state `healthy` and STA connected | on |
| boot state `provisioning`, or network `ap_only` | slow blink: 500 ms on, 500 ms off |
| anything else (connecting, recovery AP with STA down) | fast blink: 100 ms on, 100 ms off |

- Nothing reserves GPIO 2 against `pin.configure`, and the LED task writes it every 100 ms. `GET /api/v1/hardware` flags it as `status_led: true`.

**Config backup/restore**
- There is no export or import command.
- Clients rebuild a config from these reads:
  - `GET /api/v1/status` (`name`, `mqtt.uri`/`root`)
  - `GET /api/v1/pins`
  - `module.list`
  - `rule.list`
  - `GET /api/v1/hardware` (`board_id`)
- They replay it with `pin.configure`, `module.add`/`module.configure`, `rule.set`, `mqtt.configure` and `identity.set_name`.
- Wi-Fi credentials, the AP password and MQTT user/password cannot be read back, so no backup can hold them.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `security/ap_password` | string; empty (open) or 8-63 chars | unset (open) | Read once in `security_init()` at boot. A change through the command applies to the SoftAP at once (`apply_ap_config`). |
| `CONFIG_RUNTIME_CRASH_LOOP_THRESHOLD` | Kconfig int | 5 | Build time. |
| `CONFIG_RUNTIME_HEALTHY_CLEAR_MS` | Kconfig int | 30000 | Build time. |
| `CONFIG_RUNTIME_BOOT_RECOVERY_MS` / `_PROVISION_MS` / `_FACTORY_MS` | Kconfig int | 5000 / 10000 / 20000 | Build time. |

## Commands
Reboot. HTTP alias: `POST /api/v1/system/reboot`.
```json
{"cmd":"system.reboot"}
```
- The handler builds `{"v":1,"ok":true}` (no `result`), then calls `esp_restart()`, which does not return. The reply is never sent.
- Expect the connection to drop or time out.

Factory reset. HTTP alias: `POST /api/v1/system/factory_reset`.
```json
{"cmd":"system.factory_reset"}
```
- Same reply behaviour as reboot: erase, then restart.

Set or clear the AP password:
```json
{"cmd":"network.ap.set_password","password":"benchpass123"}
```
- Success: the network status from [wifi](wifi.md), with `ap_open` updated.
- Error: `AP password must be empty (open) or 8-63 characters`, or an NVS error name.
- Send `"password":""` to make the AP open again.

**UART console**:
- `reboot`, `factory_reset`, `status`.
- `ota` prints the OTA status.
- JSON lines `{"cmd":"system.reboot"}` and the other commands work too.

**Browser flasher** (`install/index.html`): its "erase" checkbox erases the whole flash before writing. That is wider than a factory reset; it is done by the flasher, not by this firmware.

## Events and state
**`GET /api/v1/status`**, also `/api/v1/telemetry` and MQTT `…/telemetry` every 15 s:

| Field | Notes |
|---|---|
| `boot_state` | `boot`, `diagnostics`, `identity`, `config`, `capability`, `safe_pins`, `network`, `provisioning`, `management`, `mqtt`, `components`, `healthy`, `safe_mode`, `unknown` |
| `safe_mode` | bool |
| `boot_count` | The RTC counter value at boot. |
| `reset_reason` | Numeric `esp_reset_reason_t`. |
| `uptime_s` | Seconds since boot. |
| `safe_reason` | Status only. `""` when not in safe mode. |
| `generation` | Status only. Config generation. |
| `schema` | Status only. Config schema version. |
| `network.ap_open` | False once an AP password is set. |

- **`GET /api/v1/hardware`**: `status_led_gpio`, `status_led_active_high`, `boot_gpio`.
- **Events**: there is no event for reboot, factory reset or a password change. The WebSocket or MQTT connection simply drops, and MQTT shows LWT `…/availability` = `offline`.

## Code
- `main/app_main.cpp`:
  - `status_led_task`, `boot_button_task`, `healthy_clear_task`
  - crash counter in `app_main`
  - console `cmd_reboot`, `cmd_factory`
- `main/Kconfig.projbuild`: the `CONFIG_RUNTIME_*` values.
- `components/security/src/security.cpp`: `security_init`, `ap_password`, `ap_is_open`, `set_ap_password`.
- `components/network_manager/src/network_manager.cpp`: `network_set_ap_password`, `apply_ap_config`.
- `components/config_manager/src/config_manager.cpp`: `config_factory_reset`.
- `components/command_router/src/command_router.cpp`: `system.reboot`, `system.factory_reset`, `network.ap.set_password`.
- `components/runtime_core/src/runtime_status.cpp`: `set_safe_mode`, `boot_state_name`.
- `components/board_profiles/src/board_profiles.cpp`: LED and BOOT pins.
