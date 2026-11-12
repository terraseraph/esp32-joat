# Hardware designer tool

What the tool in `hardware/` is for and how its files fit together. Setup and run steps are in [../README.md](../README.md).

## What it does
A local Vite app plus a Fastify API (127.0.0.1:3101) that renders tscircuit board designs, prices the BOM from jlcsearch, and exports a JLCPCB zip (Gerbers, drill, `bom.csv`, `cpl.csv`). It is a design tool only: nothing here runs on the ESP and no firmware, Node-RED or Manager code reads it.

## Layout
- `designs/<board>/index.tsx` + `board.json`: one board per folder. `board.json` carries name, description, revision and notes; put open electrical doubts in `notes`.
- `lib/*.tsx`: shared circuit blocks (`expansion-header`, `id-eeprom`, `relay-channel`, `srd-relay`, `screw-terminal`). Designs import them as `../../lib/<block>`. Change a block and every design using it changes.
- `app/` is the UI, `api/` the server (`bom.ts`, `build.ts`, `parts.ts`, `git.ts`).
- `docs/<feature>.md`: one hardware doc per firmware feature, same names as [docs/features](../../docs/features/), indexed in [docs/FEATURES_README.md](../../docs/FEATURES_README.md).

## When a design or block changes
1. For every feature the change affects, edit `hardware/docs/<feature>.md`: **Provided today** names the block or design, **Electrical limits** the numbers, **Gaps** what is still missing. Read the part from the design source, not from memory.
2. A new board that adds a bus, address, connector or pin use gets a line in each feature doc it touches (for example an I2C device in [bme280](bme280.md) or [modules](modules.md)).
3. If the board needs firmware support that does not exist (a module type, an EEPROM record format, a board profile), say so under **Gaps** in the hardware doc and in the firmware doc; if it is a real mismatch, add a line to [docs/lockstep-issues.md](../../docs/lockstep-issues.md).
4. Keep planned-but-undesigned things under **Gaps**, marked as planned. Do not describe them as provided.
5. Run `node tools/precheck.mjs`; it fails if a feature has no hardware doc.

## Click on the board, not the code
- **PCB tab** is an interactive view drawn from the circuit JSON (`app/src/PcbEdit.tsx`, model in `pcbModel.ts`); the stock tscircuit viewer stays on the **PCB (viewer)** tab. Click a part to select it, drag to move (snap 0.1/0.25/0.5/1 mm or off, remembered), arrow keys nudge, **R** rotates 90° (Shift+R back), Esc clears. Click a pad or trace to highlight its net in the PCB and the Schematic (click a schematic wire or part too); the side panel lists the pins on the net.
- **Properties panel** (right of the preview): name, value (resistance/capacitance/...), footprint, LCSC part, X/Y, rotation. Edits rewrite the JSX in memory (the Save button then writes it, the preview rebuilds). Parts made by a `lib/` block or a `.map()` loop, and props that are expressions, are read-only with a note saying why.
- **Code** button in the toolbar shows/hides the editor (hidden by default, remembered in localStorage `hw.codeOpen`).
- **Source rewrite module** `api/source-edit.ts` (TypeScript compiler AST, edits spliced into the original text so formatting is kept; a rename also updates `.NAME` selectors in strings). API, also for Claude:
  - `GET /api/designs/:name/components/source` lists elements with a literal `name` (their literal props, which props are expressions, whether they sit in a loop, line number). `POST` (same path) takes `{ files }` to include unsaved edits.
  - `PATCH /api/designs/:name/components/:component` with `{ props: { pcbX: 1.5, pcbRotation: 90, resistance: "10k", footprint: "0603", lcsc: "C123", schX: null } }` (`null` removes a prop; add `delta: { pcbX: 0.5, pcbRotation: 90 }` to move numeric literals relative to the current text, which is what the UI uses so rapid nudges never act on stale values; the response carries `warnings`, e.g. references left after a rename; `lcsc` maps to `supplierPartNumbers={{ jlcpcb: [...] }}`). Without `files` it writes the design file on disk; with `files` it only returns the patched text `{ file, content, written }`.
- Ports: the API reads `HW_API_PORT` (default 3101) and Vite `HW_APP_PORT` (default 5173), so several copies can run side by side.
