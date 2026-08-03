# Work Item Lifecycle — Design Spec
**Date:** 2026-08-03  
**Project:** JWX Delivery Timeline (`index.html`)  
**Status:** Approved

---

## Goal

Let the plan be maintained from the page instead of from the source file. Three capabilities:

1. **Mark items done** — record that a work item has shipped.
2. **Add / delete work items** — the item list is no longer fixed at 14.
3. **Select / deselect MVP membership** — decide per item whether it gates the MVP milestone.

---

## Why this needs a data-model change

All three are blocked by the same property of the current persistence layer. `load()` (`index.html:201`), `applyOverlay()` (`:285`) and the cloud read path all iterate `BASELINE.map(b => …)` and overlay **only** `s`, `dur` and `team`. Consequences today:

- An item absent from the hardcoded `BASELINE` array cannot exist → no adding.
- A deleted item is reconstructed from `BASELINE` on the next load → no deleting.
- A changed `type` or `mvp` flag is discarded on refresh → no persistent done or MVP state.

Separately, `type` is overloaded: it selects the bar colour **and** decides MVP milestone membership via `type==='MVP'||t.mvp` (`:421`, `:431`). Making "done" a toggle collides with that — a done MVP item has no representable value.

---

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Status vs scope | **Two independent axes** | Every combination is expressible; marking work done cannot silently move a milestone date. |
| Source of truth | **Saved state is authoritative** | Add/delete/rename need no tombstones or three-way merge. `BASELINE` becomes the first-run seed and the Reset target. |
| Item controls | **Inline in the row gutter** | Reuses the existing `.lrm` button pattern; no click-vs-drag disambiguation on a bar that is already `pointerdown`-driven. |
| Add flow | **Per-lane `+ item`, prompt for name** | Team is implied by the lane; everything else defaults and is one click to change. |
| Status rendering | **Hatch (done) + faded trailing edge (in dev)** | Scope colour stays at full saturation, so finishing an item costs nothing in legibility. |
| Dependencies | **Remove the dependency check entirely** | Chosen deliberately; see Removals below for what is given up. |

---

## Data model

`type` and `dep` are replaced by two orthogonal fields:

```js
// before                                        after
{id:'jwdata',      type:'DEV', mvp:true}         {id:'jwdata',      scope:'MVP', status:'in-dev'}
{id:'viewability', type:'MVP'}                   {id:'viewability', scope:'MVP', status:'planned'}
{id:'playback',    type:'MVP', dep:'viewability'} {id:'playback',   scope:'MVP', status:'planned'}
{id:'gam',         type:'GA'}                    {id:'gam',         scope:'GA',  status:'planned'}
```

- **`scope`** — `'MVP' | 'GA'`. Binary: deselecting MVP makes an item GA. Drives bar colour and MVP milestone membership.
- **`status`** — `'planned' | 'in-dev' | 'done'`. Drives the bar's visual treatment and nothing else. It does **not** affect any milestone date.

Full item shape: `{id, name, team, s, dur, size, scope, status}`.

`TYPE` is replaced by `SCOPE = {MVP:{bg:'#5B51C6'}, GA:{bg:'#1D9E75'}}`.

### Baseline mapping

All 14 items in `BASELINE` convert mechanically: `type:'GA'` → `scope:'GA', status:'planned'`; `type:'MVP'` → `scope:'MVP', status:'planned'`; the single `type:'DEV', mvp:true` item (`jwdata`) → `scope:'MVP', status:'in-dev'`. No baseline item uses `type:'DONE'`, so that case needs no mapping. `playback` loses its `dep:'viewability'` field.

### Incidental cleanups

Both are in code this change already rewrites:

- **`LOCKED`** (`:194`) is `new Set([])` and gates four branches in `render()` and `buildBar()` that can never fire. Removed.
- The **gutter badge fallback** `t.mvp ? 'MVP' : type==='DONE' ? 'done' : '·'` (`:363`) becomes the size or `'·'`, since MVP and done now have dedicated controls.

