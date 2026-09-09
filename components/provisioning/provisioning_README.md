# provisioning_README.md

## Purpose

Captive-portal DNS (UDP/53 → 192.168.4.1) so phones open the same embedded UI. DHCP also advertises DNS and option 114 (`http://192.168.4.1`) so Android/iOS show **Sign in to network**. Wi-Fi test-before-commit lives in command_router + network_manager.

## User story

Connect to recovery AP, OS shows a sign-in page, scan and save Wi-Fi. Success screen includes STA IP and mDNS name.

## Public API

`provisioning_start_dns()`, `provisioning_stop_dns()`.

Probe URLs (`/generate_204`, `/hotspot-detect.html`, …) are not served as the UI. They 404 into a 302 + body to `http://192.168.4.1/` (web_server). DNS answers A for type A, NODATA otherwise, and strips EDNS so the packet stays valid.

## Depends on

lwIP sockets. Network manager for AP.

## Used by

boot (unprovisioned / safe mode / BOOT hold / STA timeout).

## How to update and maintain

Keep DNS answers tiny (header + question + one A). Do not stop DNS immediately after STA connect — the phone is still on the AP. BLE provisioning is out of MVP.

## How to test

Phone joins AP; OS should show Sign in and open the UI (or open 192.168.4.1 by hand). Android/iOS captive sheet should load the Network tab. Intentionally wrong Wi-Fi password → error, NVS ssid unchanged.

## Known limits

DNS responder is not a full nameserver. Some clients ignore captive portals; user can still go to 192.168.4.1.
