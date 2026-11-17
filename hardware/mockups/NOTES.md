# Joat Hardware redesign: notes on the three mockups

Files: `a-bench.html`, `b-pipeline.html`, `c-overview.html`, linked from `index.html`. All are static (inline CSS, a ~15-line script for tab and screen switching, optional Google Fonts). Dark theme only; status is never colour-only (labels and shapes accompany colour). Resize to about 900 px for the narrow layouts. Deep links: `file.html#screen:design`, `#screen:order,ostep:quote`, `#screen:pipeline,stage:bom`.

All three show the same fictional data so they can be compared: base-s3 (checks failing, 12 open doubts of 13, 5 are blockers, taken from `board.json` notes), relay-8 (delivered), relay-8-revb (ready to order, drives the order pipeline), test-joat-base (ordered, in fabrication), base-s3-revb (draft variant). Prices, stock and several LCSC numbers are invented for the mock; the doubts text, board sizes and part families come from the repo.

Shared product ideas, independent of direction (these need backend work whichever layout wins):

- **Board status is derived, not stored**: draft / checks failing / ready to order / ordered / delivered computed from last build (errors, unrouted nets), open blocker doubts, and orders.
- **Doubts become structured**: today they are a numbered string in `board.json` `notes`. The mockups assume each has an id, severity (blocker / risk / verify), refs, and open/resolved state, with blockers gating the order pre-flight.
- **AI builder uses the existing structured ops** (`read_design`, `run_checks`, `component.patch`, `connect`, `palette.add`, `build_design`, `propose_change`), shows them as a trail, and every mutation lands as a proposal with accept/reject. Order and export operations are never callable by the agent (see Settings > Agent permissions).
- **Order pipeline** (pre-flight, BOM and stock, quote, shipping, review and place, tracking) needs a new `api/orders.ts` plus persistence (`.cache/orders/`). Feasibility risk: JLCPCB has no open public API for placing PCB+assembly orders. Realistic fallbacks are generating the upload package and deep-linking into JLCPCB's order page, with the app tracking status manually or by email/webhook. The mockups show the ideal flow and a "sandbox / dry-run" mode; plan for the fallback.
- **Provider keys**: the current AI panel keeps keys in server memory until restart. The mockups propose an OS-keychain (or encrypted local file) store plus a per-provider connection test, which is a change in `api/ai.ts`.

---

## A. Bench (dense IDE workbench)

**Layout idea.** Thin menu bar, icon rail (Designs, Bench, Parts, Orders, Settings), and a status bar showing errors, doubts, cost and active model. The Bench screen is a three-column IDE: explorer (files, components, nets, palette) / canvas with Schematic-PCB-3D-Code tabs over a bottom panel (Checks, Doubts, BOM, Cost, GPIO, Snapshots; Doubts is open by default) / right dock (AI builder, Inspector, Order readiness). Designs home is a single dense table with status, checks, doubts, per-board cost and last build. Ordering is a full-page wizard with a vertical stepper (each step shows its result on the right side of the row) and a running-total column.

**Strengths.**
- Closest to the current app, so lowest risk and fastest to build; keyboard shortcuts, panels and the PCB editor carry over.
- Highest information density: errors, doubts and cost are always visible in the status bar and bottom panel.
- AI sits beside the canvas, so the user can watch proposals land on the board while the trail scrolls.

**Weaknesses.**
- The manufacturing path is a place you go to, not something you see; a new user may never find "Order".
- Seven-plus panels compete for space; at 900 px the explorer disappears and the right dock drops below the canvas.
- Looks like a developer tool; less welcoming for occasional users.

**Components to change.**
- `Workspace.tsx` (554 lines): extract the panel registry (it already has bottom-panel groups and sub-tabs) so Doubts and Cost become first-class tabs and the right column becomes tabbed (AI, Inspector, Order readiness). Add the status bar.
- `AiAssistant.tsx`: move from a bottom panel to the right dock; add the tool-call trail and proposal cards (accept/reject) with provider/model picker in the composer; move key entry out to Settings.
- `Changes.tsx`, `Review.tsx`, `Problems.tsx`: merge into the Doubts and Checks panels; `Review.tsx` needs structured doubts.
- `Bom.tsx`, `Swaps.tsx`, `CostChip.tsx`, `cost.css`: render in the bottom panel; stock column gets low/out-of-stock states.
- `DesignList.tsx`: card grid becomes a table with derived status.
- `ExportPanel.tsx`: replaced by the order wizard (new `OrderWizard.tsx`, `Orders.tsx`, `Settings.tsx`); `App.tsx` gets routes for them.
- `BuildProgress.tsx`: move into the toolbar/status bar. `styles.css`: tighten type to 12-13 px, adopt the token set.

---

## B. Pipeline (stage-centric)

