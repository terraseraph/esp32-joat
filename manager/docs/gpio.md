# GPIO (Manager)

Firmware: [docs/features/gpio.md](../../docs/features/gpio.md) · Node-RED: [nodered/.../docs/gpio.md](../../nodered/node-red-contrib-de-esp32/docs/gpio.md)

## What the Manager does with it
- **Pins & add-ons tab**: pinout + pin list from `GET /hardware`; the pin sheet sets a pin to Output / Input / Off and sends `pin.configure`.
- **Live tab**: Output tiles have a switch that sends `pin.set`; Input tiles show the level and debounce.
- **Backups**: pins are saved and re-applied with `pin.configure`.

The mode list mirrors `capability_allows` from the hardware flags (`pinLogic.ts` `allowedModes`): flash pins and pins owned by `mod_`/`bus_` offer nothing; `out` needs `output` and not `input_only`; `in` needs `input`.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Pin sheet | Mode Output / Input / Off | `mode` `out` / `in` / `disabled` | |
| Pin sheet (Output) | Start level at boot (Low/High) | `boot` | Sent only when 1. |
| Pin sheet (Output, Input) | Invert | `invert` | Sent only when true. |
| Pin sheet (Output, Input) | Pull-up / Pull-down | `pull_up` / `pull_down` | Hidden and never sent when the pin has no `pull` flag (34-39). |
| Pin sheet (Input) | Debounce | `debounce_ms` | 0-500, default 50; sent only when not 50. |
| Pin sheet (Input) | - | `irq` | Not editable; `irq:false` is kept on re-save (`form.keep.irq`). |
| Pin sheet | - | `delivery` | Not editable; kept on re-save (`form.keep.delivery`). |
| Pin sheet notes | Status LED / BOOT button | `status_led`, `boot_btn` flags | Warnings only. |
| Live tab (Output) | Switch | `pin.set` `value` 0/1 | No `mode` sent (firmware default `out`). |
| Live tab (Input) | High/Low, debounce | `level`, `debounce_ms` from `io/gpio` | |

## Server side
- Commands go through `POST /api/devices/:id/command` (or `v1/*` passthrough / browser WS `cmd`) to the device's `POST /api/v1/command`.
- **Pin shadow**: a successful `pin.configure` stores the pin object as sent per GPIO in the registry (`pinShadow`, `registry.ts` `setPinShadow`; `mode: "disabled"` deletes it). Set in `deviceCall.ts`.
- `GET /api/devices/:id/pin-config`: reads device `GET /pins`, uses the shadow when its `mode` matches, else `configFromLive` (live state has no `invert`/`pull_*`/`boot`/`irq`; drops `debounce_ms` 50).
- Live I/O: `device/link.ts` opens device WS `/api/v1/ws`, sends `io.hydrate` (`corr: "mgr-hydrate"`), forwards `io/gpio` frames to browsers as `{t:"io"}`; falls back to polling `GET /pins`.
- Backups: `backups/deviceState.ts` reads pins the same way; `planner.ts` `normalizePin` fills defaults (`invert`, `pull_up`, `pull_down` false, `boot` 0, `irq` true, `debounce_ms` 50) and sends `{"cmd":"pin.configure",...cfg}` with fields at the top level.
- Types: `server/src/types/device-api.ts` `PinConfig`, `GpioState`, `HardwarePin`, `PinSetCommand`.

## Fake device
`server/fake/commands.ts`:
- `checkCapability` mirrors the mode rules from the pin flags; the flags come from `node-red-contrib-de-esp32/lib/devkitc-hardware.js` (`state.ts` `BASE`).
- `applyPin` `out`/`in`: fills `pull_up`, `pull_down`, `invert`, `boot`, `irq` (default true), clamps `debounce_ms` 0-500 (50); initial `in` level = test input, else 1 with pull-up.
- `setPinValue` / `handlePinSet`: `ESP_ERR_INVALID_STATE` when the pin is not an output; `setInput` is the test hook for input edges.
Update these when firmware ranges, defaults or error strings change.

## Code
- `web/src/routes/device/pins/PinSheet.tsx`, `pinLogic.ts` (`RANGES`, `allowedModes`, `buildPinConfig`, `formFromConfig`), `Pinout.tsx`, `PinList.tsx`, `PinsSection.tsx`
- `web/src/routes/device/live/LiveTab.tsx`, `Tiles.tsx`, `model.ts` (`pinSetBody`, `adoptedState`)
- `server/src/api/devices.ts` (`configFromLive`, pin-config), `server/src/api/deviceCall.ts`, `server/src/store/registry.ts`, `server/src/device/link.ts`, `server/src/backups/planner.ts`, `server/src/backups/deviceState.ts`

## Gaps
- No `delivery` or `irq` editing.
- Pins whose shadow is missing show `invert`/pull/`boot` as defaults (the sheet says so); saving overwrites them.
- Fake device error strings differ from the firmware (for example fake `GPIO 34 cannot be used as output (input-only)` vs firmware `gpio is input-only`; fake `GPIO N is reserved for SPI flash` vs `gpio reserved for SPI flash`).
- Fake device does not reject `pull_up`/`pull_down` on input-only pins (firmware: `input-only pins have no internal pull`), and still emits `io/gpio` from `setInput` when `irq:false` (firmware sends nothing).
- Fake `pin.set` echoes the clamped value and requires a numeric `value`; firmware echoes the request and defaults `value` to 0.
- Fake `disabled` removes the saved pin; firmware saves a `{gpio, mode:"disabled"}` entry. `device-api.ts` says `disabled` returns just `{gpio, mode}`; firmware echoes the request pin.
- Web, fake and Node-RED block non-servo modes on a `servo_` owned pin; firmware allows it.
