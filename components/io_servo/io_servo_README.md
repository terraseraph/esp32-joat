# io_servo_README.md

## Purpose

Hobby-servo pulses on classic ESP32 **low-speed LEDC timer 0** at a fixed **50 Hz**. Eight channels, independent of [io_pwm_README.md](../io_pwm/io_pwm_README.md) (high-speed timer 0). Angle 0–180 maps to a pulse window (default 500–2500 µs).

## User story

Live control: configure a header pin as Servo, Apply a rest angle, then 0° / 90° / 180° from the UI or `pin.set`. PWM LEDs on other pins keep their own frequency.

## Public API

`io_servo_init()`, `io_servo_configure(gpio, angle, min_us, max_us, err, len)`, `io_servo_set(gpio, angle)`, `io_servo_get`, `io_servo_release`.

`pin.configure` mode `servo` with `angle` (0–180, default 90), `min_us` (500–1500, default 500), `max_us` (1500–2500, default 2500). `pin.set` `mode=servo` uses `value` as angle. Publishes `io/servo` `{id,mode,gpio,angle,pulse_us,min_us,max_us,hz}`.

Owner / state key: `servo_N`.

## Depends on

[capability_manager_README.md](../capability_manager/capability_manager_README.md) (`servo` same pins as `pwm`),
[resource_manager_README.md](../resource_manager/resource_manager_README.md),
[state_registry_README.md](../state_registry/state_registry_README.md),
[event_bus_README.md](../event_bus/event_bus_README.md).

## Used by

[command_router_README.md](../command_router/command_router_README.md), boot (`io_servo_init`).

## How to update and maintain

Do not put servos on the PWM high-speed timer — last PWM Hz would destroy the 20 ms frame. Keep max 8. Continuous-rotation servos still use this pulse window (1500 µs ≈ stop).

## How to test

`python test/test_capability_spec.py` (servo follows pwm pin rules). Hardware: GPIO 4 as servo, 0° vs 180°; a PWM pin at 1 kHz on GPIO 16 should be unaffected. Ninth servo → `no servo channel free`.

## Known limits

8 servos. 50 Hz only (not analog-feedback, not smart bus servos). Pulse resolution ~2.4 µs (13-bit). GPIO 34–39 cannot drive a servo.
