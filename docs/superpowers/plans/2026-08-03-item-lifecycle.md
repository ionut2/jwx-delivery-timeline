# Work Item Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the JWX delivery timeline be maintained from the page — mark items done, add and delete items, and toggle MVP membership — with all of it surviving reload and cloud sync.

**Architecture:** The overloaded `type` field splits into two orthogonal fields, `scope` (`MVP|GA`, drives colour and the MVP milestone) and `status` (`planned|in-dev|done`, drives visual texture only). Persistence flips from BASELINE-anchored overlay to authoritative saved state at payload `version:2`, with a validation gate (`sanitizeTasks`) and a v1 migration path. Per-item controls live inline in the row gutter; adding happens per lane.

**Tech Stack:** Single self-contained `index.html` — vanilla JS, no build step, no framework. Tests are Playwright/Chromium against `python3 -m http.server 8080`. Spec: `docs/superpowers/specs/2026-08-03-item-lifecycle-design.md`.

## Global Constraints

- **No build step, no dependencies.** Everything lives in `index.html`. The only devDependency is `@playwright/test`.
- **Credential placeholders are untouchable.** `'YOUR_BIN_ID_HERE'` and `'YOUR_API_KEY_HERE'` must remain exact string literals — `.github/workflows/deploy.yml` substitutes them by string match, and `tests/global-setup.js` does the same to build `test-index.html`.
- **Payload version is `2`**; the envelope is `{app:'jwx-timeline', version:2, exportedAt, teams, tasks}`.
- **`scope`** is exactly `'MVP'` or `'GA'`. **`status`** is exactly `'planned'`, `'in-dev'` or `'done'`. These string values appear in saved payloads — do not rename them.
- **Marking an item done must never change the MVP or GA milestone date.** This is the load-bearing invariant of the two-axis model.
- **Do not reuse the `.lrm` class** for the item-delete button; use `.irm`. `tests/timeline.spec.js:365` locates the team-remove button by `.lrm`.
- **Preserve these exact status strings** — existing tests assert on them: `'auto-saves to this browser'`, `'cloud storage is empty'`, `'Synced from cloud'`, `'Cloud unavailable'`, `'Unsaved changes'`, `'Restored'`, `'Imported'`, `'Exported'`, `'baseline'`, `"team's items"`.
- **Run tests with** `npx playwright test` from the repo root. Single test: `npx playwright test -g "test name"`. The `webServer` and `globalSetup` blocks in `playwright.config.js` handle the server and `test-index.html` generation automatically.
- **Tests that expect an empty timeline must not call `waitForBars()`** — it waits for `.bar` to exist and will time out when there are zero items.
- **Assert status text only on `/`** (cloud disabled). On `/test-index.html`, `markDirty()` fires inside `save()` and overwrites custom status messages with `'● Unsaved changes'`.
- **Commit after every task** with the messages given.
- **All `index.html` line numbers in this plan refer to the file as it stands at Task 1 Step 1** (the committed state of `feat/item-lifecycle`). Earlier tasks shift them. Locate code by the quoted content, not by line number, and treat the numbers as a hint about where in the file to look.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `index.html` | the entire app — data, persistence, render, interaction, styles | Modified throughout |
| `tests/timeline.spec.js` | full e2e suite (currently 37 tests) | 3 edits + ~6 new describes |
| `docs/superpowers/plans/2026-08-03-item-lifecycle.md` | this plan | Created |

`index.html` is ~470 lines and stays a single file — that is the project's deliberate architecture (static hosting, no bundler), so no split is proposed. Within it, the existing section order is preserved: constants → persistence → date helpers → `render()` → `buildBar`/`startDrag` → `drawMilestones`/`updateMetrics` → event wiring.

---

## Task 1: Data model — scope/status, bar layers, remove dependency check

Converts the model and every reader of `type`, splits the bar into layers so a later CSS mask cannot hide the resize handle, and removes the dependency check and dead `LOCKED` set.

**Files:**
- Modify: `index.html` — CSS `:37-38`, `:74-83`, `:94-96`; HTML `:109`, `:125-133`, `:135`; JS `:177-194`, `:346-371`, `:379-397`, `:420-444`
- Test: `tests/timeline.spec.js`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `SCOPE = {MVP:{bg:'#5B51C6'}, GA:{bg:'#1D9E75'}}` — colour lookup by scope
  - `BASELINE` items shaped `{id, name, team, s, dur, size, scope, status}`
  - DOM: `.bar > .bar-fill`, `.bar > .bar-label`, `.bar > .handle` as siblings; `.bar-fill` carries `done` / `indev` classes
  - `barLabel(t)`, `positionBar(bar, t)`, `buildBar(t)` — same signatures as before
  - `milestoneEnds()` → `{mvp, ga}` — the only place the MVP-membership predicate lives

- [ ] **Step 1: Write the failing tests**

Append a new describe block to `tests/timeline.spec.js`:

```js
// ─── Data model: scope / status ───────────────────────────────────────────────

test.describe('Scope & status model', () => {
  test('exported tasks carry scope and status, not type', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const dlPromise = page.waitForEvent('download');
    await page.click('#export');
    const dl = await dlPromise;
    const tmp = path.join(os.tmpdir(), `export-scope-${Date.now()}.json`);
    await dl.saveAs(tmp);
    const { tasks } = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    expect(tasks).toHaveLength(14);
    for (const t of tasks) {
      expect(['MVP', 'GA']).toContain(t.scope);
      expect(['planned', 'in-dev', 'done']).toContain(t.status);
      expect(t).not.toHaveProperty('type');
      expect(t).not.toHaveProperty('dep');
    }
  });

  test('bar fill and handle are siblings, never nested', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const bar = page.locator('.bar[data-id="viewability"]');
    await expect(bar.locator('> .bar-fill')).toHaveCount(1);
    await expect(bar.locator('> .bar-label')).toHaveCount(1);
    await expect(bar.locator('> .handle')).toHaveCount(1);
    // A mask on .bar-fill must not be able to hide the resize handle.
    await expect(bar.locator('.bar-fill .handle')).toHaveCount(0);
  });

  test('scope drives the fill colour', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const mvp = await page.locator('.bar[data-id="viewability"] > .bar-fill')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const ga = await page.locator('.bar[data-id="gam"] > .bar-fill')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    expect(mvp).toBe('rgb(91, 81, 198)');
    expect(ga).toBe('rgb(29, 158, 117)');
  });

  test('in-dev status is marked on the fill', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await expect(page.locator('.bar[data-id="jwdata"] > .bar-fill.indev')).toHaveCount(1);
    await expect(page.locator('.bar[data-id="viewability"] > .bar-fill.indev')).toHaveCount(0);
  });

  test('dependency chip is removed', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await expect(page.locator('#m-depchip')).toHaveCount(0);
    await expect(page.locator('.chips .chip')).toHaveCount(3);
    await expect(page.locator('.bar.violation')).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "Scope & status model"`
Expected: 5 failures — `.bar-fill` does not exist, `#m-depchip` still present, exported tasks still have `type`.

