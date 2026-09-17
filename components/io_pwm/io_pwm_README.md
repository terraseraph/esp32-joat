# io_pwm_README.md

## Purpose

LEDC high-speed timer 0, 10-bit duty, up to 8 channels. Duty is permille (0–1000). Independent of [io_servo_README.md](../io_servo/io_servo_README.md) (low-speed 50 Hz).

## User story

PWM output from Hardware tab / MQTT without a custom firmware.

## Public API

`io_pwm_configure(gpio, hz, duty)`, `io_pwm_set`, `io_pwm_get`, `io_pwm_release`.

`pin.configure` mode `pwm`; `pin.set` with `mode=pwm` uses `value` as duty. Publishes `io/pwm` on the event bus (WebSocket + MQTT `…/io` + serial session).

## Depends on

capability (`pwm` requires output), resource_manager, state_registry, event_bus.

## Used by

command_router.

## How to update and maintain

All channels share timer 0 frequency — last configure wins for Hz. Document that if you add per-channel timers. ESP32-C3 has no `LEDC_HIGH_SPEED_MODE`; this code is classic ESP32 only.

## How to test

Scope or LED on GPIO 4, duty 100 vs 900.

## Known limits

8 PWM channels. Frequency 50–20000 Hz. Servos must use `servo` mode — sharing this timer would change their 20 ms frame.
