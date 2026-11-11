# PWM (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/pwm.md) · [Manager](../../manager/docs/pwm.md)

## What it does
Drives a square wave on an output pin with a duty cycle given in permille (0-1000). Up to 8 pins. All PWM pins share one frequency.

## How it works on the ESP
- LEDC `LEDC_HIGH_SPEED_MODE`, timer `LEDC_TIMER_0`, 10-bit resolution, `LEDC_AUTO_CLK`. Classic ESP32 only (ESP32-C3 has no high-speed mode).
- 8 channels (high-speed channels 0-7), allocated first-free. Reconfiguring a pin keeps its channel.
- Every `pin.configure` in `pwm` mode re-runs `ledc_timer_config` for timer 0, so the last `hz` sent sets the frequency of every PWM pin. The other pins' stored state and saved config keep their old `hz` (not re-published), and at boot the last pin applied wins.
- Duty register = `duty * 1023 / 1000` (integer).
- Servos use a separate low-speed timer ([servo.md](servo.md)); PWM frequency changes do not affect them.
- Pin rules: same as `out` plus `PIN_PWM` (any output-capable pin; not 6-11, not 34-39). See [gpio.md](gpio.md#which-pins-are-allowed-capability_allows).
- Claimed in `resource_manager` as `pwm_N`. Release (`disabled` or another mode) calls `ledc_stop` with idle level 0.
- Known limit: if `ledc_timer_config` or `ledc_channel_config` fails, the allocated channel and the `pwm_N` claim are not released (`io_pwm_configure`).

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `gpio` | int | required | |
| `mode` | `pwm` | | |
| `hz` | int 50-20000 (clamped) | 1000 | Shared by all PWM pins. |
| `duty` | int 0-1000 (clamped) | 0 | Duty at configure and at boot. |
| `delivery` | `reliable` \| `latest` | `latest` | MQTT backpressure class. |

Saved in NVS namespace `io`, key `pins`, like every pin ([gpio.md](gpio.md#settings)). Unlike `in`/`servo`/`adc`, `hz` and `duty` are saved and echoed **as sent**, not clamped; the clamp happens in `io_pwm_configure`. Applied immediately and at boot (skipped in safe mode).

## Commands
```json
{"cmd":"pin.configure","pin":{"gpio":18,"mode":"pwm","hz":1000,"duty":250}}
```
Reply: `{"v":1,"ok":true,"result":{"gpio":18,"mode":"pwm","hz":1000,"duty":250}}` (the request pin, unclamped).

```json
{"cmd":"pin.set","gpio":18,"mode":"pwm","value":500}
```
`value` is the duty, clamped to 0-1000. Reply `{"result":{"gpio":18,"value":500}}` echoes the request value (unclamped). Not saved: the boot duty stays as configured.

Errors: capability errors; `gpio N owned by <owner>`; `no PWM channel free` (9th pin, `ESP_ERR_NO_MEM`); `ESP_ERR_INVALID_STATE` from `pin.set` when the pin is not in PWM mode; `mode` missing on `pin.set` sends it to GPIO and fails the same way.

## Events and state
State key `pwm_N`, topic `io/pwm`, published on configure and on every `pin.set`:
```json
{"id":"pwm_18","mode":"pwm","gpio":18,"hz":1000,"duty":500}
```
`hz` and `duty` here are the clamped values. Delivered like every io event: WS `/api/v1/ws` frame `{"topic":"io/pwm","data":{...}}`, MQTT `{root}/{topic_id}/io`, serial session, UDP sink; in `GET /api/v1/pins` and `status.io`; owner `pwm_N` in `GET /api/v1/hardware`. On-device rules can drive a PWM pin (`io_pwm_set`).

## Code
- `components/io_pwm/src/io_pwm.cpp`: `io_pwm_init`, `io_pwm_configure`, `io_pwm_set`, `io_pwm_get`, `io_pwm_release`, `publish`.
- `components/command_router/src/command_router.cpp`: `apply_one_pin` (`pwm` branch), `pin.set` dispatch.
- Hardware check: LED or scope on GPIO 4, duty 100 vs 900.