- [ ] **Step 3: Replace the TYPE constant and convert BASELINE**

In `index.html`, replace lines 177-194 (`const TYPE=…` through `const LOCKED=new Set([]);`) with:

```js
const SCOPE={MVP:{bg:'#5B51C6'},GA:{bg:'#1D9E75'}};
const BASELINE=[
  {id:'jwdata', name:'JW playback → ad dashboard data (in work, due Jun 15)', team:'pubmon', s:0, dur:5, size:'—', scope:'MVP', status:'in-dev'},
  {id:'prefetch',name:'Prefetching', team:'pubmon', s:9.5, dur:1.5, size:'M', scope:'MVP', status:'planned'},
  {id:'viewability',name:'Ad viewability policy setup', team:'pubmon', s:3, dur:6.5, size:'XL', scope:'MVP', status:'planned'},
  {id:'playback',name:'Ad playback mode', team:'pubmon', s:9.5, dur:3.5, size:'L', scope:'MVP', status:'planned'},
  {id:'lineviewability',name:'Line item viewability enforcement', team:'pubmon', s:9.5, dur:1, size:'M', scope:'MVP', status:'planned'},
  {id:'segment',name:'Ad server segmentation (multi-property)', team:'exchange', s:8.5, dur:6.5, size:'XL', scope:'GA', status:'planned'},
  {id:'postroll',name:'Postroll exposed in dashboard', team:'pubmon', s:16, dur:1.5, size:'S', scope:'GA', status:'planned'},
  {id:'gam',  name:'GAM mediation Spotlight (pre-roll)', team:'exchange', s:1, dur:5.5, size:'L', scope:'GA', status:'planned'},
  {id:'meta', name:'Expose ad metadata (JS API)', team:'exchange', s:6.5, dur:2, size:'M', scope:'GA', status:'planned'},
  {id:'preroll',name:'Extend pre-roll break', team:'auction', s:12, dur:2, size:'M', scope:'GA', status:'planned'},
  {id:'lineitem',name:'External line item (first-class)', team:'exchange', s:15, dur:3, size:'M', scope:'GA', status:'planned'},
  {id:'midrolls',name:'Fixed number of midrolls (cap in dashboard)', team:'exchange', s:18, dur:1, size:'M', scope:'GA', status:'planned'},
  {id:'pods', name:'Ad pods support', team:'pubmon', s:5, dur:5, size:'XL', scope:'MVP', status:'planned'},
  {id:'que',  name:'Que points (fixed)', team:'pubmon', s:12, dur:4, size:'L', scope:'GA', status:'planned'},
];
```

Note what changed per item: `type:'MVP'` → `scope:'MVP', status:'planned'`; `type:'GA'` → `scope:'GA', status:'planned'`; `jwdata`'s `type:'DEV', mvp:true` → `scope:'MVP', status:'in-dev'`; `playback` loses `dep:'viewability'`. The `LOCKED` set is deleted entirely.

- [ ] **Step 4: Rewrite buildBar, positionBar and barLabel**

Replace lines 379-397 (`function buildBar` through the end of `positionBar`) with:

```js
function buildBar(t){
  const bar=document.createElement('div');bar.className='bar';bar.dataset.id=t.id;
  const fill=document.createElement('div');fill.className='bar-fill';bar.appendChild(fill);
  const lab=document.createElement('span');lab.className='bar-label';bar.appendChild(lab);
  // The handle is a SIBLING of .bar-fill, never a child: .bar-fill carries a CSS
  // mask for in-dev items, and a mask applies to its whole subtree — nesting the
  // handle would fade out the drag-to-extend affordance.
  const hd=document.createElement('div');hd.className='handle';bar.appendChild(hd);
  bar.addEventListener('pointerdown',e=>{if(e.target===hd)return;startDrag(e,t,'move');});
  hd.addEventListener('pointerdown',e=>{e.stopPropagation();startDrag(e,t,'resize');});
  positionBar(bar,t);
  return bar;
}
function barLabel(t){const dl=t.dur*WEEKW;
  const txt=t.size!=='—'?(t.size+' · '+durLabel(t)):durLabel(t);
  return dl<70?(t.size!=='—'?t.size:'•'):txt;}
function positionBar(bar,t){
  bar.style.left=(t.s*WEEKW)+'px';bar.style.width=Math.max(18,t.dur*WEEKW)+'px';
  const fill=bar.querySelector('.bar-fill');
  fill.className='bar-fill'+(t.status==='done'?' done':t.status==='in-dev'?' indev':'');
  fill.style.background=SCOPE[t.scope].bg;
  bar.querySelector('.bar-label').textContent=barLabel(t);
  bar.title=t.name+'\n'+(t.size!=='—'?'Size '+t.size+' · ':'')+durLabel(t)+'\n'+fmt(startDate(t))+' → '+fmt(endDate(t));
}
```

This also removes the old `textContent`-then-re-append-handle hack: the label is now its own element, so `positionBar` no longer destroys children.

- [ ] **Step 5: Update the row gutter in render() to drop LOCKED and use SCOPE**

In `render()`, replace lines 352-364 (from `if(!LOCKED.has(t.id)){` through `ctl.appendChild(bd);`) with:

```js
      const sel=document.createElement('select');sel.className='tsel';sel.title='Move to team';
      const teamOpts=LANES.filter(l=>l.team!=='inflight').map(l=>[l.team,l.short||l.team]);
      teamOpts.forEach(([v,l])=>{const o=document.createElement('option');o.value=v;o.textContent=l;if(t.team===v)o.selected=true;sel.appendChild(o);});
      if(!teamOpts.some(o=>o[0]===t.team)){const o=document.createElement('option');o.value=t.team;o.textContent=((LANES.find(l=>l.team===t.team)||{}).short)||t.team;o.selected=true;sel.insertBefore(o,sel.firstChild);}
      sel.addEventListener('change',()=>{t.team=sel.value;render();save();});
      sel.addEventListener('pointerdown',e=>e.stopPropagation());
      ctl.appendChild(sel);
      const bd=document.createElement('span');bd.className='badge';
      bd.style.background=SCOPE[t.scope].bg;bd.style.color='#fff';
      bd.textContent=t.size!=='—'?t.size:'·';
      ctl.appendChild(bd);
```

- [ ] **Step 6: Update the milestone maths and delete the dependency block**

Replace lines 420-444 (`function drawMilestones` through the end of `updateMetrics`) with:

