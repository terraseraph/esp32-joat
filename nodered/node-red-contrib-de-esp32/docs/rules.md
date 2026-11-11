# Rules (Node-RED)

Firmware: [docs/features/rules.md](../../../docs/features/rules.md) · Manager: [manager/docs/rules.md](../../../manager/docs/rules.md)

## What Node-RED does with it
Not used by Node-RED. No node sends `rule.set`, `rule.remove` or `rule.list`. Flows that need logic do it in Node-RED itself.

## Node settings
None.

## Messages
None. A pin driven by an on-device rule still produces normal `io/gpio` / `io/pwm` / `io/servo` events, so `de-esp32-gpio-in` on that pin sees the rule's changes.

## Commands sent / events used
None. `de-esp32-gpio-out` can send `pin.set` to a pin a rule also drives; the next rule result change overwrites it.

## Code
None.

## Gaps
- No rule node. A minimal one would send `{"cmd":"rule.set","rule":{id,enabled,on:{gpio,op,value},then:{gpio,value},else?}}` on deploy and `rule.remove` by `id` on delete, using `node.device.command` (`nodes/de-esp32-device.js`).
- Caveat for such a node: over MQTT `command` returns `{ok:true, via:"mqtt"}` without the device reply, so validation errors (`then.gpio required`, `max 8 rules`) would only show with HTTP.
- No warning in the editor when a gpio-out node targets a pin that a rule drives.
