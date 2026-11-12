# Wi-Fi, SoftAP, mDNS (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/wifi.md) · [Manager](../../manager/docs/wifi.md) · [Hardware](../../hardware/docs/wifi.md)

## What it does
The board joins one saved Wi-Fi network as a station (STA). With no saved network, it opens its own SoftAP `esp32-<last6>`. The SoftAP has a captive portal, so a phone can scan and save Wi-Fi. New credentials are tested before they are saved. The board advertises itself over mDNS once it has a STA address.

## How it works on the ESP
**Saved credentials**
- They live in our own NVS (`network` namespace).
- IDF Wi-Fi storage is `WIFI_STORAGE_RAM`, so the IDF keeps no copy.
- There is one saved network.
- IPv6 and BT are not used.

**Network states** (`network_state_name()`)

| State | Meaning |
|---|---|
| `idle` | Before `network_start()`. |
| `ap_only` | No STA address, SoftAP up. This is the unprovisioned state. |
| `sta_connecting` | STA connecting or retrying. |
| `sta_connected` | Has a STA IP, SoftAP off. |
| `apsta_recovery` | SoftAP up next to the STA. The STA may or may not have an IP. |

**Boot** (`network_start`, called from `app_main`; see [dev/boot.md](../dev/boot.md))
- **Saved SSID**: mode `WIFI_MODE_STA`, then connect.
- **No SSID**: mode `WIFI_MODE_APSTA` and the SoftAP comes up (`ap_only`).
- **No SSID, or safe mode**: `app_main` also starts captive DNS and calls `network_enable_recovery_ap()` (boot state `provisioning`).

**STA retry** (`wifi_event`)
- A disconnect retries up to 8 times (`s_retry < 8`).
- After 8 failures, a provisioned board raises the recovery AP (`apsta_recovery`).
- `recovery_watch_task` checks every 2 s. Once uptime is at least `CONFIG_RUNTIME_WIFI_FAIL_AP_MS` (default 60000) with saved Wi-Fi and no STA IP, it raises the recovery AP and captive DNS.

**SoftAP** (`apply_ap_config`)

| Setting | Value |
|---|---|
| SSID | `ap_ssid()` (the hostname) |
| Channel | 1 |
| Max clients | 4 |
| Address | `192.168.4.1` |
| Auth | Open, or WPA2-PSK when an AP password is set ([system](system.md)) |
| PMF | not required |

**SoftAP DHCP** (`setup_ap_dhcp`) offers DNS `192.168.4.1` and option 114 captive URI `http://192.168.4.1`. Android and iOS then show "Sign in to network".

**Captive DNS** (`components/provisioning`)
- Listens on UDP/53.
- Answers every A or ANY query with `192.168.4.1` (TTL 30 s).
- Answers NODATA for AAAA, HTTPS and other types.
- Drops EDNS (ARCOUNT=0) and ignores non-standard opcodes.
- It is not a full nameserver.
- Started by:
  - an unprovisioned or safe-mode boot
  - `network.wifi.set`
  - a BOOT hold
  - `recovery_watch_task`
  - the UART commands `wifi_clear` and `recovery_ap`
- `provisioning_stop_dns()` exists but nothing calls it. DNS keeps running until reboot.

**Captive probes**
- Any unknown HTTP path (for example `/generate_204` or `/hotspot-detect.html`) returns `302` to `http://192.168.4.1/` with a small body (`web_server.cpp` `captive_404`). iOS ignores an empty redirect.
- httpd allows 13 open sockets because phones open many probe connections.

**Test-before-commit** (`network.wifi.set`)
1. Starts captive DNS.
2. Calls `network_try_sta(ssid, password, 20000)`. This switches to APSTA, so a phone on the portal stays connected, reapplies the AP config, points the STA at the new SSID and waits up to 20 s for `GOT_IP`.
3. On success, `network_commit_wifi()` writes `network/ssid`, `network/password` and `system/provisioned=1`. It sets `s_want_ap`, so the SoftAP stays up (`apsta_recovery`) until the next reboot and the portal can show the new IP.
4. On failure, nothing is saved.
   - The STA stays pointed at the tested SSID until reboot. It does not switch back to the saved network.
   - Retries that run out raise the recovery AP.

**Scan** (`network_scan`)
- Active scan, hidden networks not shown.
- Blocks up to 8 s.
- At most 24 results.
- It can stall httpd for a few seconds.

**mDNS** (`network_start_mdns`, IDF component `espressif/mdns ^1.8.0`)
- Started on the first `IP_EVENT_STA_GOT_IP`. There is no mDNS while in `ap_only`.
- Hostname: `hostname()` (`esp32-xxxxxx.local`).
- Instance name: `device_name()`.
- Services: `_http._tcp` and `_de-esp32._tcp`, both on port 80, both with the same TXT:

| TXT key | Value |
|---|---|
| `path` | `/` |
| `api` | `/api/v1` |
| `openapi` | `/api/v1/openapi.json` |
| `id` | `device_id()` |
| `name` | `device_name()` |
| `fw` | `RUNTIME_VERSION` |
| `board` | `board_profile().id` (`esp32-devkitc`) |

