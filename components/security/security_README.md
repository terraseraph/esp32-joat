# security_README.md

## Purpose

Recovery SoftAP starts **open**. An optional WPA2 PSK can be set from the UI and is stored in NVS. Factory reset (or a blank password) makes the AP open again.

## User story

Join `esp32-<last6>` with no password, open `http://192.168.4.1`, optionally set an AP password so the portal is not open on the bench.

## Public API

`security_init()`, `ap_password()` (empty = open), `ap_is_open()`, `set_ap_password()` (empty or 8-63 chars).

LAN UI/API remain unauthenticated in MVP (Phase 6 will add session auth).

## Depends on

[config_manager_README.md](../config_manager/config_manager_README.md) (`security.ap_password`).

## Used by

[network_manager_README.md](../network_manager/network_manager_README.md),
[command_router_README.md](../command_router/command_router_README.md) (`network.ap.set_password`).

## How to update and maintain

Do not log the PSK. Do not reuse it as MQTT or UI auth. WPA2 rejects passwords shorter than 8 characters.

## How to test

Unprovisioned / factory-reset board: AP is open. Set a password from Network tab; reconnect with WPA2. Factory reset: AP is open again.

## Known limits

An open recovery AP is joinable by anyone in range. That is the point of first-flash and post-reset recovery. Set a password if the board stays in AP mode on a shared bench.
