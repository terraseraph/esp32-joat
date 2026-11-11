# System: reboot, factory reset, safe mode, password, LED (Manager)

Firmware: [docs/features/system.md](../../docs/features/system.md) · Node-RED: [nodered/.../docs/system.md](../../nodered/node-red-contrib-de-esp32/docs/system.md)

## What the Manager does with it
- **Reboot**: device page and fleet bulk action.
- **Factory reset**: device page Danger Zone, and an optional step in SoftAP setup.
- **AP password**: Network tab.
- **Safe mode and boot info**: shown and flagged.
- **Backups**: the Manager builds them itself from device reads, because the firmware has no export command.
- **Not covered**: the status LED and the BOOT button are physical, so the Manager does not touch them.
- **Manager access token**: guards the Manager only. The devices have no password of their own.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Device › System › Danger Zone, `useReboot` | Reboot | `system.reboot` | Confirm "It will be offline for about 10 seconds." |
| Fleet › bulk actions | Reboot | `system.reboot` | Sent to each selected device in parallel. |
| Device › System › Danger Zone | Factory reset | `system.factory_reset` | Two steps. Type `name` (or `hostname`) to confirm. The text names `ap_ssid` as the network it reappears on. |
| Setup flow | Factory reset first | `system.factory_reset` | Sent over the AP link before `send_wifi`. |
| Device › Network › AP | Open / Protected chip, SSID, address | `network.ap_open`, `ap_ssid`, `ap_ip` | "The password can't be read back from the device." |
| Device › Network › AP | Password + Confirm; Remove password | `network.ap.set_password {password}`; `{password:""}` | `logic.ts`: under 8 gives "At least 8 characters", over 63 gives "At most 63 characters", plus a match check. Counts JS string length. |
| Device › System › Uptime | Uptime, Boot count, Last reset, Boot state, Safe mode | `uptime_s`, `boot_count`, `reset_reason` (labels for codes 0-10), `boot_state`, `safe_mode` + `safe_reason` | From live telemetry, else `GET v1/status` every 15 s. |
| Device banners, Fleet | "Safe mode: …" | `safe_mode`, `safe_reason` | The Live tab is disabled in safe mode, and the Pins tab warns. |
| Backups | Snapshot, import/export, restore plan | see below | A safe-mode device gets an "incomplete backup" warning. |
| Settings › Access | LAN access switch, token | (Manager only) | Protects the Manager HTTP/WS API. Nothing is sent to devices. |

## Server side
**Commands**: everything goes through `POST /api/devices/:id/command`, which forwards to the device's `POST /api/v1/command`.
- The UI does not use `/api/v1/system/reboot` or `/api/v1/system/factory_reset`. `client.ts` understands both routes.
- `system.reboot` and `system.factory_reset` are in `HTTP_ONLY` (`device/link.ts`), so they never go over the device WebSocket.

**Expected restart** (`device/client.ts` `RESTART_COMMANDS`, `expectsRestart`)
- The firmware never answers these commands; it restarts inside the handler.
- A socket reset or the 5000 ms timeout therefore becomes `{v:1, ok:true, result:{expectedRestart:true}}`.

**Reboot window** (`device/health.ts`)
- `markRebooting(id)` sets health to `rebooting` for 60 s and polls every 2 s.
- The first good `/status` poll sets it back to `online`.

**Setup factory reset** (`setup/job.ts`)
- After `system.factory_reset`, the job switches to an **open** AP profile, because the reset clears `security/ap_password`.
- It waits up to 45 s. The board counts as back when it went away, `boot_count` rose, or `uptime_s` fell.
- It then checks that the same `id` answers.

**Stored in `last`** (`device/summary.ts`): `boot_state`, `safe_mode`, `safe_reason`.
- Flags `safe_mode` and `boot_unhealthy` (when `boot_state !== "healthy"`).
- `boot_count` and `reset_reason` are not stored.

**Backups** (`server/src/backups/`, `api/backups.ts`)

