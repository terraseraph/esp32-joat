# System: reboot, factory reset, safe mode, password, LED (Node-RED)

Firmware: [docs/features/system.md](../../../docs/features/system.md) · Manager: [manager/docs/system.md](../../../manager/docs/system.md)

## What Node-RED does with it
Not used by Node-RED. No node sends `system.reboot`, `system.factory_reset` or `network.ap.set_password`. None reads `safe_mode`, `safe_reason` or `boot_count`.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| (none) | | | |

## Messages
None.

## Commands sent / events used
- **Probe and Scan** (`lib/fingerprint.js` `summarize`) copy `boot_state` from `GET /api/v1/status` into the scan result. The editor does not show it.
- **Admin route `POST de-esp32/command`** forwards any JSON body to the device, so a flow author could send `system.reboot` through it. No node or UI uses it that way.

## Code
- `lib/fingerprint.js`
- `nodes/de-esp32-device.js`: `/de-esp32/command`

## Gaps
- **Not covered at all**: reboot, factory reset, AP password, and safe-mode or boot-state display.
- **Safe mode is silent.** In safe mode the board skips saved pins, so `gpio-out` and `gpio-in` nodes using `source: configured` find no pins. Nothing in Node-RED explains why. A status check could read `safe_mode` and `safe_reason` from `/api/v1/status`.
- **Commands are unauthenticated**: the firmware has no API password. The Node-RED admin routes are protected only by Node-RED's own `de-esp32-device.read` and `de-esp32-device.write` permissions.
