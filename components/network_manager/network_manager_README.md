# network_manager_README.md

## Purpose

STA + SoftAP coexistence, scan, test-before-commit connect, mDNS hostname, recovery AP.

## User story

Unprovisioned boot (AP), provision Wi-Fi, find device (`esp32-xxxxxx.local` or STA IP), survive Wi-Fi loss with APSTA.

## Public API

`network_start`, `network_try_sta`, `network_commit_wifi`, `network_clear_wifi`, `network_enable_recovery_ap`, `network_set_ap_password`, `network_scan`, `network_status_json`, `network_start_mdns`.

SSID = hostname. AP IPv4 192.168.4.1. AP is open until `security.ap_password` is set. DHCP on the AP offers DNS `192.168.4.1` and option 114 captive URI `http://192.168.4.1` so phones show a sign-in sheet.

mDNS: hostname `{hostname}.local`, instance = `device_name()`, services `_http._tcp:80` and `_de-esp32._tcp:80` with TXT `path=/`, `api=/api/v1`, `openapi=/api/v1/openapi.json`, `id={deviceId}`, `name={device_name}`, `fw={version}`, `board={board_profile().id}`. A/AAAA records carry the current STA/AP addresses — do not put IPs in TXT (they go stale). Rename updates instance + `name` TXT on **both** services via `identity/rename`.

## Safe Wi-Fi change

`network.wifi.set` (also `POST /api/v1/network/wifi` and the installer's serial JSON line) calls `network_try_sta` then `network_commit_wifi`. The rules:

- The saved network stays in NVS until the new one has associated **and** got a DHCP lease. Only then does `network_commit_wifi` overwrite it. Power loss at any point before that boots on the old network.
- The test runs in APSTA for up to 20 s. Before it starts, `network_try_sta` reads the saved SSID/password and notes whether the radio was STA-only.
- On failure or timeout with a saved network, the STA is pointed back at the saved network straight away (`rollback_sta`, non-blocking, so the error reply is not delayed). If the device was STA-only before, the SoftAP the test raised is turned off again on the next `GOT_IP`. If the old network is also unreachable, the "Lost network" rules below apply.
- If a client is on the SoftAP when the test fails (setup over `192.168.4.1`), only the saved config is put back and the reconnect waits for the background retry, which runs once the SoftAP has no clients. Joining the old network, or scanning for it, would move the SoftAP channel and could drop that client before it reads `wifi_change`.
- With no saved network (first-time provisioning from the SoftAP) there is nothing to go back to. The SoftAP and captive portal stay up as before.
- Only one test runs at a time. A second `network.wifi.set` during a test fails at once with the usual error.
- `switch_sta` sets `s_swapping` while it replaces the STA config, so the event handler does not reconnect or raise `FAIL_BIT` on our own disconnect (`esp_wifi_set_config` refuses while a connect is in flight).

The reply to the original request is unchanged (`ok:true` + status, or `ok:false`, `"wifi test failed; credentials not saved"`). The device's STA link drops for the test, so a LAN caller may never get that reply. The outcome is kept in RAM and shown in `GET /api/v1/network` and in `status.network` as `wifi_change`:

| Field | Meaning |
|---|---|
| `result` | `none` (no change since boot), `testing`, `ok` (connected and saved), `failed` |
| `ssid` | SSID that was tried (never the password) |
| `reason` | when failed: `auth` (wrong password), `no_ap` (SSID not found), `no_ip` (associated, no DHCP), `timeout`, `connect_failed`, `save_failed` (connected but NVS write failed; a reboot returns to the old network) |
| `disconnect_reason` | last raw `wifi_err_reason_t`, 0 if none |
| `restored_previous` | true when the STA was pointed back at the saved network (reconnect may still be pending, see above) |
| `uptime_s` / `time` | when the result was recorded; `time` is Unix seconds, 0 until SNTP has set the clock |
| `seq` | attempts since boot; compare before and after to tell your attempt from an older one |

Only `result` is present while it is `none`. The record is lost on reboot. The failure classification is mirrored in [test/test_wifi_change_spec.py](../../test/test_wifi_change_spec.py); keep the two in step.

A change to a network on another subnet succeeds and is saved, and the caller loses the device: that is expected. Find it again by mDNS or on the new network.

## Lost network

`network_watch_tick(fail_ap_ms)` runs every 2 s from `net_watch` in `main/app_main.cpp`, with `CONFIG_RUNTIME_WIFI_FAIL_AP_MS` (default 60000). It does nothing without saved credentials or while a Wi-Fi change test is running.

| Situation | SoftAP | STA |
|---|---|---|
| No saved network (first boot, after `wifi_clear`) | up, captive portal | idle until a network is set |
| BOOT hold 5 s, `recovery_ap`, `network.recovery_ap`, safe mode | up until reboot (user asked for it) | unchanged |
| Saved network connected | off (an auto SoftAP is dropped after 60 s connected with no AP clients) | connected |
| Saved network gone or password changed, at boot or mid-run | up once the STA has been down for `WIFI_FAIL_AP_MS` (measured from the drop, or from boot) | 8 fast retries, then one attempt every 30 s while the SoftAP has no clients, forever |
| Router back | stays up for 60 s after the STA gets an IP and the AP is empty, then off | reconnects on the next attempt |
| After a successful `network.wifi.set` | dropped the same way (60 s connected, no AP clients) | connected |

Saved credentials are never cleared by any of this. The SoftAP uses the AP password if one is set (`network.ap.set_password`); with none it is **open**, so anyone in range can reach the API while the home network is down. That is a deliberate recovery trade-off: set an AP password if it is not acceptable.

AP and STA share one radio, so the SoftAP follows the STA's channel. A scan while retrying takes the radio off-channel briefly, and a successful join moves the SoftAP to the router's channel, which drops its clients. That is why the background retry pauses while any client is on the SoftAP, and why the auto SoftAP is only dropped when it is empty. `ap_clients` in `GET /api/v1/network` shows the count.

## Depends on

config, identity, security, event_bus, board_profiles, `espressif/mdns`.

## Used by

boot, command_router, provisioning (DNS is separate), web, telemetry, Node-RED scan (`docs/features/nodered_README.md`).

## How to update and maintain

Keep Wi-Fi credentials in our NVS (`network` namespace), not only the IDF Wi-Fi NVS (storage is `WIFI_STORAGE_RAM`). After a successful first STA connect, leave AP up so the phone can read the STA IP; it drops by itself once the phone has left and the STA has been up 60 s. Windows mDNS is unreliable — always surface the IP.

## How to test

No creds → AP. Portal test with good SSID → GOT_IP and commit. On a board already on Wi-Fi, send a wrong password from the LAN: the board must be back on the old network within about 30 s, still STA-only, with `wifi_change.result` `failed`, `reason` `auth` and `restored_previous` true. Repeat with an unknown SSID (`no_ap`) and a good SSID (`ok`). Host spec: `python test/test_wifi_change_spec.py`. Router off at boot or mid-run → recovery AP `WIFI_FAIL_AP_MS` after the drop. Router back → STA rejoins within about 30 s, SoftAP off about 60 s later. Wrong password sent over the SoftAP → `wifi_change` readable at `http://192.168.4.1/api/v1/network`, SoftAP stays up.

## Known limits

One saved network in MVP. The `wifi_change` record lives in RAM only. With a client parked on the SoftAP the saved network is not retried until it leaves. A changed router password is retried every 30 s indefinitely. IPv6 off. BT off. Scan can stall httpd for a few seconds.