*Snapshot reads*
- `GET /status`: `name`, `ota.app_version`, `mqtt.uri`, `mqtt.root`
- `GET /pins`
- `module.list`, `rule.list`
- `GET /hardware`: `board_id`
- Pin config comes from the registry `pinShadow` when it matches the live mode.

*File* (`<dataDir>/backups/<bk_…>.json`)
- Contents: `{kind:"de-esp32-backup", v:1, createdAt, manager, source{id,name,app_version,board_id?}, name, pins[], modules[], rules[], mqtt{uri,root}|null, gaps[], note?}`.
- Export: `GET /api/backups/:bid?download=1`. Import: `POST /api/backups/import`, strictly validated.

*Always in `gaps`*: `wifi` and `ap_password`. Also `mqtt_credentials` when MQTT is set, and per-pin `invert`/`pull`/… when a pin was read from live state.

*Restore order* (`planner.ts`), sent as a `backup-apply` job, 3 devices at a time; the first failure stops that device:
1. `rule.remove`
2. `module.remove`
3. `pin.configure {mode:"disabled"}`
4. `pin.configure`
5. `module.configure` / `module.add`
6. `rule.set`
7. `mqtt.configure {uri, root}`
8. `identity.set_name` (only if `include.name`)

## Fake device
`server/fake/commands.ts`, `fakeDevice.ts`, `state.ts`:

| Area | How the fake simulates it |
|---|---|
| `system.reboot` / `system.factory_reset` | Return `Silent` (no reply, connection dropped). `/system/reboot` and `/system/factory_reset` map to the same handlers. |
| `beginReboot` | Offline for `rebootMs` (3000). After a factory reset it stays offline unless `factoryResetReturns`. |
| `wipeConfig` (factory reset) | Clears pins, modules, rules and MQTT. `apPassword ""`, `ap_open` true, name = hostname, `ap_only`, not provisioned. `generation++`. |
| `applyBoot` | `boot_count++`, `reset_reason = 3`, `boot_state` = `safe_mode ? "safe_mode" : "healthy"`. |
| Safe mode | Only through the `safeMode` option (`safe_reason` "forced by fake device option"). There is no CLI flag and no crash-loop emulation. |
| `network.ap.set_password` | `""` or 8-63 chars, else `AP password must be empty (open) or 8-63 characters`. Sets `ap_open`. |

## Code
- `web/src/routes/device/system/{DangerZone,UptimeCard,SystemTab,helpers,useSystemData}.tsx`
- `web/src/components/device/{useReboot.ts,DeviceBanners.tsx}`
- `web/src/routes/fleet/useFleetActions.tsx`
- `web/src/routes/device/network/{ApCard.tsx,logic.ts}`
- `web/src/routes/backups/*`, `web/src/routes/settings/AccessCard.tsx`
- `server/src/device/{client,link,health,summary}.ts`, `server/src/api/deviceCall.ts`
- `server/src/setup/job.ts`
- `server/src/backups/*`, `server/src/api/backups.ts`, `server/src/types/api-backups.ts`
- `server/src/http/{security,access}.ts`
- `server/fake/*`

## Gaps
- **The factory reset text is incomplete.** Danger Zone lists Wi-Fi, pins, add-ons, rules, MQTT, name and AP password. The firmware also erases UDP targets, OTA state and the `stats` namespace.
- **Safe mode outlasts reboots.** It survives `system.reboot` and factory reset; only a power cycle clears it. The UI does not say so, and a reboot from the Manager will not leave safe mode.
- **The fake has no crash-loop or safe-mode recovery behaviour.**
- **`reset_reason` labels** cover only codes 0-10.
- **Reboot downtime wording differs**: "about 10 seconds" on the device page, "a few seconds" in the fleet view, and a 60 s server window.
- **Not covered**: the status LED and the BOOT-button recovery levels (5/10/20 s). They could appear as help text only.
- **Backup restore leaves things out.**
  - It cannot restore Wi-Fi, the AP password or MQTT credentials, because the firmware never returns them.
  - UDP targets are readable from `GET /api/v1/udp` but are not captured.
  - Over-long backup names are covered in [identity](identity.md).