```js
// Single home for the MVP-membership rule: Tasks 4 and 5 both assert on it, and
// drawMilestones/updateMetrics must never disagree about where the lines fall.
function milestoneEnds(){return {
  mvp:Math.max(...tasks.filter(t=>t.scope==='MVP').map(t=>t.s+t.dur),0),
  ga:Math.max(...tasks.map(t=>t.s+t.dur),0)};}

function drawMilestones(wrap,nw){
  const {mvp:mvpEnd,ga:gaEnd}=milestoneEnds();
  [{w:mvpEnd,c:'#3C3489',lab:'MVP'},{w:gaEnd,c:'#0F6E56',lab:'GA'}].forEach(m=>{
    if(m.w<=0)return;const x=GUT+m.w*WEEKW;
    const ln=document.createElement('div');ln.className='mline';ln.style.left=x+'px';ln.style.borderColor=m.c;wrap.appendChild(ln);
    const lb=document.createElement('div');lb.className='mlabel';lb.style.left=x+'px';lb.style.background=m.c;lb.textContent=m.lab;wrap.appendChild(lb);
  });
}

function updateMetrics(){
  const {mvp:mvpEnd,ga:gaEnd}=milestoneEnds();
  document.getElementById('m-mvp').textContent=mvpEnd>0?fmt(bizDate(mvpEnd*5)):'—';
  document.getElementById('m-ga').textContent=gaEnd>0?fmt(bizDate(gaEnd*5)):'—';
  document.getElementById('m-span').textContent=gaEnd.toFixed(1).replace(/\.0$/,'')+' weeks';
}
```

Note `status` is deliberately absent from `milestoneEnds()` — marking an item done must not move a milestone.

- [ ] **Step 7: Update the CSS**

Delete lines 37-38 (`.chip.dep` rules), line 81 (`.bar.locked`) and line 82 (`.bar.violation`). Then change the `.bar` rule (lines 74-77) and add the layer rules:

```css
  .bar{position:absolute;top:18px;height:24px;border-radius:5px;color:#fff;
    font-size:11.5px;font-weight:600;display:flex;align-items:center;padding:0 8px;
    cursor:grab;user-select:none;white-space:nowrap;overflow:hidden;z-index:3;touch-action:none;
    background:transparent;}
  .bar-fill{position:absolute;left:0;top:0;right:0;bottom:0;border-radius:5px;
    box-shadow:0 1px 2px rgba(0,0,0,.12);}
  .bar-label{position:relative;z-index:1;pointer-events:none;overflow:hidden;text-overflow:ellipsis;}
```

The `box-shadow` moves from `.bar` to `.bar-fill` so a transparent bar does not cast a shadow around empty space. Add `z-index:2;` to the existing `.bar .handle` rule (line 79) so the handle stays above the fill.

- [ ] **Step 8: Remove the dependency chip and reword the footnote**

Delete line 109 entirely:

```html
    <div class="chip dep" id="m-depchip"><div class="k">Dependency</div><div class="v" id="m-dep">—</div></div>
```

Replace the footnote (line 135) with:

```html
  <p class="note">Weeks are business weeks starting Mon Jun 15, 2026 (5 business days each). Bar colour shows scope — purple for MVP, green for GA — and texture shows progress: a hatched bar is done, a bar that fades out on its right edge is in development. Durations shown are live; the size badge keeps the original T-shirt estimate so you can see drift. Changes save automatically — to the shared plan when cloud sync is on, otherwise to this browser only.</p>
```

- [ ] **Step 9: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 42 tests (37 existing + 5 new). If `overlays cloud task positions onto the BASELINE` fails, `applyOverlay` was changed prematurely; it belongs to Task 2.

