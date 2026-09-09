---
name: ota-push
description: >-
  Discovers live de-esp32 boards on the LAN (mDNS _http._tcp plus HTTP /24
  probe of /api/v1/status) and pushes firmware with POST /api/v1/ota. Use when
  the user asks to OTA, push firmware, update the running box over Wi-Fi, scan
  or find devices on the network, or after a firmware build that should land on
  a live board. Prefer LAN OTA over USB flash when a device is reachable.
---

# de-esp32 LAN discover + OTA

Repo scripts, no extra pip packages. Windows mDNS is unreliable; the HTTP sweep still finds boards because they serve `/api/v1/status` on port 80 and advertise `_http._tcp`.

## Do this

1. **Discover first** (always, unless the user already gave an IP):

```powershell
.\tools\discover.cmd
.\tools\discover.cmd --json
```

Bare `python` on this PC is often PlatformIO 3.7 (broken sockets). The `.cmd` wrappers use Python 3.9 and clear `PYTHONHOME`. Exit `1` means none found. Then stop — do not USB-flash unless the user asked for `flash.ps1`.

2. **Build** if `D:\esp\de-esp32-build\de_esp32_runtime.bin` is missing or older than the sources you just changed:

```powershell
. .\tools\env.ps1
idf.py -B D:\esp\de-esp32-build build
```

Keep `-B` on local `D:` (the repo on `Y:` is UNC).

3. **Push**

```powershell
.\tools\ota_push.cmd
.\tools\ota_push.cmd --ip 192.168.143.245
.\tools\ota_push.cmd --name esp-joat-test
```

- One live device, or a still-reachable last OTA target: push it.
- Several devices: print the discover table and pass `--ip` / `--name`. Do not pick at random.
- After POST, wait until `/api/v1/status` is healthy again. Report `ip`, `name`, `partition`, `mqtt_prefix`.

## When to run it

- User says OTA, push firmware, update the device, scan the LAN, or “is it online”.
- You just built firmware that should run on the already-provisioned board (UI, MQTT, identity, OTA itself).

Skip OTA for docs-only or host-only changes. Never `idf.py flash` over USB as a substitute when discover found a board.

## Device fingerprint

A host is ours if `/api/v1/status` JSON has `ota.project == de_esp32_runtime`, or `hostname` starts with `esp32-`. mDNS TXT includes `id`, `name`, `openapi=/api/v1/openapi.json`.

## Details

[lan_discover_ota_README.md](../../../docs/features/lan_discover_ota_README.md)
