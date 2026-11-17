# Designer API

HTTP API of the hardware designer (`hardware/api/server.ts`, default `http://127.0.0.1:3101`, override with `HW_API_PORT`). Local only: non-localhost hosts/origins get 403. `:name` is a folder under `hardware/designs/`. Errors are `{ "error": "..." }`.

Read endpoints use the **last (cached) build of the saved files**; the first call after a change triggers a build, which can take minutes on big boards.

## Designs and files
| Method | Path | Notes |
|---|---|---|
| GET | `/api/designs` | `[{name, meta}]` |
| GET | `/api/designs/:name` | `{name, meta, files}` (design-relative paths) |
| PUT | `/api/designs/:name/files` | body `{files:{path:content}}`, writes to disk |
| POST | `/api/designs/:name/build` | body `{files?}` unsaved overrides; returns `{ok, circuitJson, errors, warnings, durationMs}` |
| GET | `/api/designs/:name/bom?qty=10&refresh=1` | priced BOM |
| GET | `/api/designs/:name/export` | JLCPCB zip |
| GET | `/api/git/status`, POST `/api/git/commit` `{message}`, POST `/api/git/push` | git |

## Inspect (read-only)
- `GET /api/designs/:name/components` → `[{ref, type, value, mpn, footprint, lcsc, x, y, rotation, layer, width, height, source:{file,line}|null, block, pins:{port:net}}]`. `source` is found by statically scanning `name="X"` / `` name={`X${n}`} `` in the design and `lib/` files; `block` is set when it is a `lib/*.tsx` line. Positions are mm, board coordinates.
- `GET /api/designs/:name/nets` → `[{name, kind:"ground"|"power"|"signal", ports:[{ref, port}]}]`. Unnamed nets are called `~REF.port/REF.port`.
- `GET /api/designs/:name/explain` → `{title, summary, groups:[{id,title,sentences:[{text,refs}]}]}`. Deterministic walkthrough (power input, protection, monitoring, regulation, MCU, I/O, connectors, other) plus `board.json` notes. Heuristics are in `api/explain.ts`; they classify by type, MPN and net names, so they can misfile unusual parts.
- `GET /api/designs/:name/snapshot.png?view=pcb|schematic&width=1600` → PNG (`circuit-to-svg` + `@resvg/resvg-js`).

## Change requests and proposals (human in the loop)
Nothing is written to the design until the user presses **Accept** in the *Describe a change* tab.

- `POST /api/designs/:name/requests` `{text}` → request (stored in `hardware/.designer-state/<name>.json`, gitignored)
- `GET /api/designs/:name/requests?status=open|resolved|dismissed`
- `POST /api/designs/:name/requests/:id/resolve` `{status?:"resolved"|"dismissed", note?}`
- `POST /api/designs/:name/proposals` `{summary, files, requestId?}`. `files` maps a design-relative path (or `lib/<block>.tsx` for a shared block) to the full new content, or `null` to delete. Returns the proposal with per-file diffs. A hash of each target is stored so a stale proposal is detected.
- `GET /api/designs/:name/proposals?status=pending|accepted|rejected`, `GET .../proposals/:id` (adds `diffs`, `stale`)
- `POST .../proposals/:id/accept` `{force?}` writes the files; 409 if the files changed since (retry with `force:true` to overwrite). Marks the linked request resolved.
- `POST .../proposals/:id/reject`

