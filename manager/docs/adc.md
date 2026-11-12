# ADC (Manager)

Firmware: [docs/features/adc.md](../../docs/features/adc.md) · Node-RED: [nodered/.../docs/adc.md](../../nodered/node-red-contrib-de-esp32/docs/adc.md) · Hardware: [hardware/docs/adc.md](../../hardware/docs/adc.md)

## What the Manager does with it
- **Pins & add-ons tab**: the pin sheet sets an ADC1 pin to Analog and sends `pin.configure`. ADC2 pins show Analog disabled with "ADC2 cannot be used while Wi-Fi is on" (`ADC2_HINT`).
- **Live tab**: Analog tiles show volts, `raw` and mV, and a 0-3.3 V bar (`MAX_MV` 3300).
- **Backups**: saved and re-applied with `pin.configure`.

## UI fields
| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Pin sheet | Mode Analog | `mode` `adc` | Offered when `adc1`; disabled when `adc2`. |
| Pin sheet | Sample every | `sample_ms` | 20-1000, default 50; sent only when not 50. |
| Pin sheet | Hysteresis | `hysteresis_mv` | 5-500, default 20; sent only when not 20. |
| Pin sheet | Smoothing | `smooth` | 0-90 %, default 70; sent only when not 70. |
| Live tab | Volts, `raw {raw} · {mv} mV`, bar | `mv`, `raw` from `io/adc` | Volts = `mv / 1000`. |
| Pin list | `{mv} mV` | `mv` | |

## Server side
- `pin.configure` as in [gpio.md](gpio.md#server-side); pin shadow stores what was sent.
- `configFromLive` (adc): keeps `sample_ms` (not 50), `hysteresis_mv` (not 20), `smooth` (not 70).
- `planner.ts` `normalizePin`: same defaults; summary `analog input`.
- The Manager's device WebSocket counts as a live sink, so the device samples while the Manager is linked.
- Types: `PinConfig.sample_ms/hysteresis_mv/smooth`, `AdcState` in `server/src/types/device-api.ts`.

## Fake device
`server/fake/commands.ts` `applyPin` (adc): clamps `sample_ms` 20-1000 (50), `hysteresis_mv` 5-500 (20), `smooth` 0-90 (70). `mv` comes from the test input (`setInput`), `raw = round(mv / 3300 * 4095)`. `setInput` emits `io/adc` only when the move is `>= hysteresis_mv` vs the current value. No sampling, smoothing or `live_sinks` gating. Demo seed: GPIO 32 at 1650 mV.

## Code
- `web/src/routes/device/pins/PinSheet.tsx`, `pinLogic.ts` (`RANGES.sample_ms/hysteresis_mv/smooth`, `ADC2_HINT`, `allowedModes`)
- `web/src/routes/device/live/Tiles.tsx`, `model.ts` (`MAX_MV`, `mvToVolts`, `mvFraction`)
- `server/src/api/devices.ts`, `server/src/backups/planner.ts`, `server/fake/commands.ts`

## Gaps
- No `delivery` editing.
- If the device has no ADC calibration, `mv` is raw counts and the tile shows it as millivolts.
- Fake `setInput` compares to the last value, not the last sent value, so slow drift below the threshold never reports (firmware does report it).
