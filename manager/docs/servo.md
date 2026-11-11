# Servo (Manager)

Firmware: [docs/features/servo.md](../../docs/features/servo.md) · Node-RED: [nodered/.../docs/servo.md](../../nodered/node-red-contrib-de-esp32/docs/servo.md)

## What the Manager does with it
- **Pins & add-ons tab**: the pin sheet sets a pin to Servo (same pins as PWM) and sends `pin.configure`. On a `servo_` owned pin every other mode is disabled with the hint "This pin is a servo. Turn it Off first to use another mode."
- **Live tab**: Servo tiles show the angle with a 0-180° slider that sends `pin.set`.
- **Backups**: saved and re-applied with `pin.configure`.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Pin sheet | Mode Servo | `mode` `servo` | Pad text `SRV`. |
| Pin sheet | Start angle | `angle` | 0-180, default 90; sent only when not 90. |
| Pin sheet | Min pulse | `min_us` | 500-1500, default 500; sent only when not 500. |
| Pin sheet | Max pulse | `max_us` | 1500-2500, default 2500; sent only when not 2500. |
| Live tab | Angle slider (0-180, step 1) | `pin.set` `mode:"servo"`, `value` | |
| Live tab | angle, pulse | `angle`, `pulse_us` from `io/servo` | After `pin.set` the tile shows `adoptedState`'s rounded pulse until the device frame arrives (firmware truncates). |

## Server side
- `pin.configure` / `pin.set` as in [gpio.md](gpio.md#server-side); pin shadow stores what was sent.
- `configFromLive` (servo): keeps `angle` (not 90), `min_us` (not 500), `max_us` (not 2500). Live `angle` is the last `pin.set`, so a re-sent config adopts it as the rest angle.
- `planner.ts` `normalizePin`: `angle` 90, `min_us` 500, `max_us` 2500; summary `servo (angle <n>)`.
- Types: `PinConfig.angle/min_us/max_us`, `ServoState` in `server/src/types/device-api.ts`.

## Fake device
`server/fake/commands.ts` `applyPin` (servo): clamps `angle` 0-180 (90), `min_us` 500-1500, `max_us` 1500-2500; `servoPulse` = rounded `min + (max-min)*angle/180`; state includes `hz: 50`. `setPinValue` clamps angle and recomputes `pulse_us`. Refuses non-servo modes on a `servo_` owner. Demo seed: GPIO 19, angle 90.

## Code
- `web/src/routes/device/pins/PinSheet.tsx`, `pinLogic.ts` (`RANGES.angle/min_us/max_us`, `allowedModes`, `buildPinConfig`)
- `web/src/routes/device/live/Tiles.tsx`, `model.ts` (`adoptedState`, `pinSetBody`)
- `server/src/api/devices.ts`, `server/src/backups/planner.ts`, `server/fake/commands.ts`

## Gaps
- `max_us <= min_us` is not validated: the firmware silently resets both to 500/2500, but the shadow keeps the sent values and the pin sheet shows them.
- Fake device does not apply that reset either, and has no 8-servo limit (firmware: `no servo channel free (max 8)`).
- The `servo_` owner lock (web `allowedModes`, fake `applyPin`) is not in the firmware: `pin.configure` releases the servo and applies the new mode.
- No `delivery` editing.