- No IP is put in TXT. The A record carries the address.
- A rename updates the instance name and TXT `name` on both services ([identity](identity.md)).
- Windows mDNS is unreliable, so clients should also use the IP.

**Static IP**: not in this firmware. STA is always DHCP. `network.ip.set` / `network.ip.confirm` and the `wifi_change` status record exist only on the unmerged branch `claude/wifi-change-fallback-ab5ac7`. Current firmware answers `unknown cmd` to them.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `network/ssid` | string, up to 32 chars | unset | Its presence means "provisioned" (`config_has_wifi()`). |
| `network/password` | string, up to 64 chars | `""` | STA threshold `WIFI_AUTH_WPA_WPA2_PSK`, PMF capable. |
| `system/provisioned` | u8 | 0 | Written by commit and clear. Status reports `provisioned` from `network/ssid`, not this key. |
| `CONFIG_RUNTIME_WIFI_FAIL_AP_MS` | Kconfig int | 60000 | Uptime without a STA IP before the recovery AP comes up. |
| AP password | see [system](system.md) | open | NVS `security/ap_password`. |

- Credentials apply as soon as the test succeeds. On boot they are read in `network_start()`.
- Factory reset erases `network`, `system` and `security`, so the board returns to an open `ap_only` state.

## Commands
Test the network, then save it on success. HTTP alias: `POST /api/v1/network/wifi` with `{ssid, password}`.
```json
{"cmd":"network.wifi.set","ssid":"MyNet","password":"secret"}
```
- **Success**: the network status (below) plus `mdns`, the hostname string without `.local`.
- **Errors**: `ssid required` and `wifi test failed; credentials not saved`. The HTTP status is always 200.
- The reply can take up to about 20 s. Clients need a longer timeout.

Scan. HTTP alias: `GET /api/v1/network/scan`, which returns the bare array.
```json
{"cmd":"network.wifi.scan"}
```
```json
{"v":1,"ok":true,"result":[{"ssid":"MyNet","rssi":-52,"channel":6,"auth":3}]}
```
`auth` is the numeric `wifi_auth_mode_t`; 0 means open.

Forget the saved network. This erases the keys, sets APSTA and gives state `ap_only`. It does not start captive DNS; the UART `wifi_clear` does.
```json
{"cmd":"network.wifi.clear"}
```

Bring up the recovery SoftAP next to the STA. It does not start captive DNS; the UART `recovery_ap` does.
```json
{"cmd":"network.recovery_ap"}
```

`network.wifi.clear` and `network.recovery_ap` reply with the network status. Setting the AP password (`network.ap.set_password`) is in [system](system.md).

**Browser flasher** (`install/index.html`):
- Sends `network.wifi.scan` over UART (timeout `SCAN_MS` 12 s) to fill the SSID list.
- After flashing, sends `network.wifi.set {ssid, password}` (timeout `WIFI_MS` 25 s).
- Opens `http://<sta_ip>/` and shows `<mdns or hostname>.local` from the reply.

**BOOT button** (wifi part, see [system](system.md)):
- 5 s hold: recovery AP + DNS.
- 10 s hold: clear Wi-Fi + DNS.

## Events and state
**`GET /api/v1/network`**, also `network` inside `GET /api/v1/status` and `/api/v1/telemetry` (`network_status_json`):

| Field | Notes |
|---|---|
| `state` | One of the states above. |
| `sta_ip` | `""` when there is no IP. |
| `ap_ip` | Always `192.168.4.1`. |
| `ap_ssid` | The SoftAP SSID. |
| `ap_open` | True when no AP password is set. |
| `hostname` | MAC-derived hostname. |
| `rssi` | Re-read live from `esp_wifi_sta_get_ap_info` while connected. |
| `provisioned` | True when `network/ssid` is set. |
| `sta_connected` | True when there is a STA IP. |

The saved SSID and password are never returned.

**Events and other outputs**:
- Event bus `net` `{state, sta_ip}` on every state change. It goes to WebSocket `/api/v1/ws` only, not to MQTT or UART.
- MQTT `…/telemetry` (every 15 s) carries `network`.
- `GET /api/v1/openapi.json` has `servers` (STA IP, `<hostname>.local`, AP IP) and `x-discovery {mdns, service:"_http._tcp", de_service:"_de-esp32._tcp", board, port:80}`.

## Code
- `components/network_manager/src/network_manager.cpp`:
  - `network_start`, `wifi_event`, `network_try_sta`, `network_commit_wifi`, `network_clear_wifi`, `network_enable_recovery_ap`
  - `network_scan`, `network_status_json`, `network_start_mdns`, `network_mdns_refresh_identity`
  - `apply_ap_config`, `setup_ap_dhcp`
- `components/provisioning/src/provisioning.cpp`: `provisioning_start_dns`, `dns_task`.
- `components/command_router/src/command_router.cpp`: the `network.*` handlers.
- `components/web_server/src/web_server.cpp`: `api_network`, `api_scan`, `api_wifi`, `captive_404`, `openapi_json`.
- `main/app_main.cpp`: `recovery_watch_task`, `boot_button_task`, `cmd_wifi_clear`, `cmd_recovery`.
