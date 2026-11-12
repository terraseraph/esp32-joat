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

## Iterate safely (undo, autosave, snapshots, variants, diff)
- **Undo/redo**: `app/src/useHistory.ts` keeps a stack of whole file maps per open design. Every edit source calls `history.push(update, {key})` (the code editor does; a property panel or API-driven edit should too). Same-`key` edits within 1 s merge into one step. Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) work outside the code editor, which keeps its own undo; toolbar buttons do the same. Snapshot restore goes through the stack, so it is undoable.
- **Autosave**: toggle in the toolbar (default on, remembered in localStorage). Saves 1.5 s after the last change and when you leave the design. The toolbar reads Saving / Unsaved changes / Saved from the real difference between editor and disk. Ctrl+S still works.
- **Snapshots** live in `hardware/.cache/snapshots/<design>/<id>.json` (gitignored). Not in `designs/<name>/.snapshots`: the build walks every `.ts/.tsx/.json` under the design folder and would treat snapshots as design files and show them in `git status`. Restore first stores the current disk state as an automatic snapshot, so it is never destructive. Snapshots are not a substitute for git commits.
- **New variant**: button on each design card and in the workspace. Copies the whole folder to `<base>-revb`, `-revc`... and sets `board.json` `revision` to the same letter (next after the source's, skipping taken names).
- **Revision diff**: "Snapshots & diff" tab. Pick two snapshots or one vs current (unsaved editor state included). Builds both revisions, matches parts by name, lists added / removed / moved / changed (value or footprint props, position, rotation, layer, board size). The preview pane switches to a board map with the same colours; click a row or a part to focus it. It is a separate SVG built from circuit-json geometry, not drawn inside the tscircuit PCB viewer (its pan/zoom is not exposed). Diffs build two full revisions, so they are slow on boards that autoroute slowly.

### API (for Claude and scripts)
```
GET    /api/designs/:name/snapshots                  list, newest first
POST   /api/designs/:name/snapshots   {label?, files?}  files omitted = files on disk
GET    /api/designs/:name/snapshots/:id              full snapshot with files
DELETE /api/designs/:name/snapshots/:id
POST   /api/designs/:name/snapshots/:id/restore      writes files to disk, returns {files, backup}
POST   /api/designs/:name/variant     {name?}        returns {name, revision}
POST   /api/designs/:name/diff        {a, b, files?}  a/b = snapshot id or "current"; files = unsaved state for "current"
```
Set `HW_API_PORT` / `HW_APP_PORT` to run on other ports. Known limit: a build with override files still merges the files on disk, so diffing a snapshot that lacks a file that exists on disk sees that file.
