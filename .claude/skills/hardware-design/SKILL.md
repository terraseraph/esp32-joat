---
name: hardware-design
description: Change or inspect a board in the Joat Hardware designer (hardware/designs/*) with the hardware-designer MCP tools instead of editing TSX by hand. Use when asked to add, move, wire, swap or check parts on a board, build a design, run design-rule checks, cost a board, or prepare and record an order.
---

# Hardware design with the designer tools

Boards are tscircuit TSX in `hardware/designs/<name>/index.tsx`. Use the `hardware-designer` MCP tools for board work: they make small source edits, cost few tokens and are the same functions the in-app assistant calls (registry: `hardware/shared/tools.ts`). Edit TSX by hand only for what the tools cannot express.

The designer API must be running (`npm run dev` in `hardware/`, API on port 3101). If a tool reports a connection error, start it and retry.

## Rules
- Start with `list_components` and `list_nets`, not `read_design`. Read the full source only when a tool cannot answer.
- Edit tools write to the design at once and join a **run**. A snapshot is taken before the first edit. Do not call `accept_run`; the user keeps or rolls back the run. Call `rollback_run` only when asked, or to undo your own failed attempt.
- After any edit: `build_design` (quick), then `run_checks` (quick). Fix what your change caused. Stop after three fix rounds and report what still fails.
- `mode: "full"` autoroutes and can take minutes. Use it only when asked or before an order.
- Never invent part numbers, prices, stock or pinouts. `search_parts` results are candidates; say which datasheet checks remain.
- Shared blocks in `hardware/lib/` are used by several boards. Change them only through `propose_change`, and say which boards are affected.
- Do not try edits out on real boards. Duplicate a design first, or use `test-joat-base`.
- A feature change also needs the sister docs updated (`hardware/docs/designer.md`, "When a design or block changes").

## Recipes

**Add a part**
1. `list_palette {query}` to get the item id and its props (lib blocks are `lib:<Name>`).
2. For a catalogue part: `search_parts {query: "10k 0603"}`, pick a Basic or Preferred part with stock.
3. `add_part {name, item, props: {..., pcbX, pcbY, lcsc}}`. It returns the new reference name. Passing `lcsc` sets the JLC footprint.

**Wire it**
- Two pins on one net: `connect_pins {name, a: {ref, pin}, b: {ref, pin}, net}`.
- One pin to an existing net: `connect_pins {name, a, net}`. Disconnect: `set_pin_net {name, ref, pin, net: null}`.
- MCU pin: `gpio_map {name}` to find a free pin and its notes (strapping, USB, ADC2), then `assign_gpio {name, pin: "IO4", net}`.
- `rename_net {name, from, to}`; it refuses when the net is also used inside a lib block.

**Move or change a part**
- `patch_component {name, component, props: {pcbX, pcbY}}` for an absolute move, `delta: {pcbX: -2}` for a nudge, `delta: {pcbRotation: 90}` to rotate.
- Change a value: `props: {resistance: "4.7k"}`. Remove a prop: `props: {someProp: null}`.

**Build, check, fix**
1. `build_design {name}` returns errors, warnings and check counts.
2. `run_checks {name}` gives each issue with a title, why it matters and a fix.
3. Apply the fix with the edit tools, then repeat from step 1.
4. `get_snapshot {name, view: "pcb"}` when placement needs a look.

**Cost**
- `cost_summary {name, qty}` for the per-board estimate, `get_bom {name, qty}` for lines.
- `list_swaps {name, qty}` shows cheaper Basic or Preferred replacements; `apply_swap {name, from, to}` applies one. Check the datasheet before swapping.

**Undo**
- `run_status {name}` shows the open run and its edits. `rollback_run {name}` restores the snapshot taken before the run.
- `list_snapshots` / `restore_snapshot {name, id}` for older states. A restore backs up the current files first.

**Work the user queued in the app**
- `list_requests {name, status: "open"}`, do the work, and report against the request. Use `propose_change {name, summary, files, requestId}` when the answer is a whole-file change for review.

## Report
Say what changed (the run's edit list), the build result, the check counts before and after, and what still needs a human check (datasheet ratings, footprints, anything the quick build does not route).

**Prepare an order**
1. `order_preflight {name, qty}` runs a full build and returns the gates. Fix every `block` gate first; report `warn` gates.
2. `create_draft_order {name, qty, assembly, handFit}` saves the package (Gerber zip, `bom.csv`, `cpl.csv`, `order-options.txt`) and the labelled estimate. Nothing is sent anywhere.
3. The user uploads the package on the vendor's site and pays. Never place an order or enter payment or address details yourself.
4. When the user reports back: `update_order {name, id, vendor: {quotedTotal, orderNumber}, status}` and later `tracking`. Use only values the user gave.
5. `get_order` reporting `stale` means the design changed after the package was built: `refresh_order` before the user orders.