## Live change feed
`GET /api/ws` upgrades to a WebSocket that only sends, JSON text frames of `ChangeEvent` (`hardware/shared/changes.ts`): `{type:"hello"}` on connect; `{type:"design", name, files:[...]}` when files inside one design changed (design-relative paths); `{type:"lib", files}` for a shared block; `{type:"designs"}` when a design folder was added, removed or renamed; `{type:"orders"}`; `{type:"ai", design, phase:"start"|"model"|"tool"|"done", step?, tool?, ok?, summary?}` while an in-app AI request runs on a design (the Stop button's `POST /api/designs/:name/ai/cancel` aborts it). Bursts of writes are merged into one event per design after 250 ms of quiet; editor temp files are ignored. Same local-only rules as the HTTP API (host and origin must be localhost, else 403). Nothing sent by a client is read. The Vite dev proxy forwards it (`ws: true`).

## Build plan
A saved, ordered checklist for a job with several parts or blocks, so the assistant works through it one item per request and a reload, a restart or a new chat resumes it. Stored in `hardware/.cache/plans/<design>.json` (not part of the design). The in-app assistant and an agent in chat write it through the same tools (`plan_get`, `plan_set`, `plan_update`); the app's plan strip reads and edits it through these routes:
- `GET /api/designs/:name/plan` returns `{plan}`, null when there is none. `PUT` replaces it with `{goal, items:[{title, detail?, status?, lcsc?, refs?}]}` (1 to 30 items; ids are assigned as `p1`, `p2`, ...). `DELETE` clears it.
- `PATCH /api/designs/:name/plan/items/:id` with any of `{status, title, detail, lcsc, refs}`; status is `todo`, `doing`, `done` or `skipped`, and setting one item to `doing` puts any other back to `todo`. `POST /api/designs/:name/plan/items` `{title, detail?, after?}` adds an item.
- Every change is pushed to open pages as `{type:"plan", design}` on the change feed. A saved plan is also placed at the top of each assistant request as a compact block (`planBlock`), so "carry on" needs no tool call.

## MCP server
`hardware/mcp/server.ts` is a dependency-free stdio MCP server (hand-written JSON-RPC, so `@modelcontextprotocol/sdk` is not needed). The repo's `.mcp.json` registers it as `hardware-designer`, so Claude Code sessions in the repo see these tools once the designer is running (`npm run dev` in `hardware/`). Set `HW_API_PORT` (or `HW_API_URL`) in `.mcp.json` if the API is not on 3101.

The server holds no tools of its own. It lists and runs the shared registry below.

## Agent tool registry (`hardware/shared/tools.ts`)
One list of tools (name, description, JSON schema, run function) used by both agents:

- the MCP server lists all of them, so an agent in chat can call them;
- the in-app assistant (`api/ai.ts`) passes the same objects to the provider as native tools, minus `get_snapshot` (image results) and the three decisions that belong to the user (`accept_run`, `rollback_run`, `restore_snapshot`). `GET /api/ai/tools` returns its list.

Every tool calls the HTTP routes in this document through a transport: `fetch` in the MCP server, `app.inject` inside the API. Arguments are checked against the schema first (required, top-level types, enums, unknown names). Results are kept small: no tool returns the full source or the circuit JSON except `read_design`.

| Kind | Tools |
|---|---|
| Read | `list_designs`, `read_design`, `list_components`, `list_source_components`, `list_nets`, `gpio_map`, `explain_design`, `build_design`, `run_checks`, `get_bom`, `cost_summary`, `list_swaps`, `get_snapshot`, `list_palette`, `search_parts`, `list_requests`, `list_proposals`, `list_snapshots`, `run_status` |
| Edit (working draft) | `add_part`, `patch_component`, `connect_pins`, `set_pin_net`, `rename_net`, `assign_gpio`, `apply_swap` |
| Run and review | `create_snapshot`, `restore_snapshot`, `accept_run`, `rollback_run`, `propose_change` |
| Build plan | `plan_get` (read), `plan_set`, `plan_update` |
| Orders (local records) | `order_preflight`, `list_orders`, `get_order`, `create_draft_order`, `refresh_order`, `update_order` |

The order tools save and update order records on this machine. None of them contacts a manufacturer, places an order or pays: the user uploads the package and pays on the vendor's site, then `update_order` records the quoted total, order number and tracking they report.

To add a tool, add one entry to `TOOLS`; both agents get it. `shared/tools.test.ts` checks the schemas.

### Working-draft runs
Edit tools write to the design's files directly, so the next build and check see the change. The first edit opens a **run**, which takes an automatic snapshot of the design first. Every later edit by any agent joins the open run until the user decides it:

- `GET /api/designs/:name/run` → `{run: {id, label, startedAt, snapshotId, edits:[{at, tool, summary}]} | null}`
- `POST .../run/begin` `{label?}` → the open run, or a new one (snapshot taken)
- `POST .../run/log` `{tool, summary}` records one edit
- `POST .../run/accept` keeps the edits and closes the run
- `POST .../run/rollback` restores the run's snapshot (the current files are snapshotted first, so a rollback can be undone) and closes the run
- `POST .../pin-net` `{ref, pin, net|null}` sets or removes one pin's net (used by `set_pin_net`)

The open run is stored in `hardware/.cache/runs/<name>.json` (gitignored). Edits made by hand in the app are not part of a run. `propose_change` is separate: it writes nothing until **Accept**, and is for changes the edit tools cannot express (and the only way to change a shared `lib/` block).
