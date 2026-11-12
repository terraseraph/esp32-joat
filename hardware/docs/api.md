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

## MCP server
`hardware/mcp/server.ts` is a dependency-free stdio MCP server (hand-written JSON-RPC, so `@modelcontextprotocol/sdk` is not needed). The repo's `.mcp.json` registers it as `hardware-designer`, so Claude Code sessions in the repo see these tools once the designer is running (`npm run dev` in `hardware/`). Set `HW_API_PORT` (or `HW_API_URL`) in `.mcp.json` if the API is not on 3101.

Tools: `list_designs`, `read_design`, `build_design`, `list_components`, `list_nets`, `explain_design`, `get_bom`, `get_snapshot` (returns an image), `list_requests`, `propose_change`, `list_proposals`. There is deliberately no tool that writes files directly; `propose_change` is the only write path.
