# Wi-Fi, SoftAP, mDNS (Node-RED)

Firmware: [docs/features/wifi.md](../../../docs/features/wifi.md) · Manager: [manager/docs/wifi.md](../../../manager/docs/wifi.md) · Hardware: [hardware/docs/wifi.md](../../../hardware/docs/wifi.md)

## What Node-RED does with it
Node-RED only finds boards that are already on the LAN, through mDNS, an HTTP fingerprint and MQTT retained topics. It does not send `network.*` commands. It cannot provision Wi-Fi, scan, use the SoftAP, or change the AP password.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-device` | `host` | `network.sta_ip`, or `<hostname>.local` typed by hand | Scan fills in the IP it found. `http.normalizeHost` cleans it. |
| `de-esp32-device` | `port` | HTTP port 80 (mDNS SRV port) | Default 80. |

## Messages
None.

## Commands sent / events used
**Scan** (editor button, `GET de-esp32/scan?timeout=2500&root=…&host=…&broker=…`), `lib/discover.js`:
1. mDNS PTR queries for `_de-esp32._tcp.local` and `_http._tcp.local` (package `multicast-dns`). It waits `timeoutMs`, default 2500.
   - A response counts as "ours" if a PTR name contains `_de-esp32._tcp`, or the TXT passes `looksLikeOursTxt`.
   - `looksLikeOursTxt` is true for `openapi === "/api/v1/openapi.json"`, `api === "/api/v1"`, a 12-char `id`, or a `board` starting with `esp32`.
   - A-record IPs from those responses are probed first.
2. Each IP gets `GET http://<ip>:80/api/v1/status` (800 ms timeout). It must pass `fingerprint.isOurs`: `ota.project === "de_esp32_runtime"`, or a `hostname` starting with `esp32-`, or a `chip` starting with `ESP32` plus a 12-char `id`.
3. The typed `host`, if any, is probed too.
4. With a broker, MQTT retained topics are read (see [identity](identity.md)).

**Live link**: there is no WebSocket subscription to `net`. A board that changes IP must be updated by hand.

## Code
- `lib/discover.js`: `mdnsCandidateIps`, `parseTxt`, `looksLikeOursTxt`, `probeIp`, `mqttDiscover`, `scan`.
- `lib/fingerprint.js`: `isOurs`, `summarize`.
- `lib/http.js`: `getStatus` (default timeout 1500 ms).
- `nodes/de-esp32-device.js`: `/de-esp32/scan`.

## Gaps
- **Not covered**: `network.wifi.set`, `network.wifi.scan`, `network.wifi.clear`, `network.recovery_ap` and SoftAP provisioning.
- **TXT values not read**: the TXT `name`, `fw`, `id` and `path` are only used for the "ours" test, never as device fields. The HTTP probe supplies those.
- **IP changes are not followed.** `host` is stored as a plain IP. When the board gets a new DHCP lease, the node breaks until it is edited. The firmware `net` event (`{state, sta_ip}`) is WebSocket-only, and mDNS `<hostname>.local` is not used automatically.
- **Network state is not shown**: `state`, `rssi`, `ap_open` and `provisioned`.
