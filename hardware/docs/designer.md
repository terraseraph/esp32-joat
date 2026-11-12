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

## Checks that explain themselves
After every build the API runs design-rule checks and returns them in the build response (`checks`) and from `GET /api/designs/:name/checks` (full list, plus `checklist` and `notes`). Each issue has `severity` (`error`/`warning`/`info`), `title`, `message`, `why` (why it matters), `fix`, `refs` (parts/nets) and `where` (`view`, `x`, `y`, `w`, `h` in mm, `pcbComponentId`) so Claude can act on them.
- Sources: the build's own errors/warnings, `@tscircuit/checks` `runAllChecks` (clearance limits taken from `rules`), and custom rules in `api/checks.ts`: trace width vs current on nets listed in `rules.netCurrents` (IPC-2221, 10 °C rise), traces thinner than `rules.minTrace`, copper pour or traces under the ESP32 module antenna end (a 15 mm outward / 6 mm inward zone at the pad-free edge of any component named or numbered `esp32`), and ICs whose supply pin has no ground capacitor within `rules.decouplingMaxDistance`. Schematic tidiness and pin-role hints are `info` and hidden behind a toggle.
- **Problems tab:** click an item (or **Show**) to switch to the PCB, pan and zoom to it and draw a marker; **Why?** expands the explanation and fix. Zoom works by reading the viewer's transform from its focus outline and driving it with synthetic drag/wheel events (the viewer has no camera API), so a big viewer upgrade may need that revisited. Schematic issues only switch the tab.
- **Review tab:** `board.json` `checklist: [{id, text, status: "open"|"ok"|"wontfix", note}]`; tick status, add notes and items. **Split notes into checklist** turns the numbered `(1) … (2) …` items of `notes` into entries (idempotent; `notes` is kept). **Advanced: design rules** edits `board.json` `rules: { minTrace, minClearance, copperOz, netCurrents: {"VLOAD": 20}, decouplingMaxDistance }` (mm, mm, oz, amps, mm).
- `PATCH /api/designs/:name/meta` with `{checklist?, rules?, notes?, splitNotes?}` edits `board.json` on disk, keeping other keys. `board.json` is excluded from the build hash unless a source file mentions it, so ticking items does not rebuild.
- Both servers read `HW_API_PORT` / `HW_APP_PORT` (defaults 3101 / 5173).
