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

## Connecting pins and the GPIO map (no typing net names)
Bottom panel tabs **Nets & connect** and **GPIO map**. Source: `api/connect.ts` (edits), `api/connect-routes.ts` (endpoints), `shared/nets.ts` (nets from circuit JSON, used by app and API), `app/src/Connect.tsx`, `app/src/Gpio.tsx`.
- **Connect mode**: switch it on (the preview jumps to the schematic), click pin A then pin B (a third click restarts), choose a net from the dropdown (default: join the net a pin is already on, else a suggested new name such as `U1_A0`) and press Connect. *Advanced* has pin pickers (also the way to pick pins on the PCB view, which cannot be clicked) and a custom net name. The edit lands in the editor as an unsaved change; Save writes it.
- **Nets list**: every net with pin count and the parts on it. Click to highlight its parts in the schematic and list its pins; Rename changes every `"net.X"` literal in `index.tsx`. If a lib block also uses that net (for example `SDA`, `V3_3`), renaming is refused unless forced, because it would split the net.
- **GPIO map** (designs using `Esp32S3Module`): every module pin with its net in a dropdown (existing nets, unconnected, or New net…). Pin list and default connections are read from `lib/esp32-s3-module.tsx`. Flags: a net on two IO pins, IO35–37 (octal PSRAM, error), strapping IO0/IO3/IO45/IO46 (IO46 also input-only), USB IO19/IO20, ADC2 (IO11–IO20) unusable with WiFi, JTAG IO39–42, UART0. The per-pin notes live in `pinNotes()` in `api/connect.ts` (WROOM-1-N16R8 specific); edit there if the module changes. It reads the source, so it needs no build.
- **How an edit is written**: for a pin the tool prefers, in order, the entry in the component's `connections={{…}}`, an existing `<trace from=".REF > .PIN" to=… />` (its `to` is retargeted, so no second net is created), then adds `connections` (lowercase primitives) or a new `<trace>` before `</board>` (lib blocks, which may not accept `connections`).
- **API (for Claude)**, all under `/api/designs/:name/`, JSON bodies. Edit endpoints return `{ ok, changed, how, source, written }`; without `source` in the body they edit `index.tsx` on disk, with `source` they only return the edited text (the app does this to keep unsaved edits).
  - `POST connect` `{ a:{ref,pin}, b?:{ref,pin}, net? }` puts `a` (and `b`) on `net` (`"SDA"` or `"net.SDA"`; omitted = suggested name). `ref` is the part's `name`, `pin` its port label as in the circuit JSON.
  - `GET|POST nets` lists nets with `pinCount` and `pins` (GET builds the design; POST accepts `{ circuitJson }`).
  - `POST rename-net` `{ from, to, force? }`.
  - `GET|POST gpio` returns the map (`rows`, `clashes`, `nets`); `POST gpio/assign` `{ pin, net|null }` sets or clears an IO.
