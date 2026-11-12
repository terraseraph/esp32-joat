# Hardware

Board designs as [tscircuit](https://docs.tscircuit.com) code, with a local tool to view, cost and export them.

## Run

```bash
cd hardware
npm install
npm run dev
```

Open http://localhost:5173. The API runs on 127.0.0.1:3101 and the app proxies `/api` to it.

## Add a design

Click **New design** in the app, or create `designs/<name>/` by hand with:

- `index.tsx`, which default-exports a component that renders a `<board>`
- `board.json`, containing `{ "name", "description", "revision", "notes" }`

Shared blocks live in `lib/` and are imported as `../../lib/<block>`. Give every part `supplierPartNumbers={{ jlcpcb: ["C…"] }}` so the BOM can price it.

**Export** downloads a zip for JLCPCB with Gerbers, drill files, `bom.csv` and `cpl.csv`. The **Push** button in the git menu is the only thing that pushes.

Part prices come from jlcsearch.tscircuit.com and are cached for 24 h in `.cache/parts.json`.