Out of scope: any refactor not required by these three features.

---

## Persistence

### Payload — version 2

```js
{ app:'jwx-timeline', version:2, exportedAt:'<ISO>',
  teams:[ …custom lanes… ],
  tasks:[ {id, name, team, s, dur, size, scope, status}, … ] }
```

The wire format does not change shape — `saveToCloud()` already sends the entire `tasks` array (`:224`). Each item gains fields. What changes is the read side.

### Validation — `sanitizeTasks(arr)`

Because saved state is now authoritative, a malformed payload could render the page unusable; today `BASELINE` always supplies structure. Every load path runs items through this gate:

| Field | Rule | On violation |
|---|---|---|
| `id` | non-empty string, unique within the array | **drop the item** |
| `name` | string | `'Untitled item'` |
| `team` | string | first editable lane (`pubmon`) |
| `s` | finite, `>= 0` | `0` |
| `dur` | finite, `>= 0.5` | `1` |
| `size` | one of `S M L XL —` | `'—'` |
| `scope` | `'MVP'` or `'GA'` | `'GA'` |
| `status` | `'planned'`, `'in-dev'` or `'done'` | `'planned'` |

Duplicate ids keep the first occurrence. `ensureLanes()` (`:161`) already creates a lane for any unknown `team` value, so a team that no longer exists is self-healing.

### Load path

Applies identically to localStorage, the cloud read, and Import:

```
payload
  ├─ unparseable, or `tasks` is not an array      → clone(BASELINE)
  ├─ version >= 2, `tasks` is an array            → sanitizeTasks(tasks)   ← including []
  ├─ bare array / version absent or 1, non-empty  → migrateV1(tasks)
  └─ bare array / version absent or 1, empty      → clone(BASELINE)
```

The last branch matters: an empty **v1** array carries no information, because v1 only ever stored positional overlays. It cannot mean "the plan was emptied" — that meaning exists only from v2 on. Reading it as an empty plan would let an empty imported file silently wipe a plan, and would break the pre-existing `importState` guard and the `'cloud storage is empty'` branch, both of which already treated an empty v1 array as nothing-to-load.

### Empty list is a legal state

Deleting every item is now possible, so `tasks: []` is meaningful. Today `init()` reads an empty list as "cloud storage is empty" and falls back to `BASELINE` (`:272`), which would silently resurrect 14 deliberately deleted items.

**Rule:** an explicit `version:2` payload whose `tasks` is an empty array is respected. Status reads `No work items — add one from a lane, or Reset to baseline`. Only a missing or corrupt payload falls back to `BASELINE`.

The distinction is the array as received, **not** the array after sanitizing. A payload arriving with `tasks: []` is a deliberate empty plan and is respected. A payload arriving with items that all fail the `id` rule sanitizes down to `[]` from a non-empty input — that is a corrupt payload and falls back to `BASELINE`. Without this distinction the two cases would be indistinguishable after validation.

An empty timeline already renders correctly: `Math.max(...[], 0)` returns `0`, `drawMilestones()` guards on `if(m.w<=0)return` (`:424`), the metric chips show `—`, and each lane shows its existing `— drop items here —` placeholder (`:342`).

### Migration from v1

v1 saved state only ever persisted `s`, `dur` and `team` — `type` and `mvp` always came from `BASELINE` — so migration loses nothing. `migrateV1()` is today's `applyOverlay()` unchanged: overlay those three fields onto the new `BASELINE`, and `scope`/`status` arrive from the baked plan.

Detection: `version` absent or `1`, or the payload is a bare array.

### Deploy-day behaviour

The live site writes v1 payloads, so on the day v2 ships the shared bin holds a v1 payload. The upgrade is lossless: the first load migrates it, preserving dragged positions and team reassignments; nothing else was ever persisted. The first save afterwards rewrites the bin as v2.

