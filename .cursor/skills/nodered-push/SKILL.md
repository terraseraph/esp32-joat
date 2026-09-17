---
name: nodered-push
description: >-
  Packs nodered/node-red-contrib-de-esp32 and POSTs the .tgz to a live Node-RED
  editor (default 192.168.0.132:1880 /nodes). Use when the user asks to push,
  install, or update the de-esp32 Node-RED palette, load nodes onto the Pi,
  iterate on gpio in/out or the device config node, or after palette source
  changes that should land on the running editor. Prefer this over npm link,
  shared-drive folder install, or SSH into ~/.node-red.
---

# de-esp32 Node-RED palette push

Repo scripts. The editor UI file-picker is optional; agents should `npm pack` and POST the tarball to the Node-RED admin API. The Pi does not see `Y:`.

## Do this

1. **Host tests** if you touched `nodered/node-red-contrib-de-esp32/lib/` or node JS:

```powershell
cd nodered/node-red-contrib-de-esp32
npm test
```

2. **Push** (always, unless the user only asked about firmware):

```powershell
.\tools\nodered_push.cmd
.\tools\nodered_push.ps1 -HostName 192.168.0.132
```

The script bumps the package patch version (Node-RED often keeps the old `require` cache when the tarball is still `0.1.0`), **DELETE**s `node-red-contrib-de-esp32` then POSTs a fresh tarball (`module_already_loaded` otherwise). If DELETE returns `type_in_use`, it briefly parks de-esp32 nodes on the canvas, swaps the module, then restores the flow. After install, probe `GET /de-esp32/pinout-template` — HTTP 404 means the runtime did not reload; bump/push again or restart Node-RED. Default host is `192.168.0.132` port `1880`, or the last successful target in `tools/nodered_state.json`. Pass `-HostName` / `-Port` when the user named a different editor.

3. **Confirm** the JSON names `node-red-contrib-de-esp32` and the three node types (`de-esp32-device`, `de-esp32-gpio-in`, `de-esp32-gpio-out`) with `enabled: true`. Install path on this Pi is `/home/pi/.node-red/node_modules/node-red-contrib-de-esp32`. Tell the user to **refresh the Node-RED browser tab** — the runtime has the module; the editor cache does not update until reload.

## When to run it

- User says push/install Node-RED nodes, load the palette, update the Pi editor, or “will this work in Node-RED”.
- You just changed files under `nodered/node-red-contrib-de-esp32/` (nodes, lib, package.json) that should appear on the live editor.

Skip for firmware-only, docs-only, or IDF builds. Do not `npm link`, do not copy a folder over SMB, do not `idf.py flash`. Node-RED 4.1.9 tarball-upload in the UI is buggy; this POST path is what we used successfully against 4.1.0.

## Details

[nodered_README.md](../../../docs/features/nodered_README.md)
