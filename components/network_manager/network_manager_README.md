# network_manager_README.md

## Purpose

STA + SoftAP coexistence, scan, test-before-commit connect, mDNS hostname, recovery AP.

## User story

Unprovisioned boot (AP), provision Wi-Fi, find device (`esp32-xxxxxx.local` or STA IP), survive Wi-Fi loss with APSTA.

## Public API

`network_start`, `network_try_sta`, `network_commit_wifi`, `network_clear_wifi`, `network_enable_recovery_ap`, `network_set_ap_password`, `network_scan`, `network_status_json`, `network_start_mdns`.

SSID = hostname. AP IPv4 192.168.4.1. AP is open until `security.ap_password` is set. DHCP on the AP offers DNS `192.168.4.1` and option 114 captive URI `http://192.168.4.1` so phones show a sign-in sheet.

mDNS: hostname `{hostname}.local`, instance = `device_name()`, service `_http._tcp:80` with TXT `path=/`, `api=/api/v1`, `openapi=/api/v1/openapi.json`, `id={deviceId}`, `name={device_name}`, `fw={version}`. A/AAAA records carry the current STA/AP addresses — do not put IPs in TXT (they go stale). Rename updates instance + `name` TXT via `identity/rename`.

## Depends on

config, identity, security, event_bus, `espressif/mdns`.

## Used by

boot, command_router, provisioning (DNS is separate), web, telemetry.

## How to update and maintain

Keep Wi-Fi credentials in our NVS (`network` namespace), not only the IDF Wi-Fi NVS (storage is `WIFI_STORAGE_RAM`). After a successful first STA connect, leave AP up so the phone can read the STA IP. Windows mDNS is unreliable — always surface the IP.

## How to test

No creds → AP. Portal test with good SSID → GOT_IP and commit. Pull Ethernet on the AP/router → recovery AP within `WIFI_FAIL_AP_MS`.

## Known limits

One saved network in MVP. IPv6 off. BT off. Scan can stall httpd for a few seconds.
