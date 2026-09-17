# serial_session_README.md

## Purpose

UART0 console plus an optional live I/O session. Compact NDJSON `{topic,data}` lines (same shape as WebSocket / MQTT `…/io`) only while a session is active. JSON command lines go through `command_dispatch`.

## User story

Live control without Wi-Fi: open the USB serial port, type `hello`, watch pin edges. `hydrate` asks for a full per-pin dump. `flash.ps1` still uses `name`.

## Public API

`serial_session_init()`, `serial_session_start()`.

REPL (non-JSON): existing boot commands plus `hello`, `bye`, `hydrate`.

JSON line starting with `{` → `command_dispatch`. `{"cmd":"serial.hello"}` starts the session and returns identity (no pin dump). `{"cmd":"io.hydrate"}` from this UART also starts the session, then re-emits each pin on the event bus. `{"cmd":"serial.bye"}` stops streaming.

Idle timeout 10 minutes with no RX/TX clears the session so ADC can sleep if MQTT and WebSocket are also down.

TX of I/O events is queued (do not block `gpio_irq`).

## Depends on

[command_router_README.md](../command_router/command_router_README.md),
[event_bus_README.md](../event_bus/event_bus_README.md),
[runtime_core_README.md](../runtime_core/runtime_core_README.md).

## Used by

[boot_state_machine_README.md](../../docs/features/boot_state_machine_README.md).

## How to update and maintain

Do not reclaim UART0 GPIO 1/3 while this is enabled. New console verbs: handle JSON via `command_router`, not a second command table. Keep `name` working for [flash_tool_README.md](../../docs/features/flash_tool_README.md).

## How to test

`hello` → one info JSON object, no pin dump. Toggle a GPIO input → one NDJSON line. `hydrate` → one line per configured pin. `{"cmd":"pin.set","gpio":4,"value":1}` → `events`-style result plus an `io/gpio` line if the pin is an output. `bye` stops the stream. Leave idle 10 minutes → `session/timeout`.

## Known limits

USB-UART cannot detect “monitor open”; DTR often resets the chip. Session is a handshake, not cable-detect. JSON on purpose (binary later if 115200 saturates). Mixed IDF log lines still share UART0.