This is one-way. Reverting the deploy would leave v1 code reading a v2 payload — it would still find `s`/`dur`/`team` on every item and render correct positions, but added items would be dropped and deleted items would return. Acceptable given GitHub Pages serves exactly one version. Note that whoever loads and then saves first after the deploy sets the shared v2 state for everyone.

### Unchanged

**Reset** still assigns `clone(BASELINE)` and remains the only route back to the baked plan. **Import** runs the same three-branch load path, so JSON files exported by the current version still import. **Export** and cloud save carry the new fields.

---

## UI

### Row gutter controls

The existing `.ctl` row (`:351`) gains three controls, reusing the red-✕ `.lrm` pattern already used for team removal (`:337`):

```
│  Ad viewability policy setup   │
│  [Pub Mon ▾] [MVP] [done] XL ✕ │
```

- **`[MVP]` pill** — filled `#5B51C6` with white text when `scope==='MVP'`; muted outline when `'GA'`. Click toggles `scope`.
- **Status pill** — labelled with the current state and cycling on click: `planned → in dev → done → planned`. Self-describing, one click, and makes all three statuses reachable, which a plain checkbox cannot (it would leave `in-dev` settable only from `BASELINE`, and unchecking `jwdata` would strand it at `planned`).
- **`✕`** — class `.irm`, calls `confirm('Delete "<name>"? This cannot be undone.')`. There is no undo; Export serves as the backup path, and Reset restores the baked plan. It must **not** reuse the `.lrm` class: `tests/timeline.spec.js:365` locates the team-remove button by that class and would match item buttons too.

Measured fit: `select` 78 + MVP 40 + status 52 + size badge 26 + ✕ 20 + gaps 32 ≈ 248px within the 286px usable gutter (310px less 24px padding). No gutter widening needed.

All three controls call `stopPropagation()` on `pointerdown`, mirroring the team `<select>` at `:358`.

Every mutation calls `render()` then `save()`, matching the team `<select>` handler (`:357`) and drag release (`:414`). `save()` already arms the cloud auto-save via `markDirty()` (`:219`), so no mutation handler calls `markDirty()` directly.

### Adding items

A small ghost `+ item` button in each lane header's **gutter** (`:335`), beside the lane label and following the precedent of the `.lrm` team-remove button already there.

> Revised during planning. The button was first specified for the left edge of the lane's `.band` (`:338`). That does not work: `.band` scrolls horizontally, and a `position:sticky` button inside it slides underneath the sticky 310px gutter, which sits at `z-index:6`. The header gutter is itself sticky, so a button placed there is always visible with no positioning tricks. Lane labels already ellipsize (`:90`), so the reduced label width is absorbed by existing behaviour.

Excluded from the `inflight` lane, matching the existing team-dropdown exclusion at `:354` — that lane represents pre-Jun-15 work and is not an assignment target.

Prompts for the name only (`window.prompt`, as `addTeam` does at `:164`); an empty or cancelled prompt is a no-op. Defaults:

| Field | Value |
|---|---|
| `team` | the clicked lane |
| `s` | end of that lane's last bar, or `0` if empty |
| `dur` | `1` |
| `size` | `'M'` |
| `scope` | `'GA'` |
| `status` | `'planned'` |

Id: `'i-' + slugify(name)`, uniquified with the same collision loop as `addTeam` (`:165`).

---

## Rendering

### Bar structure

The in-dev fade cannot be a `mask-image` on `.bar` itself: the resize handle is a **child** of the bar (`:385`), masks apply to the whole subtree, and a child cannot opt out — so masking the bar would fade out the drag-to-extend affordance on exactly the items in progress. The bar splits into two layers:

```
.bar          ← transparent background; holds the label text and .handle (both crisp)
 └ .bar-fill  ← position:absolute; inset:0; scope colour; carries the hatch or the fade
```

