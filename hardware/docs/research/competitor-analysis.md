# Competitor and feature-gap analysis

Researched 2026-11-17. Scope: AI / code-first PCB tools, and which fabs and parts vendors can be driven by an API, measured against the goal of "design with AI, then quote, order parts, fab + assembly and shipping without leaving the app".

How to read the confidence marks:
- **[V]** read on the vendor's own page or repo during this research.
- **[S]** secondary source only (search snippet, third-party review, integrator guide). Treat as a lead, not a fact.
- **[U]** could not verify either way.

Baseline for "our tool" is `hardware/docs/designer.md` and `hardware/docs/api.md` as of this date.

## 1. Feature matrix

Columns: **Joat** (this tool), **tscircuit** (platform + `tsci` CLI), **Flux** (flux.ai), **atopile**, **Diode** (`pcb` CLI / Zener), **KiCad+MCP** (mixelpixx KiCAD-MCP-Server / Konnect), **EasyEDA Pro**, **Quilter**, **DeepPCB**.

| Feature | Joat | tscircuit | Flux | atopile | Diode | KiCad+MCP | EasyEDA Pro | Quilter | DeepPCB |
|---|---|---|---|---|---|---|---|---|---|
| Design as code | Yes (TSX) | Yes (TSX) [V] | No (GUI + agent) | Yes (`.ato`) [V] | Yes (Zener/Starlark) [V] | No (agent drives GUI/files) | No | No | No |
| Schematic / PCB / 3D preview | Yes | Yes | Yes | Via KiCad [V] | Via KiCad [V] | KiCad | Yes | Layout only | Layout only |
| Click-to-edit PCB (drag, rotate, properties) writing back to source | Yes | Partial (manual edits file) [U] | Yes (native GUI) | In KiCad | In KiCad | In KiCad | Yes | No | No |
| Autorouting | tscircuit default only; no router choice or partial re-route | Default router + custom `autorouter={{algorithmFn}}` and HTTP autorouting API [V] | AI auto-layout [S] | KiCad / manual | KiCad / manual | Freerouting integration [S] | Built-in | Core product: full placement + routing, multiple candidates [S] | Core product: placement + routing, credit-priced API [V] |
| Design-rule checks with explanations | Yes (`why`, `fix`, location) | `tsci check` (pcb-style done; netlist/placement/routing "under development") [V] | AI design review [S] | Assertions + solver [V] | "Deep validation" [S] | KiCad ERC/DRC via `kicad-cli` [S] | Built-in DRC | Physics checks [S] | - |
| Constraint/equation solving, parametric part picking | No (LCSC numbers; Basic swap for passives only) | No [U] | No | Yes: equations, tolerances, automatic picking of discretes [V] | Partial (registry search with price/stock) [S] | No | No | No | No |
| Parts search with stock/price | Yes (jlcsearch) | Yes (`tsci import --jlcpcb`, jlcsearch) [V] | Yes, live pricing/stock [S] | Yes (picker) [V] | Yes [S] | Yes (JLCPCB catalogue, 2.5M parts) [S] | Yes (LCSC/JLC native) | No | No |
| BOM + cost estimate | Yes; fab/assembly is a local model, shipping excluded | Real order quote via API [S] | Part cost + lead time [V] | BOM output [V] | BOM [S] | BOM export | Real JLC quote at order | No | No |
| JLCPCB fab + assembly export | Yes (zip, CPL preview, preflight) | Yes (`tsci export`, fabrication zip) [S] | Yes (JLCPCB-marked files) [S] | Yes (gerbers, BOM, PnP) [V] | KiCad outputs | Yes (Konnect) [S] | Native | Returns to ECAD tool | Returns to ECAD tool |
| Order from inside the tool | No (downloads zip, links quote page) | Yes: platform order button and ordering API [S] | Conflicting: FAQ says no in-app ordering, a newer doc says the agent "places the order" [S] | No | No | No | Yes: Export > PCB Order uploads Gerbers and opens JLC order page [V] | No | No |
| Order tracking in tool | No | `GET /orders/get` [S] | [U] | No | No | No | On jlcpcb.com | No | No |
| Simulation | No (disabled; planned) | `tsci simulate analog` (SPICE) [V] | Yes [S] | No [U] | Test benches [V] | Via KiCad/ngspice | Yes | No | No |
| Version control / diff | Git + snapshots + visual revision diff | Git + registry versions | Built-in history | Git | Git | Git | Cloud history | - | - |
| Reusable blocks / registry | Local `lib/` only | Public registry, `tsci add/push` [V] | Public parts/projects | packages.atopile.io [V] | Registry, `diode://` links [V] | KiCad libs | Shared libs | - | - |
| In-app AI assistant | Yes (own key: OpenAI / Anthropic / Nous); proposes whole files; cannot build | No in-app; relies on coding agents | Yes, self-correcting agent, credit-priced [S] | VS Code/Cursor extension; agent via coding tools [V] | No in-app; coding agents | N/A | AI agent edits projects via an official API skill [S] | N/A | N/A |
| MCP server | Yes (`hardware-designer`) | Community only (registry search) [S] | No public one found [U] | Community only (atoplace, 40+ tools, placement/DFM) [S] | Built into CLI (`pcb mcp`) [S] | Yes, the whole product [S] | Community bridges; ordering deliberately excluded or prep-only [S] | No [U] | Listed for enterprise [S] |
| Published agent skill | No | Yes, `npx skills add tscircuit/skill` [V] | No | Community skill [S] | Yes (`skills/` in repo; built with Anthropic) [V][S] | Several community skills [S] | Official API skill [S] | No | No |
| Headless CLI for CI | No (HTTP API only) | Yes (`tsci build/check/export/snapshot`, `--json`) [V] | No | Yes (`ato build`) [V] | Yes (`pcb build/layout`) [V] | `kicad-cli` | No | API | API [V] |
| ESP32-specific help (GPIO map, strapping/ADC2/PSRAM flags, antenna keep-out) | Yes | No | Generic | Generic | Generic | No | No | No | No |
| Price | Free, local | Free/open source; platform [U] | Subscription + AI credits (about $20-$142/mo, third-party figures) [S] | Open source | Open source (MIT) [V] | Open source | Free | Usage-based, free tier with limits [S] | 0.5 credit/min [V] |

