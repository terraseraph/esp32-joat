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

## New designs, shortcuts, design list
- **New-design wizard** (`+ New design`): name, template (Blank, Expansion card = `ExpansionHeader` + `IdEeprom`, Base controller = ESP32-S3 module + 5 V to 3.3 V linear regulator), size preset or custom W×H, 2/4 layers, mounting holes (none or 4× M3 3.2 mm, 4 mm in from the corners), description. Files are generated server-side from `api/templates/index.ts`, so Claude can do the same: `POST /api/designs` with `{ name, template?: "blank"|"expansion"|"base", width?, height?, layers?: 2|4, holes?: "none"|"m3-corners", description? }` (409 if the name exists). `GET /api/templates` lists templates and size presets. The Base template imports `lib/esp32-s3-module` when that file exists, otherwise it inlines a bare module symbol.
- **Design list**: sorted by last modified; each card shows a cached PCB SVG (written after every successful build to `hardware/.cache/thumbs/`, served at `GET /api/designs/:name/thumb.svg`, placeholder until the first build), modified time, and Duplicate (`POST /api/designs/:name/duplicate`, optional `{to}`) and Delete (`DELETE /api/designs/:name`) buttons. Delete asks for confirmation and moves the folder to `hardware/.trash/<name>-<timestamp>/`; nothing is hard-deleted. `.trash/` and `.cache/` are git-ignored.
- **Shortcuts** (press `?` for the overlay): Ctrl/⌘+S save, Ctrl/⌘+Enter build, `1`/`2`/`3` Schematic/PCB/3D, `J` toggle bottom panel, `E` focus the code editor, Esc leaves the editor. Single keys are ignored while typing.
- **Preview rebuilds**: the previous viewer stays mounted and the new one fades in over it (~0.45 s settle), so the preview no longer blanks. Pan/zoom is not kept across rebuilds because the viewers do not expose it; the new viewer starts at its default view.
- Running a second instance: set `HW_API_PORT` / `HW_APP_PORT` (and `HW_VITE_CACHE` to a private dir when sharing `node_modules` with another checkout).
