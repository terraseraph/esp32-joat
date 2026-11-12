# Rules (Manager)

Firmware: [docs/features/rules.md](../../docs/features/rules.md) · Node-RED: [nodered/.../docs/rules.md](../../nodered/node-red-contrib-de-esp32/docs/rules.md) · Hardware: [hardware/docs/rules.md](../../hardware/docs/rules.md)

## What the Manager does with it
Lists, adds, edits, enables/disables and deletes rules on the Pins tab (Rules section), shows rule hints on Live tiles, and saves/restores rules in backups.

## UI fields
Pins tab → Rules section (`RulesSection.tsx`) and Add/Edit rule sheet (`RuleSheet.tsx`, logic in `ruleLogic.ts`):

| Screen | Field | Maps to firmware field | Notes |
|---|---|---|---|
| Rule sheet | Source pin | `on.gpio` | Offers pins whose live mode is `in`, `adc` or `out` (`isSourceMode`). |
| Rule sheet | Is | `on.op` | Sends the word (`gt` ... `ne`); shows `> ≥ < ≤ = ≠`. |
| Rule sheet | Value (mV) / Level | `on.value` | ADC: 0-3300 (`ADC_MAX_MV`). Others: Low (0) / High (1). |
| Rule sheet | Destination pin + Set to / Duty (0-1000) / Angle (°) | `then.gpio`, `then.value` | Range per live mode (`destRange`). Non-output destination = warning only. |
| Rule sheet | Otherwise (checkbox) + pin + value | `else` | Omitted when unchecked. |
| Rule sheet | Rule ID | `id` | Max 7 (`MAX_RULE_ID`), no spaces, default `r<src>`; fixed when editing. |
| Rule sheet | Enabled | `enabled` | |
| Rules list | switch | `enabled` | `buildRuleToggle`: resends the whole rule with `rule.set`. |
| Rules list | slots bar | 8 max | `MAX_RULES`. |
| Live tab tiles | "Driven by rule ..." / triggers | `then.gpio` / `else.gpio` / `on.gpio` | `live/model.ts` `ruleHints`, enabled rules only. |

Client checks mirror the firmware: 8 rules, id ≤ 7, upsert by id then source, destination ≠ source.

## Server side
- All rule commands go through `POST /api/devices/:id/command` (`web/src/api/commands.ts` `useCommand`, `useDeviceCommandResult` for `rule.list`).
- Types: `Rule`, `RuleInput`, `RuleAction`, `RuleOp`, `RuleOpInput`, `RuleList`, `RuleSetCommand`, `RuleRemoveCommand`, `RuleListCommand` in `server/src/types/device-api.ts`. `DeviceSinks.rules` is typed `number | boolean`.
- Backups: `server/src/backups/deviceState.ts` reads `rule.list`; `snapshot.ts` stores `{id, enabled, on, then, else?}` (gap `rules_unavailable` when the device does not answer); `planner.ts` restores with `rule.remove` (rules not in the backup) first and `rule.set` last, and warns when a rule uses a pin the restore does not set up. Schema `BackupRuleSchema` in `types/api-backups.ts` (max 8).

## Fake device
`server/fake/commands.ts` (`handleRuleSet`, `handleRuleRemove`, `fireRules`), `state.ts` (`ruleList`, `sinks`). Differences from the firmware:
- `fireRules` uses `out` pins as sources and cascades through outputs (depth 4). The firmware ignores `out` sources.
- `fireRules` fires on every source event; the firmware fires only when the result changes.
- `rule.set` does not evaluate the new rule at once; the firmware does.
- `then` and `else` both require `gpio` and `value`; missing `op` is an error. Firmware: `else.gpio` defaults to `then.gpio`, values default to 0, `op` defaults to `gt`, top-level rule fields and `on.mv` are accepted.
- Error texts differ: `rule.then needs gpio and value`, `unknown op`, `too many rules (max 8)` vs firmware `then.gpio required`, `on.op must be gt/ge/lt/le/eq/ne`, `max 8 rules`.
- `sinks.rules` is the rule count; the firmware sends a bool (ADC source active).
- No touch source.

## Code
`web/src/routes/device/rules/ruleLogic.ts`, `RuleSheet.tsx`, `RulesSection.tsx`, `web/src/routes/device/pins/PinsTab.tsx`, `web/src/routes/device/live/model.ts`, `server/src/types/device-api.ts`, `server/src/backups/{deviceState,snapshot,planner,store}.ts`, `server/fake/commands.ts`, `server/fake/state.ts`

## Gaps
- `touch` sources: `RuleMode`, `pinModes` and `isSourceMode` skip `touch`, so a touch pin cannot be picked, and an existing touch-source rule fails validation on edit ("not an input, analog or output pin").
- Output pins are offered as sources, but the firmware never evaluates `out` events: such a rule is saved and never fires.
- `sinks.rules` is not shown anywhere.