Reading of the matrix: Joat is already ahead of every tool here on ESP32-specific checks, explained DRC, in-place source rewriting and local/free operation. It is behind on (a) anything after the export zip, (b) agent ergonomics (structured, low-token operations and a build/check loop), (c) part intelligence, and (d) routing control.

## 2. Features we are missing (ranked for a solo designer shipping ESP32 boards via JLCPCB)

| # | Missing feature | Why it matters | Effort |
|---|---|---|---|
| 1 | **Order package + order record.** One object per order: design, git commit, revision, qty, export zip hash, board options (layers, thickness, finish, colour), assembly side, quote, vendor order number, payment state, tracking number, delivered date. | Nothing after "download zip" exists today. Every ordering route below needs this object first, and it gives reorder and "which revision is on my desk" for free. | S-M |
| 2 | **Structured edit tools on MCP and for the in-app AI, from one shared tool registry.** The HTTP API already has `PATCH components/:c`, `connect`, `gpio/assign`, `swaps/apply`, `POST components`; the MCP server only exposes `propose_change` (whole files), and the in-app AI also returns whole files. | This is the owner's stated goal (same functions from an agent or the in-app AI) and the biggest token saver: "move R4 2 mm" should cost a tool call, not a file. Flux, Konnect and Diode all work through fine-grained operations. | M |
| 3 | **Agent build-check loop.** The in-app AI "does not run a build". Give it `build_design` (quick), `run_checks`, `get_bom`, `cost_summary` as tools and let it iterate until checks pass, within the existing 4-call / 2-minute bound (raise it). | Flux's main selling point in 2026 is a self-correcting agent. Without this the user is the feedback loop. | M |
| 4 | **Real quote instead of the local estimate, including shipping to AU.** Via whichever route in section 4 is adopted (tscircuit quote API, JLCPCB API if approved, or scraped/assisted quote). | The cost chip excludes shipping, tax and promos, which on small runs to Australia is a large part of the bill. | M (depends on route) |
| 5 | **Order hand-off with human payment.** Agent prepares cart or order, user pays through the vendor's page or a payment link, app records the result. Pattern is the one AtlasPCB's MCP server uses (`create_order` returns a payment link). | Closes the pipeline without the app ever holding card details. | M-L |
| 6 | **Stock check at order quantity with alternates.** For each BOM line: stock >= qty x boards (+ attrition), flag lifecycle risk, propose in-stock alternates beyond passives. | A single out-of-stock part cancels or stalls a JLC assembly order. Flux and atopile both surface this live. | S-M |
| 7 | **JLC rotation-offset correction for the CPL.** Apply the known per-package offsets (JLCPCB publishes an "SMT Assembly Components orientation fix" repo [S]) before export. | The export panel currently says "still check the placement preview on their site". Wrong rotation is the classic silent PCBA failure. | S-M |
| 8 | **Published skill for coding agents.** A `SKILL.md` that teaches an agent the tool order (read -> structured edit -> quick build -> checks -> propose), like `tscircuit/skill`. | Cheap, and it is how tscircuit and Diode get good agent behaviour without bigger prompts. | S |
| 9 | **Datasheet-grounded part checks.** Fetch the datasheet for a chosen part and verify pinout, absolute max ratings and decoupling against the design (Diode exposes a `resolve_datasheet` tool [S]). | Designer.md says catalogue matches "do not verify datasheet ratings or pin mapping". This is the error class DRC cannot catch. | M |
| 10 | **Routing control.** Router choice, re-route selected nets, keep existing traces; optional external router (DeepPCB API, or Freerouting via DSN export). | base-s3 takes ~76 s to route and any edit re-routes everything. Listed as "Open" in designer.md. | M-L |
| 11 | **Parametric part picking.** Specify "10k 1% 0603" and let the tool choose a Basic in-stock LCSC part at build time (atopile's model). | Removes hand-maintained LCSC numbers for passives and makes #6 automatic. Swap-to-Basic is half of this already. | M |
| 12 | **Non-JLC parts ordering.** Order the parts JLC does not place (modules, connectors, hand-solder parts) from LCSC, Mouser or Digi-Key from the BOM. | Completes "order parts" in the goal. Lower priority because most ESP32 board parts are JLC-assembled. | M (API-gated) |
| 13 | **Simulation.** `circuit-json-to-spice` and `spicets` are already dependencies; tscircuit ships `tsci simulate analog`. | Useful for power stages and analog front ends; rarely the blocker on digital ESP32 boards. | M |
| 14 | **Headless CLI.** `joat-hw build|check|export <design> --json` with exit codes. | Lets a pre-push check or CI gate on design-rule errors; also a cheaper agent surface than MCP for batch work. | S |
| 15 | **KiCad export/import.** | Required to use Quilter, DeepPCB, Freerouting or a human reviewer. `tsci convert` exists [V] but its coverage was not checked. | M |
| 16 | **Panelisation, test points and a bring-up checklist generated from nets.** | Matters once boards go past prototypes. | M |
| 17 | **Public registry for blocks.** | Low value for one person; `lib/` is enough. | L, skip |

Side note found while reading: `hardware/docs/api.md` lists eleven MCP tools and omits `read_design`, `run_checks`, `cost_summary` and `gpio_map`, which the running server exposes. Not changed here.

## 3. Fab and parts API table

"Access" is what a single developer must do before the first production call. "AU" is whether the vendor ships to Australia.

### Fabs and assemblers

| Vendor | Quote API | Order API | Pay via API | Tracking | Access requirements | AU | Source |
|---|---|---|---|---|---|---|---|
| **JLCPCB** | Yes for bare PCB (upload Gerbers, automated pricing) [V] | Yes for bare PCB, stencil, 3D print [V]. **PCBA/SMT assembly is not among the four APIs JLCPCB lists** (PCB, stencil, 3D printing, parts) [V]; one third-party review says SMT ordering is covered [S] | Not described anywhere [V] | Production progress yes; logistics not described [V] | JLCPCB account, apply at api.jlcpcb.com; "not all applications will be approved"; review is based on previous orders and "company and business situation"; applicant needs own developers; branding rules (no "JLC" in your URL) [V]. HMAC-signed requests, no sandbox [S]. A 2023-era blog reported the API as suspended; the help article now says it is open [S] | Yes [U - not re-verified, but routine] | https://jlcpcb.com/help/article/jlcpcb-online-api-available-now , https://api.jlcpcb.com/ , https://supergood.ai/api-report-card/jlcpcb , https://blog.npry.dev/resenv/oneclick-jlc |
| **tscircuit platform** | `POST /order_quotes/create` (parts, PCB, shipping options, total) [S] | `POST /orders/create` with a package release id [S] | [U] | `GET /orders/get` [S] | tscircuit account + session token (`tsci login`); design pushed to the registry (`tsci push`, private by default [V]). Fab used, assembly coverage and limits [U]: the docs page returned 404 to the fetcher, so this row rests on search snippets | [U] | https://docs.tscircuit.com/web-apis/ordering-api , https://docs.tscircuit.com/building-electronics/ordering-prototypes |
| **PCBWay** | Yes, bare PCB [V] | Yes, bare PCB [V]; assembly API "still under construction" [V] | Not mentioned [V] | Order status yes [V] | Email anson@pcbway.com for approval, judged on company/business situation; aimed at partners with their own website [V] | Yes [U] | https://www.pcbway.com/api_cooperation.html , https://api-partner.pcbway.com/Help/Api/POST-api-Pcb-PlaceOrder |
| **AISLER** | No public REST reference [S] | Upload via token-based "AISLER Push"; part-service and assembly-upload keys issued case by case [S] | No | In web account | Support form; a third-party review mentions an OAuth MCP server but contradicts itself [S] | [U] (EU fab; non-EU orders ship untaxed with duties on arrival [S]) | https://supergood.ai/api-report-card/aisler , https://community.aisler.net/t/is-there-a-public-api-spec-for-part-service-and-assembly-upload/5528 , https://community.aisler.net/t/shipping-methods/672 |
| **MacroFab** | Yes (PCB quote, multi-tier quote, manufacturability) [V] | Older v2 docs describe `POST /order/pcb`, shipping quote and pay steps [S]; the current docs index shows quote and order read endpoints only [V] | Described in old docs [S] | Order list/details [V] | Self-serve API key in account settings [S] | [U] (US/Mexico factories; North America-focused) | https://apidocs.macrofab.com/ , https://supergood.ai/api-report-card/macrofab |
| **CircuitHub** | Orders reference an existing quote/offer id; shipping options per offer [V] | `POST /v1/orders` after a preview [V] | Yes, `paymentMethodId` of a saved method [V] | `trackingNumber`, `shippedDate` on the order [V] | Bearer API key, workspace [V] | [U] (docs mention import duties for international) | https://api.circuithub.com/docs/guides/orders |
| **AtlasPCB** | `get_quote` MCP tool [V] | `create_order` from cart, bare PCB only (no assembly tool) [V] | No: returns a Stripe payment link for the human [V] | `get_order`, `list_orders` [V] | API key (`sk_live_*` / `sk_test_*`), npm MCP server `@atlaspcb/mcp-server` [V]. Vendor quality unknown | [U] | https://www.atlaspcb.com/ai-order/ |
| **OSH Park** | No | Uploads, projects, orders resources [V] | No credit cards via API; invoiced accounts only [S] | [U] | Ask support for API access [S]; clients date from 2014 [S]; no assembly | Ships internationally [U] | https://oshpark.com/developer , https://docs.oshpark.com/tips+tricks/api/ , https://rubydoc.info/gems/oshpark/file/README.md |
| **Eurocircuits** | No public API [S] | No | No | Web account | - | [U] | https://supergood.ai/api-report-card/eurocircuits |
| **Seeed Fusion** | No public API; PCBA quotes go to a procurement team within a working day [S] | No | No | Web account | Distributor programme only [S] | Yes [U] | https://supergood.ai/api-report-card/seeed-fusion , https://wiki.seeedstudio.com/Service_for_Fusion_PCB |
| **PCBgogo** | [U] nothing found | [U] | [U] | [U] | - | [U] | none found |
| **EasyEDA Pro -> JLCPCB** (not an API) | At JLC order page | Editor uploads Gerbers and opens the JLC order page [V] | On jlcpcb.com | On jlcpcb.com | EasyEDA project required, so not usable from tscircuit source | Yes | https://prodocs.easyeda.com/en/pcb/order-order-pcb/ |

### Parts

| Vendor | Search/price API | Order API | Pay via API | Tracking | Access requirements | AU | Source |
|---|---|---|---|---|---|---|---|
| **LCSC** | Yes (keyword search, product detail, categories) [V] | Yes, `POST /rest/wmsc2agent/submit/order`; shipment-method lookup [V] | Not listed [V] | Order check endpoint; no tracking endpoint listed [V] | LCSC account then apply; aimed at partners; key + nonce + timestamp + SHA-1 signature [V][S]; new keys work on the test API until LCSC activates them [S] | Yes [U] | https://www.lcsc.com/docs/openapi/index.html , https://help.luminovo.com/en/articles/148501-lcsc |
| **jlcsearch** (already used) | Yes, no key | No | - | - | None | - | (in use) |
| **Mouser** | Search API, self-serve key | Order API: cart, options query, submit order, order history [S] | Yes, but only with a card already saved on the account (or net terms) [S] | Order details [S] | Key from My Mouser > APIs; Order API key may sit in pending authorisation [S]. Mouser pages timed out during this research, so nothing here is [V] | Yes, au.mouser.com exists [S] | https://www.mouser.com/api-order/ , https://au.mouser.com/api-order , https://support.cofactr.com/articles/3599779681-mouser-integration-setup |
| **Digi-Key** | Product Information API | Ordering + OrderManagement APIs [V] | On account | OrderManagement [V, details not shown] | "Active DigiKey Credit account" required [V], which rules out a hobby/card account | Yes (AU storefront) [U] | https://developer.digikey.com/products/ordering |
| **Nexar / Octopart** | Yes (GraphQL), aggregated price/stock | No (links out to distributors) | - | - | Free evaluation: 100 parts (personal email) or 1000 (business email) [V, undated article] | - | https://support.nexar.com/support/solutions/articles/101000492485-getting-free-parts-in-the-api |
| **Cofactr** | Component Cloud API, metered per part [S] | Platform API; order execution enabled only after talking to their team (risk of inadvertent charges) [S] | Via account | Yes [S] | Subscription; contact success@cofactr.com [S]; US kitting/logistics model | [U] | https://support.cofactr.com/articles/4081898446-cofactr-platform-api-documentation |

## 4. Which ordering route is automatable end to end today

Short answer: **no route verified here gives quote + parts + fab + assembly + payment + AU shipping through an official API that a one-person account can simply switch on.** JLCPCB is the right factory, but its API is approval-gated on order history and business profile, its own pages list no PCBA API and no payment call. Plan for a human at the payment step in every route.

Recommended order of work:

1. **Build the order package and order record first (gap 1).** Vendor-neutral. Contents: export zip, board options, assembly options, BOM with LCSC numbers, CPL, qty, git commit. Every route below consumes it.
2. **Spike the tscircuit ordering API (about half a day).** Our designs are already tscircuit, so `tsci push` (private) then `POST /order_quotes/create` and `POST /orders/create` may give a real quote and order with very little code. Unknowns to settle in the spike: which fab fulfils it, whether assembly is included, whether it ships to Australia, how payment is taken, and whether the `lib/` imports survive a push. If those come back good, this is the shortest path to "without leaving the app".
3. **Apply for JLCPCB API access now (free, slow, may be refused).** Use the existing JLCPCB account with real order history. Ask explicitly whether PCBA ordering and a pricing-only tier are available. If approved, bare-PCB quote/order/progress become native; assembly may still need route 4.
4. **Assisted JLCPCB web order as the dependable fallback.** The app opens jlcpcb.com with the package ready; either the user uploads (a few minutes) or a browser agent in the user's own logged-in session uploads Gerbers/BOM/CPL, sets options from the order record, reads back the real quote including shipping, and stops at the cart. The user reviews parts placement and pays. The app then stores the order number and polls or asks for status. Fragile against site changes and not an official interface; check JLCPCB's terms before automating it.
5. **Parts JLC does not place:** Mouser Order API is the only self-serve one found (key from the account page, pays with a saved card). LCSC needs partner approval and manual key activation. Digi-Key needs a credit account. For the usual handful of connectors and modules, generating a cart CSV / BOM-upload file for LCSC or Mouser is enough for now.

Steps that must stay manual:
- **Payment.** No JLCPCB, PCBWay or LCSC document describes an API payment call. Where an API can charge (Mouser saved card, CircuitHub `paymentMethodId`), keep an explicit confirm in the app showing item, total and address. A payment link (AtlasPCB pattern) is the cleanest design.
- **JLCPCB parts-placement review** (rotation and polarity on their viewer) until gap 7 is done and trusted, and DFM/engineering questions JLC raises by email after ordering.
- **API access applications** and any account, address or customs details.
- **Import duties/GST** on arrival in Australia where the vendor does not collect them.

## 5. How the others expose agent tooling (for gap 2 and 8)

- **tscircuit:** an installable skill (`npx skills add tscircuit/skill`) plus the `tsci` CLI (`build`, `check`, `export`, `snapshot`, `import`, `search`, `simulate`) with `--json` and exit codes. No official MCP server found; the agent edits source and uses the CLI as the feedback loop. The skill tells the agent not to publish or order without permission [S]. https://docs.tscircuit.com/ai.txt
- **Diode `pcb`:** Rust CLI, MCP built in (`pcb mcp`), tools such as registry search with price/stock and `resolve_datasheet` (datasheet to markdown) [S]; `skills/` and `.agents/` directories in the repo [V]. https://github.com/diodeinc/pcb , https://blog.diode.computer/anthropic-partnership
- **atopile:** `ato` CLI and a VS Code/Cursor extension; `AGENTS.md`/`CLAUDE.md` in the repo [V]; MCP and skill are community-made (atoplace, 40+ placement/DFM tools) [S]. https://github.com/atopile/atopile , https://github.com/glovepost/atoplace
- **KiCad MCP (mixelpixx / Konnect):** many small structured tools (place, move, route, DRC through `kicad-cli`, Freerouting, JLCPCB part search, fabrication export) rather than file edits [S]. https://github.com/mixelpixx/KiCAD-MCP-Server
- **EasyEDA Pro:** official extension API/SDK and an API skill; community MCP bridges over a WebSocket extension; ordering is excluded or "prepare only" in those bridges [S]. https://prodocs.easyeda.com/en/api/guide/ancillary-projects/pro-api-sdk.html
- **Flux:** agent is in-product, credit-metered; no public MCP or API found [U]. https://www.flux.ai/docs/copilot/copilot-credits
- **DeepPCB:** REST API for placement/routing jobs at 0.5 credit per minute; key from app.deeppcb.ai [V]; KiCad plugin (routing only) [S]. https://deeppcb.ai/deeppcb-api-your-pcb-design-ai-agent/
- **AtlasPCB:** the only vendor found with an ordering MCP server; nine narrow tools, payment by link [V]. https://www.atlaspcb.com/ai-order/

Pattern worth copying: narrow tools that return small JSON (ids, deltas, check results with locations), a quick build as the feedback step, and one write path that still goes through propose/accept. Joat already has the endpoints; they are just not on the MCP server or in the in-app AI's tool list.

## 6. Not covered or thin

- **JITX, CELUS, Circuit Mind, SnapMagic Copilot:** enterprise or sales-led, schematic/architecture generation aimed at teams; nothing found that a solo JLCPCB workflow would take from them. Only directory-level sources were found [S], so they are left out of the matrix. https://jlcpcb.com/blog/ai-tools-for-pcb-design
- **Quilter:** layout engine for existing ECAD projects (Altium, Cadence, Xpedition, KiCad), usage-priced with a free tier under size/revenue limits [S, vendor blog]. Only reachable from Joat after a KiCad export (gap 15).
- **PCBgogo:** no API information found.
- **Australia shipping** was not confirmed on any vendor page in this pass; entries marked [U].
- Third-party "API report card" pages (supergood.ai) are cited several times; that company sells unofficial API access, so its gradings are leads only.

## 7. Ordering spike (2026-11-18): tscircuit ordering API and JLCPCB official API

Read-only pass over the vendors' own docs and repos. Nothing was logged into, applied for or submitted. It supersedes the tscircuit and JLCPCB rows in section 3 and steps 2-3 of section 4 where they differ.

**Result: neither API can place an assembled-board order shipped to Australia today. The route is the assisted JLCPCB web order (section 4, step 4), fed by the order package the app now builds.**

### tscircuit ordering
- The ordering API page 404s because it was **deleted from the docs repo on 2026-07-26** (commit "Remove the datasheet api, ordering api…", #813). [V] https://github.com/tscircuit/docs/commits/main/docs/web-apis/ordering-api.mdx
- The withdrawn page (commit 9f665b3) described `POST /order_quotes/create` (`package_release_id`, `vendor_name: "jlcpcb"`), `/order_quotes/get` (quoted components, `bare_pcb_cost`, `shipping_options[]`, `total_cost_without_shipping`), `POST /orders/create` (`package_release_id` or `circuit_json`) and `/orders/get`, with session-token auth. [V, withdrawn] https://raw.githubusercontent.com/tscircuit/docs/9f665b3ee4c5a69fe4c40ed8a43826d7f32dad8e/docs/web-apis/ordering-api.mdx
- The only current evidence is the open-source test mock in the tscircuit.com repo (`fake-snippets-api/routes/api/orders/`, re-added May 2026): `POST /orders/create` takes `package_release_id`, `quantity` 1-100, `fabricator_id` (default `"tsf"`, "tscircuit San Francisco") and returns a **Stripe checkout URL**; `/orders/get` and `/orders/list` exist; there is no quote route and no `circuit_json` input. The mock's Stripe session allows shipping to **`["US"]` only**. [V for the mock; the production API is closed, so live behaviour is U] https://github.com/tscircuit/tscircuit.com/tree/main/fake-snippets-api/routes/api/orders
- The surviving guide describes a web flow only (order button on the package page, vendor quote dialog, Stripe checkout), says "Currently, JLCPCB is the only available vendor", and names no countries. [V] https://docs.tscircuit.com/guides/ordering-prototypes
- No `tsci order` command exists. `tsci quote estimate` is an offline JLCPCB estimate (fab, PCBA, parts, shipping, tax) whose library states "Only delivery to the United States is modelled"; `tsci quote create --circuithub` returns a real CircuitHub quote and orders nothing. [V] https://github.com/tscircuit/cli , https://github.com/tscircuit/circuit-json-to-jlcpcb-quote
- Still unknown: whether assembly is included, whether it is live, Australian shipping, and whether a private package can be ordered. A package release is required, so the design must be pushed to the registry first. [U]

### JLCPCB official API
- Four APIs are listed: PCB, SMT stencil, 3D printing, parts. PCB has quote (Gerber upload, automated pricing), create order and production progress. Parts is data only (specs, stock, price). [V] https://jlcpcb.com/help/article/jlcpcb-online-api-available-now , https://api.jlcpcb.com/
- **No assembly (PCBA/SMT) API is described**, and no payment call; the only payment sentence is that payment is in US dollars. No logistics/tracking call is described. The endpoint reference (`api.jlcpcb.com/docs/start`) showed no content to the fetcher, so no paths are confirmed. [V by absence / U]
- Access: JLCPCB account, apply on the developer portal, reviewed against previous orders and business situation, approval not guaranteed. [V]
- Australia: JLCPCB "ships PCBs and PCBA orders to most countries and regions worldwide" by DHL, FedEx, UPS, with carriers shown at checkout; Australia is not named on that page but is listed on the customs page with a 1000 AUD import-tax threshold. Duties and taxes are the customer's; whether GST is charged at checkout for an Australian address is not stated. [V / U] https://jlcpcb.com/help/article/do-you-ship-boards-to-my-country , https://jlcpcb.com/help/article/customs,-duties-and-taxes
- The parts API would fix the app's thin stock data (jlcsearch returns no stock figure for most parts), which is the one concrete reason to apply.

### CPL rotation
- JLCPCB publishes no rotation table. Its KiCad guide points at the third-party Fabrication Toolkit plugin, and its FAQ says its engineers review and fix rotation and polarity from the silkscreen before assembly. [V] https://jlcpcb.com/help/article/how-to-generate-the-bom-and-centroid-file-from-kicad , https://jlcpcb.com/help/article/pcb-assembly-faqs-part-2
- The community tables (Fabrication-Toolkit `transformations.csv`, Apache-2.0; JLCKicadTools `cpl_rotations_db.csv`, GPL-3.0) key on KiCad footprint names and disagree with each other on some packages (SOT-23: 180 vs -90). **Not used.** The app instead uses what tscircuit already computes per part from JLCPCB's own footprint (`pin1_location` vs `supplier_pin1_location_map.jlcpcb`), which needs no name mapping; relay-8 comes out with 73 of 73 placements matched.

### Recommended route
1. In the app: save a draft order (package, gate, labelled estimate).
2. On jlcpcb.com, by hand: upload the Gerber zip, set the options from `order-options.txt`, upload `bom.csv` and `cpl.csv`, check the placement preview, read the real total including shipping to Australia, pay.
3. Back in the app: record the quoted total, order number and tracking.
4. Optional, free, may be refused: apply for JLCPCB API access, mainly for the parts API (stock) and bare-board quote/progress. It will not remove the assembly upload or the payment in step 2.
5. Do not build on the tscircuit ordering API until tscircuit confirms PCBA and Australian shipping; ask them directly if it matters.