**Layout idea.** The product is one pipeline, shown everywhere. Home is a board-by-stage matrix (Design, Pre-flight, BOM, Quote, Order, Fabricate, Ship, Delivered) where a red cell is "the thing stopping this board". Inside a board a chevron stage bar stays pinned at the top. The Workbench is three columns: AI builder (left, conversation first) / canvas / a **gate** panel (right) that lists exactly what must clear to leave the Design stage (blockers, errors) with a 0/8 counter and tabs for Doubts, Checks, BOM, Cost. The Pipeline screen is the same stage bar with one stage's content below and an "order ticket" receipt on the right.

**Strengths.**
- Answers "what is stopping me ordering this?" at a glance, for one board and for all of them.
- Order stages and design stages feel like one continuous flow instead of an export dialog bolted on.
- The gate concept turns review doubts from notes into a checklist with consequences.

**Weaknesses.**
- Strongest opinion about process; a user who only wants to tweak a footprint still sees pipeline chrome (about 70 px of stage bar).
- AI column on the left shrinks the canvas more than A; at 900 px the three columns stack and the AI trail becomes a long scroll below.
- The matrix needs real derived state per stage for every board (more backend logic, more ways to be wrong).

**Components to change.**
- `App.tsx`: new top-level nav (Boards, Workbench, Pipeline, Orders, Parts, Settings).
- `DesignList.tsx`: becomes the matrix; needs an API returning per-stage status for every design.
- `Workspace.tsx`: add the stage bar above the grid, a left AI column and a right gate column; the bottom panel disappears (its content moves to the gate tabs). Largest layout rewrite of the three.
- `AiAssistant.tsx`: becomes a full-height column (as in A, plus the trail).
- `Review.tsx`, `Problems.tsx`, `Changes.tsx`: feed the gate panel; blockers drive the stage state.
- `ExportPanel.tsx` is replaced by `Pipeline.tsx` with one component per stage and `Orders.tsx`.
- `BuildProgress.tsx`, `Bom.tsx`, `Swaps.tsx`: reused inside stages (Swaps becomes the BOM-stage substitution step).
- New: derived-stage selector in `api/`, plus the order and settings code common to all directions.

---

## C. Overview (calm, dashboard-first)

**Layout idea.** Left sidebar (Projects; the current board's Overview / Workspace + AI / Order; Orders, Parts, Settings). Projects is a card gallery with board thumbnails, a stage progress strip and one primary action per card; a "Needs you" strip lists blockers across boards. A board opens on an **Overview**: a readiness hero (board preview and a plain checklist: routing, doubts, independent DRC, parts, fab limits), cost / parts / last-build tiles, the full doubts list, and a side rail with an "Ask the builder" box, activity and orders. Workspace is a focused canvas with a right drawer (Doubts, Checks, BOM, Cost) and the AI builder as a floating, collapsible dock. Ordering is a horizontal stepper in a centred card with a sticky order summary.

**Strengths.**
- Most approachable; the first screen of a board explains where it stands in sentences, not panels.
- Canvas gets almost the whole window when the dock is collapsed.
- Good fit for returning to a board after weeks: activity and readiness are the entry point.

**Weaknesses.**
- Lowest density; needs more scrolling and more clicks to reach BOM or checks while designing.
- The floating AI dock covers part of the canvas and competes with selected-part overlays; users must remember to collapse it.
- Two entry screens per board (Overview, Workspace) add a navigation step for power users.

**Components to change.**
- `App.tsx` and a new sidebar shell; routes for Overview, Workspace, Order.
- `DesignList.tsx` becomes the card gallery (needs thumbnails: render a cached PCB SVG per design, an extension of `pcbModel.ts` output).
- New `BoardOverview.tsx` assembling readiness, cost (`CostChip.tsx`), parts, doubts (`Review.tsx`) and activity (`Snapshots.tsx` / `GitControl.tsx` data).
- `Workspace.tsx`: remove the bottom panel group, add the right drawer and the dock; `Preview.tsx` and `PcbEdit.tsx` mostly unchanged.
- `AiAssistant.tsx` as a collapsible dock; add trail, proposals, provider picker.
- `ExportPanel.tsx` replaced by `OrderWizard.tsx` and `Orders.tsx`; `styles.css`/`cost.css` get a looser spacing scale (card padding 18-24 px).

---

## Comparison

| | A Bench | B Pipeline | C Overview |
|---|---|---|---|
| Build effort | Lowest | Highest (workspace rewrite, per-stage state) | Medium (new overview, dock) |
| Density | Highest | High | Lowest |
| Manufacturing path visibility | Low-medium | Highest | Medium |
| Best for | Daily designers | Designers who order often | Occasional users, teams |
| Accessibility notes | Small 11-12.5 px type is the risk | Chevron stage bars clip focus rings; use inset outline | Largest touch targets (34 px controls) |

Verification done: the three files were opened in a browser at 1440 px and 900 px and the main screens checked visually; text and status colours were chosen for at least 4.5:1 on their backgrounds (muted text on panels is about 6.5:1 or higher), but no automated WCAG audit was run.
