# lan_discover_ota_README.md

## Purpose

Find live de-esp32 boards on the LAN and push A/B firmware over HTTP. Discovery uses mDNS `_http._tcp` (and `_de-esp32._tcp` for Node-RED / unique-type browse; firmware advertises both, with an A record for the current IP) plus an HTTP `/24` probe of `GET /api/v1/status`. OTA is `POST /api/v1/ota` of `de_esp32_runtime.bin`. Cursor agents follow `.cursor/skills/ota-push/SKILL.md`.

## User story

After the first USB flash, iterate over Wi-Fi: scan the workshop LAN, pick the box by name, push a new image, confirm it came back healthy.

## Public API

```powershell
python tools/discover.py
python tools/discover.py --json
python tools/ota_push.py
python tools/ota_push.py --ip 192.168.143.245
python tools/ota_push.py --name esp-joat-test --bin D:\esp\de-esp32-build\de_esp32_runtime.bin
.\tools\discover.cmd
.\tools\ota_push.cmd
```

Stdlib Python **3.9+** only (IDF's interpreter, not PlatformIO 3.7). `tools\discover.cmd` / `ota_push.cmd` clear `PYTHONHOME` and call `%LOCALAPPDATA%\Programs\Python\Python39\python.exe`.

Fingerprint: `ota.project == de_esp32_runtime` or hostname `esp32-*`.

## Depends on

[network_manager_README.md](../../components/network_manager/network_manager_README.md) (mDNS `_http._tcp` + `_de-esp32._tcp` + A record),
[ota_manager_README.md](../../components/ota_manager/ota_manager_README.md),
[web_server_README.md](../../components/web_server/web_server_README.md) (`POST /api/v1/ota`, `GET /api/v1/status`),
[toolchain_README.md](toolchain_README.md),
[flash_tool_README.md](flash_tool_README.md) (USB fallback).

## Used by

Developers and Cursor agents on the same LAN as provisioned boards.

## How to update and maintain

Keep the skill and these scripts in the same change if the OTA URL or status JSON shape changes. Do not add pip dependencies. Prefer probing `/api/v1/status` over trusting mDNS names (printers also speak `_http._tcp`). Build output stays on `D:\esp\de-esp32-build`.

## How to test

1. `python tools/discover.py` while `192.168.143.245` is healthy — that IP, name, and `id` appear.
2. `python tools/ota_push.py --ip <that ip>` after a build — device reboots into the other slot, status is `healthy`.
3. Unplug Wi-Fi: discover exits `1`; ota_push must not USB-flash on its own.

## Known limits

Windows mDNS often misses replies; the HTTP sweep of each local `/24` is required. Does not cross routers. SoftAP `192.168.4.1` is only seen if this PC is on that AP. Multiple boards with the same name still need `--ip`.
