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

## Cost and ordering
- **Cost chip** (toolbar, always visible): estimated cost per board at the BOM quantity = parts + JLC extended-part fees (from jlcsearch) + a rough PCB fab and assembly estimate. Hover for the breakdown; click opens the BOM tab. The fab/assembly part is labelled *est.*: it is a simple list-price model in `api/cost.ts` (`ESTIMATE`: per-cm² fab rate and minimum by layer count, $8 assembly setup + $1.50 stencil, per-joint and per-placement fees). Shipping, tax and promos are excluded; tune the constants when JLCPCB prices change.
- **Swap to Basic** (BOM tab): for each Extended (not Basic/Preferred) resistor, capacitor, LED or diode, jlcsearch is queried for a Basic/Preferred part with the same package and value (capacitors also keep voltage and dielectric, resistors keep tolerance at least as tight, LEDs keep colour). Savings include the $3 extended fee. **Swap** rewrites the LCSC number in the design's own files (the editor picks up the change, rebuild follows). If the number lives in a `lib/` block it is only reported ("change it in lib/x.tsx"), because that would change every design using the block. Chips, connectors, transistors and relays are not matched automatically.
- **Export panel**: Export opens a pre-flight (layers, size, part count, missing LCSC numbers, build errors/warnings, estimated total) and a CPL preview: every part on the board outline with its pads, pin-1 pad in red and a line along the `cpl.csv` rotation (0° points right; hover for the CPL row). JLCPCB's own part library can apply extra rotation offsets, so still check the placement preview on their site. Then it downloads the zip and links the JLCPCB quote page.
- **API for Claude** (all take the saved files; `qty` defaults to 10):
  - `GET /api/designs/:name/cost?qty=` – parts, extended fees, fab and assembly estimate, per-board and total.
  - `GET /api/designs/:name/swaps?qty=` – `{swaps:[{from,to,refs,savingTotal,canApply,hint,…}], skipped:[…]}`.
  - `POST /api/designs/:name/swaps/apply` body `{from,to}` – rewrites the LCSC number; returns changed files and any `libFiles` still holding it.
  - `GET /api/designs/:name/preflight` – checks plus the `cpl` array (ref, x, y, rotation, layer, pads).
- Ports: `HW_API_PORT` / `HW_APP_PORT` env vars override 3101 / 5173.
