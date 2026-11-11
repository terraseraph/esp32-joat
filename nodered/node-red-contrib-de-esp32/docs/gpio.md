# GPIO (Node-RED)

Firmware: [docs/features/gpio.md](../../../docs/features/gpio.md) · Manager: [manager/docs/gpio.md](../../../manager/docs/gpio.md)

## What Node-RED does with it
`gpio in` (Mode `In`) listens to a digital input; `gpio out` (Mode `Out`) drives a digital output. Both use the `de-esp32-device` config node for transport. The editor's pad picker reads `GET /api/v1/hardware` (or the DevKitC fallback in `lib/devkitc-hardware.js`) to decide which pads are selectable.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| both | `gpio` | `gpio` | |
| both | `pinMode` | `mode` | `in` (gpio in) / `out` (gpio out). |
| both | `pinName` | `name` | Default `gpio_<N>`. Firmware ignores it but saves it in NVS with the pin. |
| both | `source` | - | `pad` = pick a pad and configure; `configured` = use a pin from `GET /api/v1/pins`, never sends `pin.configure`. |
| both | `configure` | - | "Configure pin on deploy". Forced off when `source` is `configured`. |
| both | `invert` | `invert` | |
| both | `pullUp` | `pull_up` | Row hidden when the pin has no `pull` flag. |
| gpio in | `debounceMs` | `debounce_ms` | Default 50; editor 0-500; not clamped by the node (firmware clamps). |
| gpio in | - | `irq` | Always sent as `true`. |
| gpio out | `boot` | `boot` | 0/1, "Power-on" Low/High. |

## Messages
gpio out, input `msg.payload` (`lib/level.js` `toLevel`): `true`/`false`, `"on"`/`"off"`/`"ON"`/`"OFF"`, `"true"`/`"false"`, numbers or numeric strings (non-zero = 1), or an object with `payload` or `value`. Anything else: error `payload must be 0/1, true/false, on/off`.

gpio in, output on every `io/gpio` event for its GPIO with `data.mode` `in`:
```json
{"payload":1,"gpio":27,"mode":"in","topic":"gpio_27","data":{"id":"gpio_27","mode":"in","gpio":27,"level":1,"debounce_ms":50}}
```
`payload` is `data.level` (`lib/io.js` `parseIoMessage`).

## Commands sent / events used
| When | Command |
|---|---|
| Deploy (gpio in, `configure`) | `{"cmd":"pin.configure","pin":{"gpio":27,"mode":"in","name":"gpio_27","irq":true,"debounce_ms":50,"pull_up":false,"invert":false}}` |
| Deploy (gpio out, `configure`) | `{"cmd":"pin.configure","pin":{"gpio":4,"mode":"out","name":"gpio_4","pull_up":false,"invert":false,"boot":0}}` |
| Each message (gpio out) | `{"cmd":"pin.set","gpio":4,"value":1,"mode":"out"}` |
| Live link opens | `{"cmd":"io.hydrate"}` |

Transport (`nodes/de-esp32-device.js`): with an MQTT broker attached, commands go to `{mqttRoot}/{topicId or deviceId}/system/command` (firmware `{root}/{topic_id}`) (QoS 1) and the node gets `{ok:true, via:"mqtt"}` back at once; otherwise `POST /api/v1/command`. Live events come from MQTT `{prefix}/io` or WebSocket `/api/v1/ws`, both `{topic, data}` frames.

## Code
- `nodes/de-esp32-gpio-in.js`, `nodes/de-esp32-gpio-in.html` (`pinBody`)
- `nodes/de-esp32-gpio-out.js`, `nodes/de-esp32-gpio-out.html` (`pinBody`)
- `nodes/de-esp32-device.js` (`command`, `subscribeGpio`, `_dispatchIo`), `nodes/de-esp32-device.html` (`bindGpioEditor`)
- `lib/io.js`, `lib/level.js`, `lib/pins.js` (`padAllowed`, `allowedModes`, `ownerBlocks`), `lib/devkitc-hardware.js`

## Gaps
- No `pull_down`, no `irq:false`, no `delivery`.
- Over MQTT, `pin.configure` / `pin.set` errors (for example `input-only pins have no internal pull`, `gpio N owned by ...`) are never seen: the reply is not awaited.
- Hiding the pull-up row does not clear `pullUp`; a node moved to GPIO 34-39 with `pullUp` still set sends `pull_up:true` and the firmware rejects it.
- `lib/pins.js` blocks non-servo modes on a `servo_` owned pin; the firmware allows it (it releases the servo first).
- `lib/devkitc-hardware.js` copies the firmware pin table by hand; it must match `capability_manager.cpp` (it does today). The Manager fake device imports it too.
