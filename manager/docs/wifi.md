# Wi-Fi, SoftAP, mDNS (Manager)

Firmware: [docs/features/wifi.md](../../docs/features/wifi.md) · Node-RED: [nodered/.../docs/wifi.md](../../nodered/node-red-contrib-de-esp32/docs/wifi.md)

## What the Manager does with it
| Area | What it does |
|---|---|
| Discover | Finds boards over mDNS, a subnet sweep and fixed targets. |
| SoftAP setup | Windows only. Joins a board's `esp32-xxxxxx` AP from the PC and sends it Wi-Fi credentials. |
| Device › Network | Shows the network status and the AP card ([system](system.md)). |
| IP change, Wi-Fi move | Built for the unmerged firmware branch `claude/wifi-change-fallback-ab5ac7`. Current firmware lacks the fields, so both report "needs newer firmware". |

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Discover › Advanced | Use mDNS / Sweep local networks / Extra subnets / Also probe addresses | (Manager only) | `scanOptions.ts`. Subnets are CIDR /8-/30. Targets are `host` or `host:port`. |
| Discover › Manual add | IP address or hostname | `host` | `POST /api/devices {host}`. |
| Discover › results | "Setup AP open", net state chip | `network.state`, `network.sta_connected` | `setup` = `ap_only`, or `apsta_recovery` with `sta_connected !== true`. |
| Discover › Setup list | SSID, signal, Open / Password protected | SoftAP `ap_ssid`, auth | SSID must match `/^esp32-[0-9a-f]{6}$/i`. The last 6 chars are matched to registry ids. |
| Setup flow | Setup Wi-Fi password | `security/ap_password` (the AP's WPA2 PSK) | Only when the AP is secured. 8-63 chars. |
| Setup › Choose network | Network list (dBm), "Another network…" name (`maxLength` 32), Wi-Fi password (`maxLength` 63) | `network.wifi.scan` result `ssid`/`rssi`/`auth`; `network.wifi.set {ssid, password}` | `secure = auth !== 0`. |
| Setup flow | Factory reset first | `system.factory_reset` | See [system](system.md). |
| Device › Network › Wi-Fi | Status, IP address, Hostname, Signal, Provisioned | `state`, `sta_ip`, `<hostname>.local`, `rssi`, `provisioned` | The `apsta_recovery` banner shows `ap_ssid`. The signal is labelled "(measured when it connected)". |
| Device › Network › IP | DHCP/Static, IP, Netmask, Gateway, DNS | pending `network.ip.set` | Hidden behind "Needs newer firmware" when `network.ip_mode` is absent. |
| Device › Network › Wi-Fi move | Network name, Password, "Scan from the device" | pending `wifi_change`; `network.wifi.set`, `GET v1/network/scan` | Disabled when `network.wifi_change` is absent. |

## Server side
**Discovery** (`server/src/discovery/`, routes `POST /api/discovery/scan`, `GET /api/discovery`, `POST /api/discovery/{cancel,ignore,adopt}`)

*mDNS* (`mdns.ts`)
- PTR queries for `_de-esp32._tcp.local` and `_http._tcp.local`, a 2500 ms window, and one repeat at a third of the window.
- A response counts as "ours" if any of these hold:
  - a PTR or SRV name contains `_de-esp32._tcp`;
  - the TXT passes `looksLikeOursTxt` (`openapi`, `api`, a 12-char `id`, or `board` starting `esp32`);
  - an A record for an `esp32-*` host, which gets port 80.
- The TXT `name`, `fw` and `board` are used only as fallbacks. `path` is not read.

*Sweep* (`sweep.ts`)
- `GET /api/v1/status` on port 80, 800 ms timeout, 48 at a time.
- Each interface subnet is clamped to /24.

*Fingerprint*
- `status.id` must match `/^[0-9a-f]{12}$/i`, and `fingerprint.isOurs` must pass. It shares `lib/fingerprint.js` with Node-RED.
- Host choice: the registered host if it answers, else the one equal to `network.sta_ip`, else the first one found.

*`waitForDevice(id)`* is used by setup, IP change and Wi-Fi move. Each round tries the registry address and targets, then mDNS, then the sweep.

**SoftAP setup** (`server/src/setup/`, `server/src/wifi/`, routes under `/api/setup/`)
- The adapter is `netsh` on Windows. Other OSes use the `none` adapter: "SoftAP setup is supported on Windows only for now".
- Temporary profiles are named `de-esp32-setup-<8 hex>`. They are open, or WPA2PSK/AES when an AP password is given.

| Step | What happens |
|---|---|
| remember | Notes the PC's current Wi-Fi in the marker `<dataDir>/setup-recovery.json`. |
| join_ap | Connects to the board's AP (`joinMs` 20 s). |
| fingerprint | `GET http://192.168.4.1/api/v1/status` until `apReachMs` 30 s. A captive redirect means "not our device". |
| scan | `GET /api/v1/network/scan` (15 s). |
| choose | Waits for the user's choice (180 s). |
| factory_reset | Optional. See [system](system.md). |
| send_wifi | `POST /api/v1/network/wifi {ssid, password}` (25 s). An open network sends `password: ""`. |
| check_result | `ok:true` means success. `ok:false` gives "most likely a wrong password". With no reply it polls `/status`: `sta_connected && sta_ip` means success, 3 unreachable polls mean the board left the AP. |
| leave_ap | Puts the PC back on its own network (`setup/restore.ts`). |
| wait_lan | `waitForDevice` for up to 90 s. |
| add | Writes the registry entry. |

- The `sta_ip` and `mdns` in the reply are not used to find the board.
- `identity.set_name` is never sent during setup.

**Device client** (`device/client.ts`)

| Constant | Value |
|---|---|
| `DEFAULT_TIMEOUT_MS` | 5000 |
| `WIFI_TIMEOUT_MS` | 25000 (used for `network.wifi.set` / `POST /network/wifi`) |
| `SCAN_TIMEOUT_MS` | 12000 |
| `MAX_DEVICE_BODY` | 1536, the same as the firmware `read_body` limit |

- `HTTP_ONLY` in `device/link.ts` holds `network.wifi.set` and `network.wifi.scan`, so these never go over the device WebSocket.

**Events**: the Network tab reloads on the WebSocket `net` event (`NetworkTab.tsx`).

**IP change** (`server/src/ipchange/`, `/api/devices/:id/ip`)
- `supported = network.ip_mode !== undefined`. Otherwise it answers 409 `ip_change_unsupported`.
- It sends `network.ip.set {mode:"static", ip, netmask, gateway, dns}` or `{mode:"dhcp"}`, then `network.ip.confirm {seq}` at the new address.
- Timings: apply 1.5 s, confirm window 90 s.

**Wi-Fi move** (`server/src/wifimove/`, `/api/devices/:id/wifi`)
- `supported = network.wifi_change !== undefined`. Otherwise it answers 409 `wifi_change_unsupported`.
- It sends `network.wifi.set`, then re-finds the board for up to 90 s, using `wifi_change.seq` and `result`.

**Stored**: the registry `host` and `hostname`, and the setup marker. Backups store no Wi-Fi data (gaps `wifi`, `ap_password`).

## Fake device
`server/fake/commands.ts`, `state.ts`, `pending.ts`, `fakeDevice.ts`:

| Command or area | How the fake simulates it |
|---|---|
| `network.wifi.set` | Emits `net` `sta_connecting` and waits `wifiSetDelayMs` (2000). It fails with `wifi test failed; credentials not saved` for SSID `fail` or `wifiSetFails`. On success: `sta_ip` 192.168.1.42, rssi -55, state `apsta_recovery`, or `sta_connected` with `--ap-mode`. Returns status + `mdns: true`. |
| `network.wifi.scan` / `GET /network/scan` | After `scanDelayMs` (1500) returns a fixed list: `workshop-wifi`, `guest`, `neighbour-5g`, `FRITZ!Box 7590`, `fail`. |
| `network.wifi.clear` | `ap_only`, and the board leaves the LAN. |
| `network.recovery_ap` | `apsta_recovery`. |
| Default network | `sta_connected`, `ap_ip` 192.168.4.1, `ap_ssid` = hostname, `ap_open` true. |
| SoftAP | Not real. The Manager's fake Wi-Fi adapter (`server/src/wifi/fake.ts`, `--fake-ap`) maps an SSID to a loopback `host:port`. Unknown routes 302 to `http://192.168.4.1/`. |
| mDNS | Not simulated. |
| `--pending-firmware` | Adds `wifi_change`, `ip_mode`, `netmask`, `gateway`, `dns`, `ap_clients`, `ip_change`, and the `network.ip.*` commands. Without it those commands answer `unknown cmd`, like real firmware. |

## Code
- `server/src/discovery/{index,mdns,sweep}.ts`, `server/src/api/discovery.ts`
- `server/src/setup/{index,job,marker,restore}.ts`, `server/src/api/setup.ts`, `server/src/wifi/*`
- `server/src/ipchange/*`, `server/src/api/ip.ts`
- `server/src/wifimove/index.ts`, `server/src/api/wifimove.ts`
- `server/src/device/{client,link}.ts`
- `server/src/types/device-api.ts` (`NetworkStatus`, `NetState`, `AccessPoint`, `WifiSetResult`, `Network*Command`)
- `web/src/routes/discover/*`, `web/src/routes/discover/setup/*`, `web/src/routes/device/network/{NetworkTab,WifiCard,logic}.tsx`, `ip/*`, `wifimove/*`

## Gaps
- **`rssi` is live, not a connect-time sample.** The firmware re-reads it live. `NetworkStatus.rssi` is documented as "Sampled at connect time, not live", and `WifiCard` says "(measured when it connected)". Both are out of date.
- **`mdns` in the `network.wifi.set` result** is the hostname string. It is typed `unknown`, and the fake returns `true`.
- **Pending fields and commands**: `network.ip.set`, `network.ip.confirm`, `wifi_change`, `ip_mode`, `netmask`, `gateway`, `dns`, `ap_clients` and `ip_change` do not exist in current firmware. IP change and Wi-Fi move cannot run on it.
- **No UI** for `network.wifi.clear` or `network.recovery_ap`. On current firmware Wi-Fi scan appears only in setup.
- **SoftAP setup** is Windows-only.
- **The fake's `network.wifi.set` delay** is 2 s. Real hardware can take up to 20 s.
- **Stale text in Discover**: the setup row says "Setting up its Wi-Fi from here is not available yet." (`ResultGroups.tsx`), although SoftAP setup exists.
- **A failed test is not described.** On current firmware the STA stays pointed at the failed SSID until reboot. The Manager does not tell the user this.
