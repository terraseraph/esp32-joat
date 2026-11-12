# Servo (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/servo.md) · [Manager](../../manager/docs/servo.md) · [Hardware](../../hardware/docs/servo.md)

## What it does
Drives hobby servos with 50 Hz pulses. An angle 0-180 maps linearly onto a pulse window (default 500-2500 µs). Up to 8 servos, independent of [PWM](pwm.md).

## How it works on the ESP
- LEDC `LEDC_LOW_SPEED_MODE`, timer `LEDC_TIMER_0`, 13-bit (`kDutyMax` 8191), fixed 50 Hz (20 000 µs frame). The timer is configured once, on the first servo (`ensure_timer`).
- 8 channels (low-speed 0-7), allocated first-free; reconfiguring keeps the channel.
- `pulse_us = min_us + angle * (max_us - min_us) / 180` (integer). Duty = `pulse_us * 8191 / 20000`. Resolution about 2.4 µs.
- PWM uses the high-speed timer, so changing PWM `hz` does not touch the servo frame. Do not move servos onto the PWM timer.
- Continuous-rotation servos use the same window (about 1500 µs = stop). Not for analog-feedback or bus servos.
- Pin rules: same as `pwm` (any output-capable pin; not 6-11, not 34-39). See [gpio.md](gpio.md#which-pins-are-allowed-capability_allows).
- Claimed in `resource_manager` as `servo_N` (also the state key). Release (`disabled` or another mode) calls `ledc_stop` with idle level 0. The firmware does not block changing a servo pin to another mode.
- `io_servo_init()` runs at boot.

## Settings
| Field | Type / range | Default | Notes |
|---|---|---|---|
| `gpio` | int | required | |
| `mode` | `servo` | | |
| `angle` | int 0-180 (clamped) | 90 | Rest angle at configure and at boot. |
| `min_us` | int 500-1500 (clamped) | 500 | Pulse at 0°. |
| `max_us` | int 1500-2500 (clamped) | 2500 | Pulse at 180°. If `max_us <= min_us` after clamping, both reset to 500/2500. |
| `delivery` | `reliable` \| `latest` | `latest` | MQTT backpressure class. |

Clamped values are written back into the pin object before it is saved and echoed. Saved in NVS namespace `io`, key `pins` ([gpio.md](gpio.md#settings)). Applied immediately and at boot (skipped in safe mode).

## Commands
```json
{"cmd":"pin.configure","pin":{"gpio":19,"mode":"servo","angle":90,"min_us":500,"max_us":2500}}
```
Reply: the pin with clamped `angle`, `min_us`, `max_us`.

```json
{"cmd":"pin.set","gpio":19,"mode":"servo","value":180}
```
`value` is the angle, clamped to 0-180. Reply `{"result":{"gpio":19,"value":180}}` echoes the request value (unclamped). Not saved: the rest angle stays as configured.

Errors: capability errors; `gpio N owned by <owner>`; `no servo channel free (max 8)`; `servo timer <esp_err>`; `servo channel <esp_err>`; `ESP_ERR_INVALID_STATE` from `pin.set` when the pin is not a servo (or `mode` is missing).

## Events and state
State key `servo_N`, topic `io/servo`, published on configure and every `pin.set`:
```json
{"id":"servo_19","mode":"servo","gpio":19,"angle":180,"pulse_us":2500,"min_us":500,"max_us":2500,"hz":50}
```
Delivered like every io event: WS `/api/v1/ws` frame `{"topic":"io/servo","data":{...}}`, MQTT `{root}/{topic_id}/io`, serial session, UDP sink; in `GET /api/v1/pins` and `status.io`; owner `servo_N` in `GET /api/v1/hardware`. On-device rules can drive a servo (`io_servo_set`).

## Code
- `components/io_servo/src/io_servo.cpp`: `io_servo_init`, `io_servo_configure`, `io_servo_set`, `io_servo_get`, `io_servo_release`, `pulse_from_angle`, `duty_from_pulse`, `ensure_timer`.
- `components/command_router/src/command_router.cpp`: `apply_one_pin` (`servo` branch), `pin.set` dispatch.
- Test: `python test/test_capability_spec.py` (servo follows pwm pin rules). Hardware: servo on GPIO 4 at 0° vs 180° while a 1 kHz PWM on GPIO 16 stays unaffected; a 9th servo gives `no servo channel free`.
