# Touch (Manager)

Firmware: [docs/features/touch.md](../../docs/features/touch.md) · Node-RED: [nodered/.../docs/touch.md](../../nodered/node-red-contrib-de-esp32/docs/touch.md) · Hardware: [hardware/docs/touch.md](../../hardware/docs/touch.md)

## What the Manager does with it
Types and the server link know touch; no screen shows or changes it. A touch pin is invisible on the Live tab and looks like a free pin on the Pins tab.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Pins → pin sheet | "Touch" flag | `/api/v1/hardware` `pins[].touch` | Display only (`PinSheet.tsx`). No `touch` mode in the mode list. |
| Live tab | none | `touch_<gpio>` | `live/model.ts` `tileFor` returns null for `mode: "touch"`. |
| Rules | none | rule source `level` | `ruleLogic.ts` `pinModes` skips `touch`, so it is not offered as a source. |

## Server side
- `server/src/types/device-api.ts`: `TouchState` (`id, mode:"touch", gpio, channel, level, raw, baseline, threshold_pct, sample_ms`), `PinMode` includes `"touch"`, `DeviceWsEvent` has `io/touch`, `IoMap` keys include `touch_N`, `HardwarePin.touch` / `touch_channel`.
- `server/src/device/link.ts` `topicForState`: `mode: "touch"` → `io/touch`, so touch states reach the browser in `live` / `io` messages.
- `GET /api/devices/:id/pin-config` (`server/src/api/devices.ts`) lists touch pins, but `configFromLive` has no `touch` case, so a live-derived config is only `{gpio, mode}` (drops non-default `threshold_pct` / `sample_ms`).
- Backups (`server/src/backups/deviceState.ts` `PIN_MODES`, `types/api-backups.ts` pin `mode` union): `touch` is not included. A backup silently leaves touch pins out.

## Fake device
`server/fake/` does not simulate touch: `applyPin` rejects `mode: "touch"` with `unknown mode`, `checkCapability` has no touch rule, `IO_KEY_PREFIXES` lacks `touch`, `setInput` and `fireRules` ignore touch. `state.ts` serialises the `touch` capability flag only.

## Code
`server/src/types/device-api.ts`, `server/src/device/link.ts`, `server/src/api/devices.ts`, `server/src/backups/deviceState.ts`, `web/src/routes/device/pins/pinLogic.ts`, `web/src/routes/device/pins/PinSheet.tsx`, `web/src/routes/device/live/model.ts`, `web/src/routes/device/rules/ruleLogic.ts`, `server/fake/commands.ts`

## Gaps
To support touch the Manager needs:
- `PinConfig` (`device-api.ts`): `threshold_pct?: number` (5-80, default 30); note `sample_ms` range for touch is 20-500 (the comment says ADC 20-1000).
- Pins tab (`pinLogic.ts`): `FormMode`/`MODE_ORDER`/`toFormMode` add `touch`; `allowedModes` offer it when `pin.touch && pin.touch_channel >= 0`; form fields `threshold_pct` and `sample_ms`; `parseOwner` map owner `touch_N` to `{kind:"own", mode:"touch"}` (today it returns `none`, so a touch pin shows as unconfigured and could be overwritten).
- Live tab (`model.ts`): a `touch` tile kind and group showing `level`, `raw`, `baseline`.
- Rules (`ruleLogic.ts`): `RuleMode` + `pinModes` + `isSourceMode` include `touch`, value 0/1.
- `configFromLive`: `opt("threshold_pct", 30); opt("sample_ms", 50)` for `touch`.
- Backups: add `touch` to `PIN_MODES`, `LivePin.mode` and the backup pin schema.
- Fake: accept `touch` on the 10 touch GPIOs, emit `io/touch` with `touch_N` state, let `setInput` drive `level`/`raw`, fire rules on it.
