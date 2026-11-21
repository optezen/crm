# Builder Studio (visual builders)

One place (`/builder`, `/automations`, `/dashboards`, with a shared tab bar) to configure a business by describing it to Optizen AI, by drag and drop, or by forms. **These are not three systems.** The AI, the canvas and the list editors all read and write the same validated models, through the same database functions:

| Builder | Model | Saved through | Published through |
| --- | --- | --- | --- |
| Workflows (canvas) | `AutomationDefinition` (`lib/automation`) | `automation_save_visual` -> `automation_save_draft` | `automation_publish` |
| Forms | `WorkspaceConfig.objects[].fields[]` | `save_workspace_visual` -> `save_workspace_draft` | `publish_workspace_config` |
| Pipeline | `WorkspaceConfig.pipeline` | same | same |
| Dashboards | `dashboard_save` widgets | `dashboard_save` (version-checked) | n/a (saved = live for its audience) |

Work Mode stays separate and simple: its only new pieces are the lead **Board view** and section headings/help text on custom-module forms.

## Workflow canvas

* Only what the engine can execute is drawable. The engine runs **one trigger, an optional single condition group (checked once, before any action), then an ordered list of actions; a delay is the `wait` action.** So the canvas is a chain. Branches, merges, loops, a second condition, or a condition after an action are refused when you connect (with the reason shown) and again when compiling (`graphToDefinition`). No branching semantics were invented; adding them would need engine changes and tests first.
* `lib/builder/workflowGraph.ts` is the only place these rules live: `canConnect`, `graphToDefinition`, `definitionToGraph`, `nodeIssues` (which runs the real `validateAutomation` per node, so the canvas never invents rules), and edit helpers. Disabled "Next step" options in the properties panel are the keyboard way to connect.
* **Layout is separate metadata.** Node positions and the viewport live in `automation_layouts` (migration 0017, shape-validated, size-capped, readable only by owners/admins) and never enter the definition the engine reads. A stale layout (different number of steps) is ignored and re-laid out.
* Gestures: drag nodes, draw connections from the right-hand port, click/press Delete to remove (deleting a middle step reconnects its neighbours), Ctrl/Cmd+wheel (trackpad pinch) and +/- zoom, wheel or dragging the background pans, **Fit to view**, undo/redo (Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z; a drag or a burst of typing is one step), arrow keys nudge the selected step, Tidy layout, Move earlier/later buttons.
* Save needs a *valid* definition (same rule as the list editor), so an unfinished canvas stays in the browser until it compiles; the problems list says exactly what to fix and selects the offending step.
* `/automations/<id>?view=list` still opens the original list editor on the same draft. Execution history is on the same page.

### Conflicts and AI proposals
* Saves carry an optimistic token (`md5` of the draft + name, or `none`) and the published version the editor was based on. A save from a stale tab, or after a publish elsewhere, is refused (`changed since you opened it`) and nothing is overwritten.
* An AI workflow proposal opens at `/automations/new?proposal=<id>` **unsaved**, validated again, with a banner (and a stale warning if it references a module that no longer exists). Edit it visually; **Save draft** creates the draft and marks the proposal `draft_saved`; publishing from the canvas marks it `published`. If someone changed the draft after the AI proposal was approved, the proposal's own publish button refuses (`changed after you approved`). Nothing is published without a human pressing Publish.
* Dashboards and module proposals work the same way: dashboard proposals open at `/dashboards/new?proposal=<id>`; module proposals are saved as the workspace draft and open in the Form Builder, which edits that same draft.

## Forms
* Palette of all existing field types (text, number, date, dropdown, checkbox, phone, email, currency), drag or Add. Reorder by drag or Alt+Up/Down. Labels, help text (new `description`, max 200), sections (new `section`, max 40), required, dropdown options, currency, hide/show.
* **Keys are permanent.** New fields get unique keys (also unique against hidden fields); the type of a published field is locked; published fields can be hidden, not removed. Stored values are untouched by any of this (tested: reorder + regroup + relabel + republish leaves `records.data` identical).
* Sections are runs of neighbouring fields with the same `section`. `FormFields` renders the form for **both** Work Mode (new/edit) and the builder preview, so the preview is the real form.
* `description`/`section` are validated in TypeScript (`validateConfig`) and in PostgreSQL (`visual_validate`, wrapped around the previous validator); a corpus test checks they agree.

## Pipeline
* Stage rows with drag/keyboard reorder, colour (`gray|green|blue|amber|red|purple`, display only), and **transition requirements** `requires_assignee` / `requires_summary`, enforced by `crm_set_stage` when a lead moves *into* the stage (lead page, board, automations all go through it). Creating a lead is not blocked.
* **Safe rename / merge / removal.** Stages are keyed by name in leads, so a rename is stored as a **migration plan** `pipeline.stageMoves: [{from,to}]` in the draft. `publish_workspace_config` (replaced in 0017) applies it atomically: leads move, each gets a `stage_changed` activity with `reason: pipeline_migration`, an audit event lists `{from,to,leads}`, and the plan is stripped from the published version so it can never be re-applied. A stage that still holds leads cannot be removed without choosing a target (the editor blocks saving; the database refuses publishing otherwise). Existing activity history is never rewritten.
* **Board view** (`/work/leads/board`): columns in pipeline order with the configured colours, drag a card or use its Move menu; the card moves on screen only after the server accepts it. Only non-personal columns are read. It shows the latest 300 leads (counts are exact) and works for leads only; custom modules do not have a board yet.

## Dashboards
Drag a tile to reorder, drag its corner to resize on the 12-column grid (Alt/Shift+arrows from the keyboard), numeric columns/rows and Move buttons remain in the properties panel. Position is the widget order and size is `w x h`, the fields dashboards already persisted, so layouts from the AI or older editors are identical. Each tile previews through `analytics_run` **as the signed-in user** (a preview can never show more than the user may see); saves go through `dashboard_save` with the existing version check and validation; personal/shared rules are unchanged. On phones the grid collapses to one column.

## Privacy and PDF changes in this release
See `docs/ANALYTICS_AND_PERMISSIONS.md` (contact details, invoice PDFs).

## Not done / limits
* No drag-and-drop between the board and custom modules, no per-stage automation triggers on the canvas, no branching in workflows, no multi-select, mini-map, copy/paste or auto-routing of edges on the canvas.
* Touch gestures on the canvas rely on pointer events (pan/drag work; pinch-zoom is not implemented, use the +/- buttons).
* The visual editors were compiled and exercised through their pure models and the database, but not clicked through in a real browser in this environment.
