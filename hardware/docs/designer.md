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

## Parts palette (left sidebar)
Lists the `lib/` blocks (parsed from each file's exported component, its `…Props` type and doc comment) plus primitives (resistor, capacitor, LED, diode, pin header, chip, mounting hole). Click an item, or drag it onto the preview, to open a small form: `name` is auto-generated and unique (R1, C2, TB3…), defaults are filled, optional props sit under **Advanced**. **Add to board** inserts the JSX before `</board>` (and the `lib/` import) in the editor buffer; it is unsaved until Save, like any edit. The **JLC search** tab, and the search box on parts with an LCSC field, query jlcsearch (stock, price, Basic/Preferred/Extended, package); picking a result fills the LCSC number, and the footprint when the package is a plain standard one.

API (`api/palette.ts`), also usable by Claude:
- `GET /api/palette` – `{ lib, primitives }`, each item `{ id, label, tag, props[], … }` (`id` like `lib:SrdRelay`, `prim:resistor`).
- `GET /api/parts/search?q=…` – `[{ lcsc, mfr, package, stock, price, tier, footprint }]`.
- `POST /api/designs/:name/components` `{ item, props?, source? }` – without `source` it edits `designs/<name>/index.tsx` on disk; with `source` it writes nothing and returns the edited text (the UI uses this for its unsaved buffer). Returns `{ name, snippet, source }`; 422 on a bad prop or duplicate name.

Placement: a blank position lands near the board centre, staggered so inserts do not stack; set `pcbX`/`pcbY` for exact placement. Open: placing at the pointer on drop (needs pcb-viewer coordinates), and "save selection as block".

Dev ports: `HW_API_PORT` / `HW_APP_PORT` env vars (defaults 3101 / 5173).
