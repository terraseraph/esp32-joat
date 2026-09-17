# io_gpio_README.md

## Purpose

Digital input/output with optional invert, pulls, and software-debounced ANYEDGE IRQs. Debounce is per pin (`debounce_ms`, default 50, 0–500) for inputs. Boot does **not** drive outputs until config apply.

## User story

GPIO / live control: configure an output, toggle from UI or MQTT; input edges update state.

## Public API

`io_gpio_configure`, `io_gpio_set`, `io_gpio_get`, `io_gpio_release`, `io_gpio_safe_defaults`.

Commands: `pin.configure` mode `in`/`out`, `pin.set`. Inputs accept `debounce_ms` (default 50). Outputs publish immediately (no debounce).

Each level change publishes one `io/gpio` event (state_registry + event bus).

## Depends on

capability, resource, event_bus, state_registry.

## Used by

command_router, boot (safe defaults).

## How to update and maintain

Keep ISR tiny (queue only). Debounce is software. Input-only pins (34–39) must not enable internal pulls — capability + extra check.

## How to test

Loopback: out GPIO 4 to in GPIO 16. MQTT `{"cmd":"pin.set","gpio":4,"value":1}`.

## Known limits

GPIO 0 is the BOOT button; using it as a user input fights recovery. GPIO 2 is the status LED.