`positionBar()` (`:393`) currently rewrites `bar.textContent` and re-appends the handle; it is updated to preserve `.bar-fill` the same way.

### Treatments

| State | Treatment |
|---|---|
| `scope` | `.bar-fill` background: `#5B51C6` (MVP) or `#1D9E75` (GA) |
| `status:'planned'` | no additional treatment |
| `status:'in-dev'` | `.bar-fill` gets `mask-image: linear-gradient(to right, #000 0, #000 68%, transparent 100%)` plus the `-webkit-` prefix. Gridlines show through the fade. |
| `status:'done'` | `.bar-fill` gets `repeating-linear-gradient(135deg, rgba(255,255,255,.42) 0 3px, transparent 3px 8px)` over the scope colour; label gains a `✓` prefix |

`barLabel()` (`:391`) becomes `size · durLabel`, prefixed with `✓ ` when done, keeping the existing narrow-bar fallback to the size alone. Done bars remain draggable and resizable so history can be corrected.

### Legend

Six swatches: MVP scope, GA scope, done (hatch), in dev (fade), MVP milestone, GA milestone — plus the existing size-scale note.

### Milestone maths

`updateMetrics()` (`:431`) and `drawMilestones()` (`:421`) replace `type==='MVP'||t.mvp` with `scope==='MVP'`. Unchanged otherwise: MVP date is the latest end among MVP-scope items, GA date the latest end among all items, span is the GA end. **Marking an item done changes neither date.**

---

## Removals

The dependency check goes entirely: the `#m-depchip` / `#m-dep` chip elements (`:109`), the `.chip.dep` CSS (`:37-38`), the `.bar.violation` CSS (`:82`), the `dep` field, and the dependency block in `updateMetrics()` (`:436-443`).

The page footnote (`:135`) is reworded to drop its two critical-path sentences — the claim that viewability → playback sets the MVP date, and the description of the chip turning red. Retaining that text would describe a guardrail the UI no longer enforces.

**What this gives up:** nothing warns you if `Ad playback mode` is dragged to start before `Ad viewability policy setup` finishes, which was the plan's stated critical path. Positions become purely advisory. This was chosen deliberately over generalising the check; a dependency editor, if wanted later, is its own spec.

---

## Testing

`tests/timeline.spec.js` — Playwright / Chromium, currently 37 tests. The suite never asserts on `type`, `mvp` or the dependency chip, so existing coverage is largely unaffected.

### Edits

- `expect(data.version).toBe(1)` → `toBe(2)` (`:142`).
- The `mockCloud` helper (`:42`) builds `version: 1` envelopes; it gains a v2 shape. The v1 shape is retained as a migration fixture.
- `each exported task has required fields` (`:148`) additionally asserts `scope` and `status`.

### New coverage

**Mark done**
- Cycling the status pill to `done` puts the done treatment on the bar.
- Done state survives a reload.
- Marking the latest MVP-scope item done leaves the MVP date chip unchanged — the load-bearing invariant of the two-axis model.
- The pill cycles `planned → in dev → done → planned` back to its start.

**MVP scope**
- Toggling `[MVP]` off the latest MVP item moves the MVP date chip earlier; toggling it back restores the original date.
- Scope survives a reload.
- The bar's colour class follows the scope.

**Add**
- `+ item` on a lane adds one row to that lane and leaves other lanes untouched.
- The new bar starts at or after the lane's previous last bar end.
- It defaults to GA scope and planned status.
- It survives a reload.
- Dismissing the name prompt adds nothing.
- The `inflight` lane has no `+ item` button.

**Delete**
- Confirming removes the row.
- **It stays deleted after a reload** — the behaviour the v1 model cannot express.
- Dismissing the confirm keeps the item.
- Deleting every item leaves a page that renders, with `—` in the metric chips, and a reload does **not** resurrect `BASELINE`.

