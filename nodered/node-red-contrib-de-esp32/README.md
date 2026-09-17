# node-red-contrib-de-esp32

Node-RED palette for [de-esp32](https://github.com) GPIO boxes. Lives in the firmware repo as a **sibling npm package** — it is not compiled into the ESP image.

Speaks REST `/api/v1` (`command_router`). Live GPIO uses MQTT `{prefix}/io` when an `mqtt-broker` is attached, otherwise WebSocket `/api/v1/ws`.

## Install (dev)

From this folder:

```powershell
npm install
npm link
```

In your Node-RED user directory (often `~/.node-red` or `%USERPROFILE%\.node-red`):

```powershell
npm link node-red-contrib-de-esp32
```

Restart Node-RED. Palette category **de-esp32**: config node, gpio in, gpio out.

Push a packed tarball into a live editor on the LAN (installs under `~/.node-red/node_modules` on that host):

```powershell
.\tools\nodered_push.cmd
.\tools\nodered_push.ps1 -HostName 192.168.0.132
```

Then refresh the Node-RED browser tab. Not published to npm in v0.1.

## Use

1. Add **de-esp32 device**. Paste the board IP, or **Scan**. Optional: select a Node-RED MQTT broker (must be deployed) and MQTT root (`devices`).
2. **Save name on device** runs `identity.set_name`. MAC `id` is stable; MQTT topics follow the name.
3. Add **gpio out** / **gpio in**, pick that device, click a pad on the header. Power/GND/EN and flash/input-only pads are not selectable for outputs.

Do not drop one GPIO node per pin unless you need them. Discover boards; wire the pads you use.

## Commands

Same JSON as the web UI:

- `{"cmd":"pin.configure","pin":{"gpio":4,"mode":"out"}}`
- `{"cmd":"pin.set","gpio":4,"value":1}`
- `{"cmd":"identity.set_name","name":"kitchen-relay"}`

gpio-out maps `msg.payload` `true`/`false`, `"on"`/`"off"`, `1`/`0`.

## Tests

```powershell
npm test
```

Host-only. Hardware checks need a board on the LAN.
