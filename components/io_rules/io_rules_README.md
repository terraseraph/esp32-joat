# io_rules_README.md

## Purpose

On-device pin comparators so a standalone box can drive an output from an input without a host. One rule per source GPIO. Actions are `pin.set` equivalents (`io_gpio_set` / `io_pwm_set` / `io_servo_set`), not a flow editor.

## User story

GPIO / live control: on GPIO 32 (ADC), if millivolts `> 1000` then GPIO 18 HIGH, else LOW. Survives reboot. Runs with the UI closed.

## Public API

- `io_rules_init()`, `io_rules_apply_saved()`, `io_rules_set`, `io_rules_remove`, `io_rules_list_json()`
- Commands: `rule.set`, `rule.remove`, `rule.list`
- NVS blob `io` / `rules` (~2 KB JSON): `{v:1, rules:[{id,enabled,on:{gpio,op,value},then:{gpio,value},else?:{gpio,value}}]}`. Missing blob is empty. Schema 3.
- `on.op`: `gt` `ge` `lt` `le` `eq` `ne`. ADC compares `mv`; digital `in` compares `level` (0/1).
- Max 8 rules. `id` defaults to `r{src}`. Source GPIO is unique (upsert).

`RuntimeStatus::live_rules()` is set while any enabled rule’s source is ADC, so ADC sampling continues with no WebSocket/MQTT/serial sink.

## Depends on

[config_manager_README.md](../config_manager/config_manager_README.md),
[event_bus_README.md](../event_bus/event_bus_README.md),
[runtime_core_README.md](../runtime_core/runtime_core_README.md),
[state_registry_README.md](../state_registry/state_registry_README.md),
[io_gpio_README.md](../io_gpio/io_gpio_README.md),
[io_pwm_README.md](../io_pwm/io_pwm_README.md),
[io_servo_README.md](../io_servo/io_servo_README.md).

Does **not** depend on `command_router` (that calls in). Does not own pins — Hardware `pin.configure` still sets modes.

## Used by

[command_router_README.md](../command_router/command_router_README.md), boot (`command_apply_saved_rules`), Hardware tab (rule editor + pinout links).

## How to update and maintain

1. New actions still go through the IO drivers the command router uses. Do not call `command_dispatch` from the bus callback.
2. Evaluate on the `io_rules` task, not inside `event_bus_publish`.
3. Skip apply in safe mode (same as saved I/O).
4. Keep the Hardware editor as a thin `rule.set` / `rule.remove` client. Validation of dest mode (out / PWM / servo) belongs in the UI; firmware skips fire if the dest is not an output.

## How to test

Host: `python test/test_rule_spec.py`. Hardware: ADC on GPIO 32, output on GPIO 18, save the rule, close the browser, confirm 18 still follows the threshold after reboot.

## Known limits

No AND/OR, delays, or multi-dest then-lists. Dest must already be `out` / `pwm` / `servo` or the rule is inert. One rule per input pin. PWM then-value is 0–1000 duty, not HIGH/LOW.