- [ ] **Step 10: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "refactor: split type into scope + status, layer bars, drop dependency check"
```

---

## Task 2: Persistence v2 — authoritative saved state

Saved state becomes the source of truth. Adds validation, a v1 migration path, and the rule that an explicitly empty plan is respected while a corrupt one falls back to BASELINE.

**Files:**
- Modify: `index.html` — JS `:197-303` (persistence block), `:257-283` (`init`)
- Test: `tests/timeline.spec.js` — edit `:42` (`mockCloud`), `:142`, `:255-264`

**Interfaces:**
- Consumes: `BASELINE`, `clone()`, `SCOPE` from Task 1
- Produces:
  - `SCHEMA_VERSION = 2`
  - `payload()` → `{app, version, exportedAt, teams, tasks}` — used by `save()`, `saveToCloud()`, `exportState()`
  - `sanitizeTasks(arr)` → validated array (drops items with a missing/duplicate `id`)
  - `migrateV1(arr)` → BASELINE with `s`/`dur`/`team` overlaid
  - `tasksFromPayload(data)` → task array, or `null` when the payload is unusable
  - All exposed as globals for direct test access.

- [ ] **Step 1: Write the failing tests**

First edit the three existing assertions. In `mockCloud` (`:47-49`), make the version configurable:

```js
async function mockCloud(page, { data = null, fail = false, version = 1 } = {}) {
  await page.route('**/api.jsonbin.io/**', async route => {
    if (fail) { await route.abort('failed'); return; }

    if (route.request().method() === 'GET') {
      const record = data
        ? { app: 'jwx-timeline', version, exportedAt: new Date().toISOString(), teams: [], tasks: data }
        : {};
```

Then `:142`, `expect(data.version).toBe(1)` → `expect(data.version).toBe(2)`. Then replace `save writes tasks to localStorage` (`:255-264`) — `save()` now writes an envelope, not a bare array:

```js
  test('save writes a v2 envelope to localStorage', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await page.click('#save');
    const stored = await page.evaluate(() => localStorage.getItem('jwx_timeline_state_final'));
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored);
    expect(parsed.version).toBe(2);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks).toHaveLength(14);
  });
```

Now append the new describe block:

```js
// ─── Persistence v2 ──────────────────────────────────────────────────────────

const V2 = (tasks) => JSON.stringify({
  app: 'jwx-timeline', version: 2, exportedAt: '2026-08-03T00:00:00.000Z', teams: [], tasks,
});

test.describe('Persistence v2', () => {
  test('a v1 bare array migrates with positions preserved', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('jwx_timeline_state_final',
      JSON.stringify([{ id: 'viewability', s: 7, dur: 6.5, team: 'auction' }])));
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar')).toHaveCount(14);
    const left = await page.locator('.bar[data-id="viewability"]').evaluate(el => el.style.left);
    expect(parseFloat(left)).toBeCloseTo(7 * 88, 0);
    // scope/status come from BASELINE, which v1 never persisted
    await expect(page.locator('.bar[data-id="jwdata"] > .bar-fill.indev')).toHaveCount(1);
  });

  test('a v2 payload is loaded verbatim, including a deleted item', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(v2 => localStorage.setItem('jwx_timeline_state_final', v2), V2([
      { id: 'viewability', name: 'Ad viewability policy setup', team: 'pubmon', s: 3, dur: 6.5, size: 'XL', scope: 'MVP', status: 'done' },
      { id: 'gam', name: 'GAM mediation Spotlight (pre-roll)', team: 'exchange', s: 1, dur: 5.5, size: 'L', scope: 'GA', status: 'planned' },
    ]));
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar')).toHaveCount(2);
    await expect(page.locator('.bar[data-id="playback"]')).toHaveCount(0);
  });

  test('an explicitly empty v2 plan stays empty across reload', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(v2 => localStorage.setItem('jwx_timeline_state_final', v2), V2([]));
    await page.reload();
    await waitForInit(page);
    await expect(page.locator('.bar')).toHaveCount(0);
    await expect(page.locator('#status')).toContainText('No work items');
    await expect(page.locator('#m-mvp')).toHaveText('—');
  });

  test('a corrupt payload falls back to BASELINE', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('jwx_timeline_state_final',
      JSON.stringify({ app: 'jwx-timeline', version: 2, tasks: 'not-an-array' })));
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar')).toHaveCount(14);
  });

  test('a v2 payload whose every item is invalid falls back to BASELINE', async ({ page }) => {
    await page.goto('/');
    // items with no usable id sanitize away — that is corruption, not an empty plan
    await page.evaluate(v2 => localStorage.setItem('jwx_timeline_state_final', v2),
      V2([{ name: 'no id' }, { id: '', name: 'blank id' }]));
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar')).toHaveCount(14);
  });

  test('sanitizeTasks coerces out-of-range and unknown values', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const out = await page.evaluate(() => window.sanitizeTasks([
      { id: 'a', scope: 'nonsense', status: 'wat', dur: -5, s: -3, size: 'XXL' },
      { id: 'b', name: 'ok', team: 'exchange', s: 2, dur: 1.5, size: 'M', scope: 'MVP', status: 'done' },
      { id: 'a', name: 'duplicate id' },
      { name: 'no id at all' },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'a', name: 'Untitled item', team: 'pubmon', s: 0, dur: 1, size: '—', scope: 'GA', status: 'planned' });
    expect(out[1]).toMatchObject({ id: 'b', scope: 'MVP', status: 'done', dur: 1.5 });
  });

  test('a v2 cloud payload is loaded verbatim', async ({ page }) => {
    await mockCloud(page, {
      version: 2,
      data: [{ id: 'solo', name: 'Only item', team: 'auction', s: 4, dur: 2, size: 'M', scope: 'MVP', status: 'done' }],
    });
    await page.goto('/test-index.html');
    await expect(page.locator('#status')).toContainText('Synced from cloud', { timeout: 10_000 });
    await expect(page.locator('.bar')).toHaveCount(1);
    await expect(page.locator('.bar[data-id="solo"] > .bar-fill.done')).toHaveCount(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "Persistence v2"` then `npx playwright test -g "save writes a v2 envelope"`
Expected: failures — `window.sanitizeTasks` is not a function; v2 payloads are misread as v1 and re-expanded to 14 bars; localStorage still holds a bare array.

- [ ] **Step 3: Add the validation and migration functions**

In `index.html`, replace lines 197-219 (from `const KEY=` through the end of `save()`) with:

```js
const KEY='jwx_timeline_state_final';
const SCHEMA_VERSION=2;
const SIZES=['S','M','L','XL','—'];
const SCOPES=['MVP','GA'];
const STATUSES=['planned','in-dev','done'];
const FALLBACK_TEAM='pubmon';
function clone(a){return JSON.parse(JSON.stringify(a));}
function payload(){return {app:'jwx-timeline',version:SCHEMA_VERSION,exportedAt:new Date().toISOString(),
  teams:LANES.filter(l=>l.custom),tasks};}
// Saved state is authoritative from v2 on, so every load path runs through this
// gate — a malformed payload must not be able to break the page.
function sanitizeTasks(arr){
  const seen=new Set(),out=[];
  arr.forEach(x=>{
    if(!x||typeof x.id!=='string'||!x.id||seen.has(x.id))return;
    seen.add(x.id);
    out.push({
      id:x.id,
      name:typeof x.name==='string'&&x.name?x.name:'Untitled item',
      team:typeof x.team==='string'&&x.team?x.team:FALLBACK_TEAM,
      s:Number.isFinite(+x.s)&&+x.s>=0?+x.s:0,
      dur:Number.isFinite(+x.dur)&&+x.dur>=0.5?+x.dur:1,
      size:SIZES.indexOf(x.size)>=0?x.size:'—',
      scope:SCOPES.indexOf(x.scope)>=0?x.scope:'GA',
      status:STATUSES.indexOf(x.status)>=0?x.status:'planned'});
  });
  return out;
}
// v1 only ever persisted s/dur/team, so scope/status come from BASELINE for free.
function migrateV1(arr){return BASELINE.map(b=>{const s=arr.find(x=>x&&x.id===b.id);
  return s?Object.assign(clone(b),{
    s:Number.isFinite(+s.s)?Math.max(0,+s.s):b.s,
    dur:Number.isFinite(+s.dur)?Math.max(0.5,+s.dur):b.dur,
    team:s.team||b.team}):clone(b);});}
// Returns a task array, or null when the payload is unusable and the caller
// should fall back to BASELINE. Note [] is a legitimate return value: an
// explicitly empty v2 plan is respected, while a non-empty payload that
// sanitizes down to nothing is corruption.
function tasksFromPayload(data){
  const arr=Array.isArray(data)?data:(data&&data.tasks);
  if(!Array.isArray(arr))return null;
  const v=Array.isArray(data)?1:(+(data.version)||1);
  // An empty v1 array carries no information — v1 stored overlays only, so it
  // cannot mean "the plan was emptied". That meaning exists only in v2.
  if(v<2)return arr.length?migrateV1(arr):null;
  if(arr.length===0)return [];
  const out=sanitizeTasks(arr);
  return out.length?out:null;
}
function load(){
  try{const r=localStorage.getItem(KEY);
    if(r){const out=tasksFromPayload(JSON.parse(r));
      if(out)return out;}   // [] is truthy — an empty plan is honoured here
  }catch(e){}
  return clone(BASELINE);
}
let tasks=load();
ensureLanes();
function setStatus(txt,state){const el=document.getElementById('status');if(!el)return;
  el.textContent=txt;
  el.style.color=state===true||state==='ok'?'var(--ga-d)':state==='warn'?'#B45309':state==='err'?'var(--err)':'var(--mut)';}
function save(){try{localStorage.setItem(KEY,JSON.stringify(payload()));localStorage.setItem(KEY+'_ts',Date.now());saveTeams();
    if(!cloudEnabled())setStatus('Saved '+new Date().toLocaleTimeString()+' — reloads on refresh',true);}
  catch(e){setStatus('Could not save — browser storage is blocked',false);}
  markDirty();}
```

The original `let tasks=load();` / `ensureLanes();` / `setStatus` / `clone` definitions at lines 198, 211-215 are folded into the block above — do not leave duplicates behind.

- [ ] **Step 4: Point saveToCloud, exportState and importState at the shared helpers**

In `saveToCloud()`, replace the inline payload literal (lines 223-224) with `const p=payload();` and send `JSON.stringify(p)`. In `exportState()` (line 290) replace the inline literal the same way — the export envelope now comes from the same helper, so `version` is `2` in one place only.

**Delete `applyOverlay()` (lines 285-289) entirely** — `tasksFromPayload` supersedes it and nothing else calls it. Then rewrite `importState`:

```js
function importState(file){const fr=new FileReader();
  fr.onload=()=>{try{const data=JSON.parse(fr.result);
    const arr=tasksFromPayload(data);
    if(arr===null)throw 0;
    if(data&&Array.isArray(data.teams)){
      LANES=DEFAULT_LANES.concat(data.teams.filter(t=>t&&t.team).map(t=>Object.assign({},t,{custom:true})));saveTeams();}
    tasks=arr;ensureLanes();render();save();saveToCloud('Imported');setStatus('Imported plan from '+file.name,true);}
    catch(e){setStatus('Import failed — not a valid timeline JSON file',false);}};
  fr.readAsText(file);}
```

- [ ] **Step 5: Update init() for the empty and v2 cases**

Replace `init()` (lines 257-283) with:

```js
async function init(){
  if(!cloudEnabled()){
    let raw=null;try{raw=localStorage.getItem(KEY);}catch(e){}
    if(!tasks.length){setStatus('No work items — add one from a lane, or Reset to baseline',false);return;}
    if(raw){const ts=parseInt(localStorage.getItem(KEY+'_ts'))||0;
      setStatus('Restored your saved edits'+(ts?(' from '+new Date(ts).toLocaleString()):''),true);}
    else setStatus('Baseline plan — every change auto-saves to this browser',false);
    return;
  }
  setStatus('Syncing…');
  const data=await loadFromCloud();
  if(data===null){
    setStatus('⚠ Cloud unavailable — working offline','err');
    return;
  }
  const arr=tasksFromPayload(data);
  if(arr===null){
    setStatus('Baseline plan — cloud storage is empty',false);
    return;
  }
  if(data&&Array.isArray(data.teams)){
    LANES=DEFAULT_LANES.concat(data.teams.filter(t=>t&&t.team).map(t=>Object.assign({},t,{custom:true})));
    saveTeams();
  }
  tasks=arr;ensureLanes();render();
  if(!tasks.length){setStatus('No work items — add one from a lane, or Reset to baseline',false);return;}
  const when=data.exportedAt?(' — '+new Date(data.exportedAt).toLocaleString()):'';
  setStatus('Synced from cloud'+when,'ok');
}
```

An unwritten bin arrives as `{}`, so `tasksFromPayload` returns `null` and the existing `'cloud storage is empty'` message is preserved. A corrupt payload reaches the same branch — the message is imprecise for that case but it keeps the existing assertion at `tests/timeline.spec.js:415` intact, and both outcomes are identical (render BASELINE).

- [ ] **Step 6: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 49 tests. `overlays cloud task positions onto the BASELINE` must still pass: it sends `version:1`, so it exercises `migrateV1` and still yields 14 bars.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "feat: authoritative v2 saved state with validation and v1 migration"
```

---

## Task 3: Status treatments — hatch, fade, check, legend

Applies the approved visual treatment now that `status` classes exist and v2 payloads can seed a done item.

**Files:**
- Modify: `index.html` — CSS after `.bar-label`; HTML `:125-133` (legend); JS `barLabel`
- Test: `tests/timeline.spec.js`

**Interfaces:**
- Consumes: `.bar-fill.done` / `.bar-fill.indev` classes (Task 1), `V2()` test helper (Task 2)
- Produces: `.sw-done` / `.sw-indev` legend swatch classes; `barLabel(t)` prefixes `'✓ '` when done

- [ ] **Step 1: Write the failing tests**

```js
// ─── Status treatments ───────────────────────────────────────────────────────

test.describe('Status treatments', () => {
  test('a done bar keeps full scope colour and gains a hatch', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(v2 => localStorage.setItem('jwx_timeline_state_final', v2), V2([
      { id: 'viewability', name: 'Ad viewability policy setup', team: 'pubmon', s: 3, dur: 6.5, size: 'XL', scope: 'MVP', status: 'done' },
    ]));
    await page.reload();
    await waitForBars(page);
    const fill = page.locator('.bar[data-id="viewability"] > .bar-fill');
    // scope colour is NOT degraded by being done
    expect(await fill.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(91, 81, 198)');
    expect(await fill.evaluate(el => getComputedStyle(el).backgroundImage)).toContain('repeating-linear-gradient');
  });

  test('a done bar label is prefixed with a check', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(v2 => localStorage.setItem('jwx_timeline_state_final', v2), V2([
      { id: 'viewability', name: 'Ad viewability policy setup', team: 'pubmon', s: 3, dur: 6.5, size: 'XL', scope: 'MVP', status: 'done' },
    ]));
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar[data-id="viewability"] > .bar-label')).toContainText('✓');
  });

  test('an in-dev bar is masked but its handle is not', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const fillMask = await page.locator('.bar[data-id="jwdata"] > .bar-fill')
      .evaluate(el => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    expect(fillMask).toContain('linear-gradient');
    const handleMask = await page.locator('.bar[data-id="jwdata"] > .handle')
      .evaluate(el => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    expect(handleMask === 'none' || !handleMask).toBeTruthy();
  });

  test('legend documents both scopes and both progress states', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const legend = page.locator('.legend');
    await expect(legend).toContainText('MVP scope');
    await expect(legend).toContainText('GA scope');
    await expect(legend).toContainText('Done');
    await expect(legend).toContainText('In development');
    await expect(legend.locator('.sw-done')).toHaveCount(1);
    await expect(legend.locator('.sw-indev')).toHaveCount(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "Status treatments"`
Expected: 4 failures — no `background-image` on the fill, no `✓` in the label, `mask-image` is `none`, legend has no `.sw-done`.

- [ ] **Step 3: Add the treatment CSS**

First add the hatch to the `:root` block (after the `--gutter/--weekw/--rowh` line), so the bars and the legend key that documents them cannot drift apart. The file already keeps every colour in `:root`, so this follows the established convention:

```css
    --hatch:repeating-linear-gradient(135deg,rgba(255,255,255,.42) 0,rgba(255,255,255,.42) 3px,transparent 3px,transparent 8px);
```

Then, immediately after the `.bar-label` rule added in Task 1:

```css
  .bar-fill.done{background-image:var(--hatch);}
  .bar-fill.indev{-webkit-mask-image:linear-gradient(to right,#000 0,#000 68%,transparent 100%);
    mask-image:linear-gradient(to right,#000 0,#000 68%,transparent 100%);}
  .sw-done{background:var(--mvp);background-image:var(--hatch);}
  .sw-indev{background:linear-gradient(to right,var(--mvp) 60%,rgba(91,81,198,.15));}
```

- [ ] **Step 4: Add the check prefix to barLabel**

Replace `barLabel` with:

```js
function barLabel(t){const dl=t.dur*WEEKW;const tick=t.status==='done'?'✓ ':'';
  const txt=tick+(t.size!=='—'?(t.size+' · '+durLabel(t)):durLabel(t));
  return dl<70?(tick.trim()+(t.size!=='—'?t.size:'•')):txt;}
```

- [ ] **Step 5: Replace the legend**

Replace lines 125-133 with:

```html
  <div class="legend">
    <div class="it"><span class="sw" style="background:var(--mvp)"></span>MVP scope</div>
    <div class="it"><span class="sw" style="background:var(--ga)"></span>GA scope</div>
    <div class="it"><span class="sw sw-done"></span>Done</div>
    <div class="it"><span class="sw sw-indev"></span>In development</div>
    <div class="it"><span class="sw" style="background:var(--mvp-d)"></span>MVP milestone</div>
    <div class="it"><span class="sw" style="background:var(--ga-d)"></span>GA milestone</div>
    <div class="it">S=1–2 bd · M≈1w · L≈2w · XL≈4w (range 2–6)</div>
  </div>
```

- [ ] **Step 6: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 53 tests.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "feat: hatch done bars and fade in-dev bars, update legend"
```

---

## Task 4: MVP scope toggle

**Files:**
- Modify: `index.html` — CSS after `.tsel`; JS `render()` gutter controls, new `toggleScope()`
- Test: `tests/timeline.spec.js`

**Interfaces:**
- Consumes: `SCOPE`, `tasks`, `render()`, `save()`
- Produces: `toggleScope(id)` global; DOM `.row .gut .ctl > button.mvpbtn[data-id]`, class `on` when scope is MVP

- [ ] **Step 1: Write the failing tests**

```js
// ─── MVP scope toggle ────────────────────────────────────────────────────────

test.describe('MVP scope toggle', () => {
  test('every item row has an MVP toggle reflecting its scope', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await expect(page.locator('.mvpbtn')).toHaveCount(14);
    await expect(page.locator('.mvpbtn[data-id="viewability"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('.mvpbtn[data-id="gam"]')).not.toHaveClass(/\bon\b/);
  });

  test('toggling scope repaints the bar', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await page.click('.mvpbtn[data-id="gam"]');
    await expect(page.locator('.bar[data-id="gam"] > .bar-fill'))
      .toHaveCSS('background-color', 'rgb(91, 81, 198)');
    await expect(page.locator('.mvpbtn[data-id="gam"]')).toHaveClass(/\bon\b/);
  });

  test('deselecting the latest MVP item pulls the MVP date earlier', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    // BASELINE MVP ends: playback 9.5+3.5 = 13 is the latest
    const before = await page.locator('#m-mvp').textContent();
    await page.click('.mvpbtn[data-id="playback"]');
    const after = await page.locator('#m-mvp').textContent();
    expect(after).not.toBe(before);
    // toggling back restores it
    await page.click('.mvpbtn[data-id="playback"]');
    await expect(page.locator('#m-mvp')).toHaveText(before);
  });

  test('scope survives a reload', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await page.click('.mvpbtn[data-id="gam"]');
    await page.click('#save');
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.mvpbtn[data-id="gam"]')).toHaveClass(/\bon\b/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "MVP scope toggle"`
Expected: 4 failures — `.mvpbtn` has count 0.

- [ ] **Step 3: Add the toggle function**

Next to `addTeam`/`removeTeam` in `index.html`:

```js
function toggleScope(id){const t=tasks.find(x=>x.id===id);if(!t)return;
  t.scope=t.scope==='MVP'?'GA':'MVP';render();save();}
```

- [ ] **Step 4: Render the pill**

In `render()`, immediately after `ctl.appendChild(sel);`:

```js
      const mb=document.createElement('button');mb.className='mvpbtn'+(t.scope==='MVP'?' on':'');
      mb.dataset.id=t.id;mb.textContent='MVP';
      mb.title=t.scope==='MVP'?'In MVP scope — click to move to GA':'GA scope — click to add to MVP';
      mb.addEventListener('click',()=>toggleScope(t.id));
      mb.addEventListener('pointerdown',e=>e.stopPropagation());
      ctl.appendChild(mb);
```

- [ ] **Step 5: Add the CSS**

After the `.tsel:hover` rule:

```css
  .mvpbtn{font-size:10px;font-weight:700;letter-spacing:.03em;border-radius:5px;padding:2px 6px;
    border:1px solid var(--mvp);background:var(--bg);color:var(--mvp-d);cursor:pointer;flex:0 0 auto;}
  .mvpbtn.on{background:var(--mvp);color:#fff;}
```

- [ ] **Step 6: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 57 tests.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "feat: per-item MVP scope toggle"
```

---

## Task 5: Status cycle pill

**Files:**
- Modify: `index.html` — CSS after `.mvpbtn.on`; JS `render()` gutter controls, new `cycleStatus()`
- Test: `tests/timeline.spec.js`

**Interfaces:**
- Consumes: `STATUSES` (Task 2), `render()`, `save()`
- Produces: `cycleStatus(id)` global; `STATUS_NEXT`, `STATUS_LABEL` maps; DOM `button.statbtn[data-id]`

- [ ] **Step 1: Write the failing tests**

```js
// ─── Status cycle ────────────────────────────────────────────────────────────

test.describe('Status cycle', () => {
  test('the pill shows the current status', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await expect(page.locator('.statbtn')).toHaveCount(14);
    await expect(page.locator('.statbtn[data-id="jwdata"]')).toHaveText('in dev');
    await expect(page.locator('.statbtn[data-id="viewability"]')).toHaveText('planned');
  });

  test('clicking cycles planned to in dev to done and back', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const pill = page.locator('.statbtn[data-id="viewability"]');
    await pill.click();
    await expect(pill).toHaveText('in dev');
    await pill.click();
    await expect(pill).toHaveText('done');
    await expect(page.locator('.bar[data-id="viewability"] > .bar-fill.done')).toHaveCount(1);
    await pill.click();
    await expect(pill).toHaveText('planned');
  });

  test('marking the latest MVP item done does NOT move the MVP date', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const before = await page.locator('#m-mvp').textContent();
    const gaBefore = await page.locator('#m-ga').textContent();
    const pill = page.locator('.statbtn[data-id="playback"]');
    await pill.click();
    await pill.click();
    await expect(pill).toHaveText('done');
    await expect(page.locator('#m-mvp')).toHaveText(before);
    await expect(page.locator('#m-ga')).toHaveText(gaBefore);
  });

  test('done state survives a reload', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const pill = page.locator('.statbtn[data-id="gam"]');
    await pill.click();
    await pill.click();
    await page.click('#save');
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.statbtn[data-id="gam"]')).toHaveText('done');
    await expect(page.locator('.bar[data-id="gam"] > .bar-fill.done')).toHaveCount(1);
  });

  test('a done bar is still draggable', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    const pill = page.locator('.statbtn[data-id="gam"]');
    await pill.click();
    await pill.click();
    const bar = page.locator('.bar[data-id="gam"]');
    const before = parseFloat(await bar.evaluate(el => el.style.left));
    const box = await bar.boundingBox();
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 20 + 88, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = parseFloat(await page.locator('.bar[data-id="gam"]').evaluate(el => el.style.left));
    expect(after).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "Status cycle"`
Expected: 5 failures — `.statbtn` has count 0.

- [ ] **Step 3: Add the cycle function**

Next to `toggleScope`:

```js
const STATUS_NEXT={planned:'in-dev','in-dev':'done',done:'planned'};
const STATUS_LABEL={planned:'planned','in-dev':'in dev',done:'done'};
function cycleStatus(id){const t=tasks.find(x=>x.id===id);if(!t)return;
  t.status=STATUS_NEXT[t.status]||'planned';render();save();}
```

- [ ] **Step 4: Render the pill**

In `render()`, immediately after `ctl.appendChild(mb);`:

```js
      const sb=document.createElement('button');sb.className='statbtn '+(t.status==='in-dev'?'indev':t.status);
      sb.dataset.id=t.id;sb.textContent=STATUS_LABEL[t.status]||t.status;
      sb.title='Progress: '+(STATUS_LABEL[t.status]||t.status)+' — click to advance';
      sb.addEventListener('click',()=>cycleStatus(t.id));
      sb.addEventListener('pointerdown',e=>e.stopPropagation());
      ctl.appendChild(sb);
```

- [ ] **Step 5: Add the CSS**

```css
  .statbtn{font-size:10px;border-radius:5px;padding:2px 6px;cursor:pointer;flex:0 0 auto;
    border:1px solid var(--line);background:var(--bg);color:var(--mut);min-width:46px;}
  .statbtn.indev{border-color:var(--dev);color:var(--dev-d);background:#FDF3E3;}
  .statbtn.done{border-color:var(--done);color:var(--done-d);background:#F0F7E6;}
```

- [ ] **Step 6: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 62 tests.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "feat: cycling status pill for planned / in dev / done"
```

---

## Task 6: Delete work items

**Files:**
- Modify: `index.html` — CSS after `.statbtn.done`; JS `render()` gutter controls, new `removeTask()`
- Test: `tests/timeline.spec.js`

**Interfaces:**
- Consumes: `tasks`, `render()`, `save()`, `setStatus()`
- Produces: `removeTask(id)` global; DOM `button.irm[data-id]` (deliberately **not** `.lrm`)

- [ ] **Step 1: Write the failing tests**

```js
// ─── Delete items ────────────────────────────────────────────────────────────

test.describe('Delete work items', () => {
  test('confirming removes the item', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.accept());
    await page.click('.irm[data-id="midrolls"]');
    await expect(page.locator('.bar')).toHaveCount(13);
    await expect(page.locator('.bar[data-id="midrolls"]')).toHaveCount(0);
  });

  test('dismissing the confirm keeps the item', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.dismiss());
    await page.click('.irm[data-id="midrolls"]');
    await page.waitForTimeout(300);
    await expect(page.locator('.bar')).toHaveCount(14);
  });

  test('a deleted item stays deleted after reload', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.accept());
    await page.click('.irm[data-id="midrolls"]');
    await page.click('#save');
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar')).toHaveCount(13);
    await expect(page.locator('.bar[data-id="midrolls"]')).toHaveCount(0);
  });

  test('the item delete button does not collide with the team one', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    // .lrm belongs to lane headers only; item rows use .irm
    await expect(page.locator('.row .gut .lrm')).toHaveCount(0);
    await expect(page.locator('.lhead .irm')).toHaveCount(0);
  });

  test('deleting every item leaves a working empty page that survives reload', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(v2 => localStorage.setItem('jwx_timeline_state_final', v2), V2([
      { id: 'solo', name: 'Last one', team: 'auction', s: 0, dur: 1, size: 'M', scope: 'GA', status: 'planned' },
    ]));
    await page.reload();
    await waitForBars(page);
    page.once('dialog', d => d.accept());
    await page.click('.irm[data-id="solo"]');
    await expect(page.locator('.bar')).toHaveCount(0);
    await expect(page.locator('#m-mvp')).toHaveText('—');
    await expect(page.locator('#m-ga')).toHaveText('—');
    await page.click('#save');
    await page.reload();
    await waitForInit(page);
    await expect(page.locator('.bar')).toHaveCount(0);   // BASELINE must NOT come back
    await expect(page.locator('#status')).toContainText('No work items');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "Delete work items"`
Expected: 5 failures — `.irm` does not exist, so the clicks time out.

- [ ] **Step 3: Add the delete function**

Next to `cycleStatus`:

```js
function removeTask(id){const t=tasks.find(x=>x.id===id);if(!t)return;
  if(!window.confirm('Delete "'+t.name+'"? This cannot be undone.'))return;
  tasks=tasks.filter(x=>x.id!==id);
  render();save();setStatus('Deleted “'+t.name+'”',true);}
```

- [ ] **Step 4: Render the button**

In `render()`, after `g.appendChild(ctl);` add the button to `ctl` first — insert immediately after `ctl.appendChild(bd);`:

```js
      const rm=document.createElement('button');rm.className='irm';rm.dataset.id=t.id;
      rm.textContent='✕';rm.title='Delete this work item';
      rm.addEventListener('click',()=>removeTask(t.id));
      rm.addEventListener('pointerdown',e=>e.stopPropagation());
      ctl.appendChild(rm);
```

- [ ] **Step 5: Add the CSS**

```css
  .irm{cursor:pointer;color:#A32D2D;font-weight:600;font-size:12px;border:none;
    background:transparent;padding:0 2px;flex:0 0 auto;}
  .irm:hover{color:#791F1F;}
```

- [ ] **Step 6: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 67 tests. Confirm `empty custom lane can be removed` still passes — it locates `.lrm` inside `.lhead`, which item buttons never touch.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "feat: delete work items with confirmation"
```

---

## Task 7: Add work items per lane

**Files:**
- Modify: `index.html` — CSS after `.irm:hover`; JS `render()` lane header, new `addTask()`
- Test: `tests/timeline.spec.js`

**Interfaces:**
- Consumes: `tasks`, `LANES`, `slugify()`, `render()`, `save()`, `setStatus()`
- Produces: `addTask(team)` global; DOM `button.ladd[data-team]` inside `.lhead .gut`

- [ ] **Step 1: Write the failing tests**

```js
// ─── Add work items ──────────────────────────────────────────────────────────

test.describe('Add work items', () => {
  test('every assignable lane has an add button, inflight does not', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    await expect(page.locator('.ladd')).toHaveCount(3);
    await expect(page.locator('.ladd[data-team="inflight"]')).toHaveCount(0);
    await expect(page.locator('.ladd[data-team="exchange"]')).toHaveCount(1);
  });

  test('adding puts the item in the clicked lane with GA / planned defaults', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.accept('Brand safety controls'));
    await page.click('.ladd[data-team="auction"]');
    await expect(page.locator('.bar')).toHaveCount(15);
    const row = page.locator('.lane[data-team="auction"] .row', { hasText: 'Brand safety controls' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.statbtn')).toHaveText('planned');
    await expect(row.locator('.mvpbtn')).not.toHaveClass(/\bon\b/);
  });

  test('the new bar starts at or after the lane last bar end', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    // auction holds only preroll: s=12 dur=2 → new item starts at week 14
    page.once('dialog', d => d.accept('Follow up work'));
    await page.click('.ladd[data-team="auction"]');
    const id = await page.locator('.lane[data-team="auction"] .bar').last().getAttribute('data-id');
    const left = await page.locator(`.bar[data-id="${id}"]`).evaluate(el => el.style.left);
    expect(parseFloat(left)).toBeCloseTo(14 * 88, 0);
  });

  test('dismissing the prompt adds nothing', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.dismiss());
    await page.click('.ladd[data-team="exchange"]');
    await page.waitForTimeout(300);
    await expect(page.locator('.bar')).toHaveCount(14);
  });

  test('an added item survives a reload', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.accept('Persisted item'));
    await page.click('.ladd[data-team="exchange"]');
    await page.click('#save');
    await page.reload();
    await waitForBars(page);
    await expect(page.locator('.bar')).toHaveCount(15);
    await expect(page.locator('.lane[data-team="exchange"] .row', { hasText: 'Persisted item' })).toHaveCount(1);
  });

  test('two items with the same name get distinct ids', async ({ page }) => {
    await page.goto('/');
    await waitForBars(page);
    page.once('dialog', d => d.accept('Same name'));
    await page.click('.ladd[data-team="exchange"]');
    page.once('dialog', d => d.accept('Same name'));
    await page.click('.ladd[data-team="exchange"]');
    await expect(page.locator('.bar')).toHaveCount(16);
    const ids = await page.locator('.bar').evaluateAll(els => els.map(e => e.dataset.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test -g "Add work items"`
Expected: 6 failures — `.ladd` has count 0.

- [ ] **Step 3: Add the function**

Next to `removeTask`:

```js
function addTask(team){
  const name=(window.prompt('New work item name:')||'').trim(); if(!name)return;
  const ids=new Set(tasks.map(t=>t.id)); let base='i-'+slugify(name),id=base,i=2;
  while(ids.has(id)){id=base+'-'+(i++);}
  const inLane=tasks.filter(t=>t.team===team);
  const s=inLane.length?Math.max(...inLane.map(t=>t.s+t.dur)):0;
  tasks.push({id,name,team,s,dur:1,size:'M',scope:'GA',status:'planned'});
  render();save();setStatus('Added “'+name+'” — drag it into place',true);
}
```

- [ ] **Step 4: Render the button in the lane header gutter**

In `render()`, inside the `LANES.forEach` block, immediately after the `.lrm` block (`if(L.custom){…}`) and before `const lb=document.createElement('div');lb.className='band';`:

```js
    if(L.team!=='inflight'){
      const ad=document.createElement('button');ad.className='ladd';ad.dataset.team=L.team;
      ad.textContent='+ item';ad.title='Add a work item to this team';
      ad.addEventListener('click',()=>addTask(L.team));
      lg.appendChild(ad);
    }
```

`lg` is the lane header gutter, which is sticky, so the button stays visible when the timeline is scrolled horizontally. It must not go in `lb` (`.band`): that scrolls, and a sticky button there would slide under the 310px gutter at `z-index:6`.

- [ ] **Step 5: Add the CSS**

```css
  .ladd{margin-left:auto;font-size:10px;padding:1px 6px;border-radius:5px;cursor:pointer;flex:0 0 auto;
    border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.72);color:inherit;}
  .ladd:hover{background:#fff;}
```

`.lrm` already uses `margin-left:auto`; on custom lanes both buttons sit at the right of the gutter in DOM order (`✕` then `+ item`) with only the first taking the auto margin, which reads correctly.

- [ ] **Step 6: Run the full suite**

Run: `npx playwright test`
Expected: PASS — 73 tests.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/timeline.spec.js
git commit -m "feat: add work items per lane"
```

---

## Task 8: Verify the deployment path

No new behaviour — confirms the change is safe to ship given the workflow rewrites `index.html` before publishing.

**Files:**
- Verify only: `index.html`, `.github/workflows/deploy.yml`, `tests/global-setup.js`

**Interfaces:**
- Consumes: everything from Tasks 1-7
- Produces: nothing

- [ ] **Step 1: Confirm the credential placeholders are still exact literals**

Run: `grep -n "YOUR_BIN_ID_HERE\|YOUR_API_KEY_HERE" index.html`
Expected: exactly two matches, in the form `const CLOUD_BIN_ID  = 'YOUR_BIN_ID_HERE';` and `const CLOUD_API_KEY = 'YOUR_API_KEY_HERE';`. The workflow and `tests/global-setup.js` both substitute these by exact string match — if either drifted, cloud sync silently breaks in production.

- [ ] **Step 2: Confirm no leftover references to the removed model**

Run: `grep -n "TYPE\[\|t\.type\|\.mvp\b\|LOCKED\|m-depchip\|applyOverlay\|violation" index.html`
Expected: no output. Any hit is dead code or a missed rename from Task 1 or 2.

- [ ] **Step 3: Confirm the full suite is green from a clean state**

Run: `rm -rf test-results playwright-report && npx playwright test`
Expected: PASS — 73 tests, 0 failures.

- [ ] **Step 4: Commit any cleanup**

If steps 1-3 required no edits, skip this step. Otherwise:

```bash
git add index.html
git commit -m "fix: remove leftover references to the pre-v2 item model"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Data model, baseline mapping, incidental cleanups (`LOCKED`, badge) | 1 |
| Payload v2, `sanitizeTasks`, load path, empty-is-legal, migration, deploy-day | 2 |
| Bar layer split, hatch/fade treatments, `barLabel`, legend | 1 (structure) + 3 (visuals) |
| Row gutter: MVP pill | 4 |
| Row gutter: status pill | 5 |
| Row gutter: delete `✕` | 6 |
| Adding items per lane | 7 |
| Milestone maths (`scope==='MVP'`, done is inert) | 1, asserted again in 5 |
| Removals (dep chip, `.violation`, `.chip.dep`, footnote) | 1, verified in 8 |
| Test edits (`version` → 2, `mockCloud` v2 shape, export field assertions) | 2 |

**Placeholder scan** — no TBD/TODO. Every code step carries the literal code. Every test step carries the literal test. No step says "handle edge cases" without naming them: validation is the explicit table in Task 2 Step 3; the empty-vs-corrupt distinction is Task 2 Step 3's `tasksFromPayload` and Task 6's last test.

**Type consistency** — names used across tasks, all defined where first introduced: `SCOPE` (1), `SIZES`/`SCOPES`/`STATUSES`/`FALLBACK_TEAM`/`SCHEMA_VERSION`/`payload()`/`sanitizeTasks()`/`migrateV1()`/`tasksFromPayload()` (2), `STATUS_NEXT`/`STATUS_LABEL`/`cycleStatus()` (5), `toggleScope()` (4), `removeTask()` (6), `addTask()` (7). DOM contracts: `.bar-fill`/`.bar-label`/`.handle` (1), `.sw-done`/`.sw-indev` (3), `.mvpbtn`+`.on` (4), `.statbtn` (5), `.irm` (6), `.ladd` (7). The `V2()` test helper is defined in Task 2 and reused in Tasks 3 and 6 — Task 2 must land first.

Cumulative test counts assume tasks run in order: 42 → 49 → 53 → 57 → 62 → 67 → 73.
