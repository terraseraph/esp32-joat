# Touch (Node-RED)

Firmware: [docs/features/touch.md](../../../docs/features/touch.md) · Manager: [manager/docs/touch.md](../../../manager/docs/touch.md)

## What Node-RED does with it
Not used by Node-RED. No node can configure a touch pin or output its events. The only touch awareness is the pinout badge.

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| `de-esp32-device` (editor pinout) | badge `T<n>` | `/api/v1/hardware` `pins[].touch`, `pins[].touch_channel` | Display only (`nodes/de-esp32-device.html`, `lib/pins.js`). |
| fallback pinout | `touch`, `touch_channel` | same | `lib/devkitc-hardware.js`, matches `capability_manager.cpp`. |

## Messages
None. `lib/io.js` `parseIoMessage` does accept an `io/touch` frame (value = `data.level`), but `de-esp32-gpio-in` drops it: it only passes events whose `mode` is `in` or `adc` (`nodes/de-esp32-gpio-in.js` `onEv`).

## Commands sent / events used
None for touch. The device node's `io.hydrate` (on WS open / MQTT subscribe) makes the device re-send `io/touch` frames; they are parsed and ignored.

## Code
`nodes/de-esp32-gpio-in.js`, `nodes/de-esp32-gpio-in.html`, `nodes/de-esp32-device.html`, `lib/io.js`, `lib/pins.js`, `lib/devkitc-hardware.js`

## Gaps
To support touch, `de-esp32-gpio-in` would need:
- `pinMode` option `touch` (`nodes/de-esp32-gpio-in.html` select, `pinBody` in `.js`), sending `{"gpio":N,"mode":"touch","threshold_pct":..,"sample_ms":..,"name":..}`.
- New properties `thresholdPct` (5-80, default 30) and `sampleMs` (20-500, default 50) mapped to `threshold_pct` / `sample_ms`.
- Pin picker limited to `pins[].touch && touch_channel >= 0`.
- `onEv` filter to accept `ev.mode === "touch"`; `msg.payload` = `data.level` (already what `parseIoMessage` returns). Optionally pass `raw` / `baseline` in `msg.data` (already included) for tuning.
- "Configured pin" source list (`de-esp32-device.html`, input family filter `p.mode === "in" || p.mode === "adc"`) to include `touch`.
- Status text: `level` plus `raw/baseline`.

Risk today: picking a touch GPIO in `de-esp32-gpio-in` with "configure" on re-configures it as `in` and removes the touch setup.
