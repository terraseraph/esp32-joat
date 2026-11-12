# PWM (Manager)

Firmware: [docs/features/pwm.md](../../docs/features/pwm.md) · Node-RED: [nodered/.../docs/pwm.md](../../nodered/node-red-contrib-de-esp32/docs/pwm.md) · Hardware: [hardware/docs/pwm.md](../../hardware/docs/pwm.md)

## What the Manager does with it
- **Pins & add-ons tab**: the pin sheet sets a pin to PWM (needs `output`, `pwm`, not `input_only`) and sends `pin.configure`. A banner lists the other `pwm_` owned pins whose frequency changes with it (`otherPwmPins`).
- **Live tab**: PWM tiles show duty and Hz, with a 0-100 % slider that sends `pin.set`.
- **Backups**: saved and re-applied with `pin.configure`.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Pin sheet | Mode PWM | `mode` `pwm` | |
| Pin sheet | Duty (%) | `duty` = percent × 10 | 0-100, one decimal; sent only when not 0. |
| Pin sheet | Frequency (shared by all PWM pins) | `hz` | 50-20000, default 1000; sent only when not 1000. |
| Live tab | Duty slider (0-100 %, step 1) | `pin.set` `mode:"pwm"`, `value` = percent × 10 | |
| Live tab, pin list | `duty {n} / 1000 · {hz} Hz`, `{n} % · {hz} Hz` | `duty`, `hz` from `io/pwm` | |

## Server side
- `pin.configure` / `pin.set` as in [gpio.md](gpio.md#server-side); pin shadow stores what was sent.
- `configFromLive` (pwm): keeps `hz` when not 1000 and `duty` when not 0. The live `duty` is the last `pin.set` value, so a re-sent config adopts it as the boot duty.
- `planner.ts` `normalizePin`: `hz` 1000, `duty` 0 defaults; summary `PWM output (<hz> Hz, duty <duty>)`.
- Types: `PinConfig.hz`, `PinConfig.duty`, `PwmState` in `server/src/types/device-api.ts`.

## Fake device
`server/fake/commands.ts` `applyPin` (pwm): clamps `hz` 50-20000 (1000) and `duty` 0-1000 (0), state `{id:"pwm_N", mode:"pwm", gpio, hz, duty}`. `setPinValue` clamps duty 0-1000 and emits `io/pwm`. Demo seed: GPIO 18, 1000 Hz, duty 250 (`state.ts` `DEMO_SEED`).

## Code
- `web/src/routes/device/pins/PinSheet.tsx`, `pinLogic.ts` (`RANGES.hz`, `RANGES.dutyPct`, `buildPinConfig`, `otherPwmPins`, `liveValueText`)
- `web/src/routes/device/live/Tiles.tsx`, `model.ts` (`dutyToPercent`, `percentToDuty`, `pinSetBody`)
- `server/src/api/devices.ts`, `server/src/backups/planner.ts`, `server/fake/commands.ts`

## Gaps
- No `delivery` editing.
- Fake device has no 8-channel limit (firmware: `no PWM channel free`) and does not make other PWM pins follow a new `hz` (firmware shares one timer; their `io/pwm` state is not re-published by the firmware either).
- Fake echoes clamped `hz`/`duty` in the `pin.configure` result; firmware echoes the values as sent (it clamps only in hardware and in the `io/pwm` state).
