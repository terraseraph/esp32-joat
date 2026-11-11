# Rules (firmware)

Sister docs: [Node-RED](../../nodered/node-red-contrib-de-esp32/docs/rules.md) · [Manager](../../manager/docs/rules.md)

## What it does
On-device if-this-then-that for pins, so a box drives an output from an input with no host connected. Example: if GPIO 32 (ADC) is above 1000 mV then GPIO 18 = 1, else GPIO 18 = 0. Rules are saved and run after reboot.

## How it works on the ESP
- `io_rules` subscribes to every `io/` bus event and queues `{gpio, mode, value}` (queue of 16, dropped when full). The `io_rules` task (stack 3072, prio 4) evaluates them, never inside `event_bus_publish`.
- Source value: `mv` for `adc`, `level` (0/1) for `in` and `touch`. Events from any other mode (`out`, `pwm`, `servo`, modules) are ignored, so an output pin can never be a source.
- A rule fires only when its result changes (then → else or else → then). The last result resets on `rule.set` and on boot. If the action fails (destination is not an output) the result is not stored, so the next event tries again.
- Action = what the destination pin is right now (read from state_registry):

| Destination mode | Effect | Value |
|---|---|---|
| `out` | `io_gpio_set` | non-zero → 1 |
| `pwm` | `io_pwm_set` | clamped 0-1000 (duty) |
| `servo` | `io_servo_set` | clamped 0-180 (angle) |
| anything else / unset | nothing, warning log `rule dest GPIO n is not an output` | |

- Rules do not own pins. Pin modes still come from `pin.configure`.
- Rules are evaluated right away from current state on `rule.set`, after saved rules load at boot, and after every `pin.configure` (`io_rules_on_io_change`).
- `RuntimeStatus::live_rules()` is true while an enabled rule has an ADC source, so ADC sampling keeps running with no WS/MQTT/serial/UDP sink. Touch and `in` sources do not need it.
- Boot: `command_apply_saved_rules` runs after saved pins and modules; skipped in safe mode.
- Limits: max 8 rules; one rule per source GPIO; one `then` and one optional `else` destination; no AND/OR, no delays.

## Settings
Rule object (`load_one` in `io_rules.cpp`):

| Field | Type / range | Default | Notes |
|---|---|---|---|
| `id` | string, max 7 chars (longer is cut) | `r<on.gpio>` | Upsert key. |
| `enabled` | bool | true | |
| `on.gpio` | 0-39 | required | Source pin. Also read from top-level `gpio` when `on` is missing. |
| `on.op` | `gt` `ge` `lt` `le` `eq` `ne`, or `>` `>=` `<` `<=` `==` `!=` | `gt` | Stored and listed as the word. |
| `on.value` | int | 0 | mV for ADC, 0/1 for `in`/`touch`. `on.mv` is accepted as an alias. |
| `then.gpio` | 0-39, not `on.gpio` | required | |
| `then.value` | int | 0 | |
| `else` | object, optional | none | `else.gpio` defaults to `then.gpio`, `else.value` to 0. Must differ from `on.gpio`. |

Saved in NVS namespace `io`, key `rules`, JSON blob up to 2048 bytes: `{"v":1,"rules":[...]}`. Written on every `rule.set` / `rule.remove`; applied immediately. A saved rule that fails validation is skipped at boot with a warning.

## Commands
Upsert (match by `id` first, then by source GPIO; the rule can also be sent at top level without `rule`):
```json
{"cmd":"rule.set","rule":{"on":{"gpio":32,"op":"gt","value":1000},"then":{"gpio":18,"value":1},"else":{"gpio":18,"value":0}}}
```
Remove by `id`, or by source `gpio` when `id` is empty or unknown:
```json
{"cmd":"rule.remove","gpio":32}
```
```json
{"cmd":"rule.list"}
```
All three return the full list:
```json
{"v":1,"ok":true,"result":{"v":1,"rules":[{"id":"r32","enabled":true,"on":{"gpio":32,"op":"gt","value":1000},"then":{"gpio":18,"value":1},"else":{"gpio":18,"value":0}}]}}
```
Errors: `on.gpio required`, `on.op must be gt/ge/lt/le/eq/ne`, `then.gpio required`, `then.gpio must differ from on.gpio`, `else.gpio must differ from on.gpio`, `max 8 rules`, `persist failed`, `rule not found`.

A rule whose destination is not an output is accepted (inert).

## Events and state
- No event of its own. Its actions show up as normal `io/gpio`, `io/pwm`, `io/servo` events on WS, MQTT `<root>/<topic_id>/io`, serial and UDP.
- `GET /api/v1/status` `sinks.rules`: bool, true while an enabled rule has an ADC source.
- `rule.list` is the only way to read rules (no REST route).

## Code
- `components/io_rules/src/io_rules.cpp`: `io_rules_init`, `io_rules_apply_saved`, `io_rules_set`, `io_rules_remove`, `io_rules_list_json`, `io_rules_on_io_change`, `evaluate`, `fire`, `refresh_live_sink`.
- `components/command_router/src/command_router.cpp`: `rule.*` dispatch, `command_apply_saved_rules`.
- Host test: `test/test_rule_spec.py`. Embedded UI rule editor: `web/source/index.html`.
