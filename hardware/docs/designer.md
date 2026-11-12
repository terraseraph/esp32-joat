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

## Builds that don't block you
- **Worker process per build.** `api/build.ts` forks `api/build-worker.ts` for every build, so a slow design never blocks the API or other designs. Builds are still serialized per design; a build that carries unsaved editor files is *supersedable*: a newer editor build kills it instead of queueing behind it.
- **Quick vs full.** `POST /api/designs/:name/build {files?, mode: "quick"|"full"}` (default `full`; BOM and export always use `full`). Quick rewrites `<board ...>` to `routeRemaining={false}` in memory (nothing is saved) and sets the tscircuit platform option `schematicDisabled` (schematic trace routing dominated big boards), so you get placement + ratsnest without autorouting and the Schematic tab is empty; unrouted-net errors become warnings. The debounced edit build and the **Build** button are quick; **Route** is the full autorouted build.
- **Progress and Cancel.** `GET /api/designs/:name/build/status` returns `{state, mode, phase, progress?, elapsedMs}` (the app polls it every 0.5 s and shows phase, a bar, an elapsed timer and **Cancel** in the toolbar). `POST /api/designs/:name/build/cancel` kills the worker.
- **Disk cache.** The last good build per design is stored in `hardware/.cache/builds/<name>.json` (gitignored) with the hash of its inputs. `GET /api/designs/:name/build/cached` returns it; opening a design shows it immediately while the rebuild runs, and an unchanged input hash returns the cache with `cached: true` (a full result also satisfies a quick request).
- **Ports.** `HW_API_PORT` / `HW_APP_PORT` override 3101 / 5173.
- **Open:** router choice, re-route selected nets and keep-existing-traces are not exposed; tscircuit only offers them via `<autoroutingphase>` / `autorouter` board props in the design source, not as a runtime option.
- **Quick-mode limits.** The `routeRemaining` rewrite is a regex over every `.tsx` file (design and `lib/`, including comments), and it adds `routeRemaining={false}` to every `<board`. Explicit `<autoroutingphase>` elements and `<trace>`s still route in quick mode. The BOM tab uses quick builds; export uses full.
- **Supersede rules.** A quick editor build is killed (or skipped if queued) by any newer editor build; a Route (full) build is only replaced by a newer Route, so typing does not kill a long route. Workers exit if the API process goes away.
