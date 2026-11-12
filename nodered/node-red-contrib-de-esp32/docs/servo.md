# Servo (Node-RED)

Firmware: [docs/features/servo.md](../../../docs/features/servo.md) · Manager: [manager/docs/servo.md](../../../manager/docs/servo.md) · Hardware: [hardware/docs/servo.md](../../../hardware/docs/servo.md)

## What Node-RED does with it
`gpio out` with Mode `Servo` configures a servo on deploy and sends an angle for each message. The palette advertises it via `GET /de-esp32/palette` (`servo: true`). Transport is as in [gpio.md](gpio.md#commands-sent--events-used).

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| gpio out | `gpio` | `gpio` | Same pads as PWM. |
| gpio out | `pinMode` = `servo` | `mode` | |
| gpio out | `pinName` | `name` | Default `servo_<N>` (not `gpio_<N>`). |
| gpio out | `angle` | `angle` | Default 90, clamped 0-180 in `lib/servo.js` `servoPin`. |
| gpio out | `minUs` | `min_us` | Default 500, clamped 500-1500 ("Advanced"). |
| gpio out | `maxUs` | `max_us` | Default 2500, clamped 1500-2500. If `maxUs <= minUs`, both reset to 500/2500, as in the firmware. |
| gpio out | `source`, `configure` | - | As in [gpio.md](gpio.md#node-settings). |

## Messages
Input `msg.payload` (`lib/servo.js` `toAngle`): a number or numeric string, or `{value}` / `{angle}`. Clamped to 0-180 and rounded. Empty or not a number: error `Servo payload must be an angle 0–180`. No output.

## Commands sent / events used
| When | Command |
|---|---|
| Deploy (`configure`) | `{"cmd":"pin.configure","pin":{"gpio":19,"mode":"servo","name":"servo_19","angle":90,"min_us":500,"max_us":2500}}` |
| Each message | `{"cmd":"pin.set","gpio":19,"value":45,"mode":"servo"}` |

No `io/servo` events are used by any node.

## Code
- `nodes/de-esp32-gpio-out.js`, `nodes/de-esp32-gpio-out.html` (`#de-esp32-row-servo`)
- `lib/servo.js` (`toAngle`, `servoPin`), `lib/pins.js` (`ownerBlocks`, `ownerLabel`)

## Gaps
- No `delivery`. No node outputs `angle` / `pulse_us`.
- `lib/pins.js` treats a `servo_` owner as blocking every mode except `servo`; the firmware does not block this.
- Clamp ranges are copied from the firmware in `lib/servo.js`; change both together.