**Persistence**
- A v1 payload in localStorage migrates with `s`/`dur`/`team` preserved and `scope`/`status` derived from `BASELINE`.
- A v1 cloud payload migrates the same way.
- A corrupt payload (`tasks` not an array) falls back to the 14 baseline bars.
- An item with `scope:'nonsense'` sanitizes to `GA`; `dur:-5` sanitizes to `1`.
- An item missing `id` is dropped while its siblings load.
- A payload where **every** item fails validation falls back to `BASELINE`, while a payload arriving with `tasks: []` stays empty — the two must not collapse into the same outcome.

---

## Files touched

| File | Change |
|---|---|
| `index.html` | data model, persistence, gutter controls, per-lane add, bar layers, legend, footnote, removals |
| `tests/timeline.spec.js` | two edits plus the new describes above |
| `docs/superpowers/specs/2026-08-03-item-lifecycle-design.md` | this spec |

No dependency or tooling changes. One CI change was added late: `.github/workflows/deploy.yml` now also removes `docs/` before publishing, because this branch would otherwise have served ~1500 lines of internal spec and plan from the public Pages site. The credential substitution step is untouched, and the two placeholder constants remain byte-identical.

---

## Known issues and follow-ups

Raised by the final whole-branch review, deliberately not fixed in this branch. Recorded here rather than lost, roughly in order of how much they matter.

**The JSONBin master key is embedded in a public page.** Pre-existing, but this change altered its blast radius. Under the old overlay model a hostile or corrupt write could only reposition bars, because the read path overlaid `s`/`dur`/`team` onto BASELINE. Now the payload is authoritative, so a single write can replace or empty the plan for every viewer, with no undo and no history. The magnitude clamp and `sanitizeTeams` bound how *malformed* a payload can be, not how *wrong* it can be. Fine for an internal timeline, but it should be a conscious decision rather than a side effect of the refactor.

**`loadTeams()` is not gated.** `sanitizeTeams()` covers the cloud and import paths; the localStorage path still feeds `fill`/`ink` into inline styles unchecked. Only reachable by hand-editing your own storage — `saveTeams()` writes already-sanitized lanes — so it is self-inflicted rather than remote, but it is the same class of defect and the inconsistency is worth closing.

**Unset deploy secrets fail quietly in the worst direction.** GitHub substitutes missing secrets as empty strings, so `'YOUR_BIN_ID_HERE'` becomes `''`, `cloudEnabled()` returns **true**, and every visitor gets a permanent `⚠ Cloud unavailable` instead of clean local-only mode. A guard in the workflow that exits non-zero on an empty secret would fail loudly instead.

**MVP and GA milestone lines collide when the overall-latest item is MVP-scope.** Both lines and both labels land on the same x, and the GA label paints over the MVP one. Newly reachable, because scope was not editable before. Cosmetic; `drawMilestones()` could nudge the second label when the x values match.

**Deleting the last item, or importing a v2 payload with `tasks: []`, gives no guidance.** The `No work items — add one from a lane, or Reset to baseline` copy lives only in `init()`, so it appears on reload but not at the moment the timeline becomes empty. The v2-empty import path also has no test; the only empty-import test uses a v1-shaped payload and asserts failure.

**Deleting an item no longer names it in the status line when cloud sync is off.** A consequence of ordering `setStatus` before `save()` so the `● Unsaved changes` indicator wins in the cloud-on case, which is production. The name is still in the `confirm()` dialog the user just accepted.

**At the 520-week clamp ceiling, bars can draw past the last gridline.** A direct consequence of `nWeeks()`'s 600-week backstop being lower than 520 + a long duration. Only reachable from a payload that was already clamped, i.e. already corrupt.

**Minor test-suite notes.** The drag tests use synthetic `page.mouse` events against `pointerdown` handlers — the flakier style, though stable across every run here. The `dismissing the confirm` and `dismissing the prompt` negative assertions use fixed 300ms waits, matching the pre-existing house style, because there is no event to await for "nothing happened".
