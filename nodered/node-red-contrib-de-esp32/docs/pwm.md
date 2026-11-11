# PWM (Node-RED)

Firmware: [docs/features/pwm.md](../../../docs/features/pwm.md) · Manager: [manager/docs/pwm.md](../../../manager/docs/pwm.md)

## What Node-RED does with it
`gpio out` with Mode `PWM` configures a PWM pin on deploy and sends the duty for each message. `gpio in` does not offer PWM. Transport is as in [gpio.md](gpio.md#commands-sent--events-used).

## Node settings
| Node | Property | Maps to firmware field | Notes |
|---|---|---|---|
| gpio out | `gpio` | `gpio` | Pads need `pwm` and not `input_only` (`lib/pins.js` `padAllowed`). |
| gpio out | `pinMode` = `pwm` | `mode` | |
| gpio out | `pinName` | `name` | Default `gpio_<N>`; saved by the firmware, otherwise unused. |
| gpio out | `duty` | `duty` | Default 0; editor 0-1000. Sent as entered (firmware clamps). |
| gpio out | `hz` | `hz` | Default 1000; editor 50-20000. Sent as entered (firmware clamps). Editor hint says all PWM pins share it. |
| gpio out | `source`, `configure` | - | As in [gpio.md](gpio.md#node-settings). |

## Messages
Input `msg.payload`: a number, or `{value: n}`. Clamped to 0-1000 and rounded in the node. Not a number: error `PWM payload must be 0–1000`. No output.

## Commands sent / events used
| When | Command |
|---|---|
| Deploy (`configure`) | `{"cmd":"pin.configure","pin":{"gpio":18,"mode":"pwm","name":"gpio_18","duty":0,"hz":1000}}` |
| Each message | `{"cmd":"pin.set","gpio":18,"value":500,"mode":"pwm"}` |

No `io/pwm` events are used by any node (`lib/io.js` would map them to `payload = duty`, but `gpio in` only listens for `in`/`adc`).

## Code
- `nodes/de-esp32-gpio-out.js` (`pinBody`, input handler), `nodes/de-esp32-gpio-out.html` (`#de-esp32-row-pwm`)
- `lib/pins.js`, `lib/io.js`

## Gaps
- No `delivery`.
- No node outputs live PWM state.
- Over MQTT, `no PWM channel free` and other errors are not seen (reply not awaited).
