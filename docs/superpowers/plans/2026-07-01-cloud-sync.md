# Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JSONBin-backed cloud persistence to `index.html` so the timeline syncs across devices on refresh, with auto-save every 60 seconds and manual "Save now" support.

**Architecture:** A thin sync layer (~80 lines) is added inside the existing `<script>` block. On load the page renders immediately from `localStorage`, then silently re-renders from JSONBin if cloud is configured. All writes go to `localStorage` immediately (existing behaviour) and to JSONBin either on demand (manual save) or via a 60-second throttled auto-save timer. No new files are created.

**Tech Stack:** Vanilla JS (`fetch` API), JSONBin.io v3 REST API, `localStorage` (existing)

## Global Constraints

- Single HTML file — all changes are inside the `<script>` block of `index.html`
- No build system, no npm, no external scripts
- JSONBin v3 API base URL: `https://api.jsonbin.io/v3/b/`
- Auth header: `X-Master-Key: <api_key>`
- GET endpoint: `https://api.jsonbin.io/v3/b/{BIN_ID}/latest` — response shape: `{ record: {...}, metadata: {...} }`
- PUT endpoint: `https://api.jsonbin.io/v3/b/{BIN_ID}` — body is the raw JSON payload
- Cloud sync is a no-op when either config constant equals its placeholder string — existing behaviour is fully preserved
- `localStorage` remains the offline cache; cloud is the cross-device source of truth
- Last-write-wins conflict strategy (no merge)

---

## File Map

| File | Change |
|---|---|
| `index.html` | All changes — `<script>` block only |

---

### Task 1: Config constants, state variables, and `setStatus()` colour update

**Files:**
- Modify: `index.html` — `<script>` block, top section and `setStatus()` function

**Interfaces:**
- Produces: `CLOUD_BIN_ID` (string const), `CLOUD_API_KEY` (string const), `cloudEnabled()` → boolean, `isDirty` (let boolean), `autoSaveTimer` (let number|null), updated `setStatus(txt, state)` where state accepts `true|false|'ok'|'warn'|'err'`

- [ ] **Step 1: Add config constants and state variables**

Open `index.html`. Locate this line near the top of the `<script>` block (right after the CSS property reading lines):

```js
const _cs=getComputedStyle(document.documentElement);
const _n=(k,d)=>{const v=parseFloat(_cs.getPropertyValue(k));return v||d;};
const WEEKW=_n('--weekw',88), GUT=_n('--gutter',310), ROWH=_n('--rowh',60), LHEAD=30, HEADER=54;
```

Insert after those three lines:

```js
const CLOUD_BIN_ID  = 'YOUR_BIN_ID_HERE';
const CLOUD_API_KEY = 'YOUR_API_KEY_HERE';
function cloudEnabled(){return CLOUD_BIN_ID!=='YOUR_BIN_ID_HERE'&&CLOUD_API_KEY!=='YOUR_API_KEY_HERE';}
let isDirty=false, autoSaveTimer=null;
```

- [ ] **Step 2: Update `setStatus()` to support amber (warn) and red (err) states**

Find the existing `setStatus` function:

```js
function setStatus(txt,ok){const el=document.getElementById('status');if(!el)return;
  el.textContent=txt;el.style.color=ok?'var(--ga-d)':'var(--mut)';}
```

Replace it with:

```js
function setStatus(txt,state){const el=document.getElementById('status');if(!el)return;
  el.textContent=txt;
  el.style.color=state===true||state==='ok'?'var(--ga-d)':state==='warn'?'#B45309':state==='err'?'var(--err)':'var(--mut)';}
```

This is backward-compatible: all existing `setStatus(txt, true)` and `setStatus(txt, false)` calls continue to work unchanged.

- [ ] **Step 3: Verify no behaviour change with placeholder keys**

Open `index.html` in a browser. The page should load exactly as before:
- Status bar reads "Baseline plan — every change auto-saves to this browser" (or "Restored your saved edits…" if localStorage has data)
- Dragging, saving, resetting all work
- No console errors

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add cloud sync config constants and setStatus colour states"
```

---

### Task 2: `saveToCloud()` + updated "Save now" button

**Files:**
- Modify: `index.html` — add `saveToCloud()` function, update `save()`, update "Save now" listener

**Interfaces:**
- Consumes: `CLOUD_BIN_ID`, `CLOUD_API_KEY`, `cloudEnabled()`, `isDirty`, `autoSaveTimer`, `tasks`, `LANES`, `setStatus()`
- Produces: `saveToCloud()` → `Promise<void>`

- [ ] **Step 1: Add `saveToCloud()` after the `save()` function**

Find the existing `save()` function:

```js
function save(){try{localStorage.setItem(KEY,JSON.stringify(tasks));localStorage.setItem(KEY+'_ts',Date.now());saveTeams();
    setStatus('Saved '+new Date().toLocaleTimeString()+' — reloads on refresh',true);}
  catch(e){setStatus('Could not save — browser storage is blocked',false);}}
```

Replace it with this updated `save()` that skips the status message when cloud is active (cloud save will set it), then add `saveToCloud()` immediately after:

```js
function save(){try{localStorage.setItem(KEY,JSON.stringify(tasks));localStorage.setItem(KEY+'_ts',Date.now());saveTeams();
    if(!cloudEnabled())setStatus('Saved '+new Date().toLocaleTimeString()+' — reloads on refresh',true);}
  catch(e){setStatus('Could not save — browser storage is blocked',false);}}
async function saveToCloud(label){
  if(!cloudEnabled())return;
  setStatus('Saving to cloud…');
  const payload={app:'jwx-timeline',version:1,exportedAt:new Date().toISOString(),
    teams:LANES.filter(l=>l.custom),tasks};
  try{
    const r=await fetch('https://api.jsonbin.io/v3/b/'+CLOUD_BIN_ID,{
      method:'PUT',
      headers:{'Content-Type':'application/json','X-Master-Key':CLOUD_API_KEY},
      body:JSON.stringify(payload)});
    if(!r.ok)throw new Error('HTTP '+r.status);
    isDirty=false;
    if(autoSaveTimer){clearTimeout(autoSaveTimer);autoSaveTimer=null;}
    setStatus((label||'Saved to cloud')+' '+new Date().toLocaleTimeString(),'ok');
  }catch(e){
    setStatus('⚠ Cloud save failed — try Save now','err');
  }
}
```

- [ ] **Step 2: Update the "Save now" button listener**

Find:

```js
document.getElementById('save').addEventListener('click',save);
```

Replace with:

```js
document.getElementById('save').addEventListener('click',async()=>{
  if(autoSaveTimer){clearTimeout(autoSaveTimer);autoSaveTimer=null;}
  save();
  await saveToCloud();
});
```

- [ ] **Step 3: Test with placeholder keys (cloud disabled)**

Open the page. Click "Save now". Status should show "Saved HH:MM — reloads on refresh" (the old message). No console errors. Behaviour unchanged.

- [ ] **Step 4: Test with real JSONBin keys**

To get real keys:
1. Create a free account at https://jsonbin.io
2. Dashboard → API Keys → copy your Master Key
3. Create a New Bin with content `{}` → copy the Bin ID
4. In `index.html`, replace `'YOUR_BIN_ID_HERE'` and `'YOUR_API_KEY_HERE'` with the real values

Reload the page, make a small change (move a bar), click "Save now". Expected:
- Status briefly shows "Saving to cloud…"
- Status changes to "Saved to cloud HH:MM" in green
- In the JSONBin dashboard, the bin now contains the full tasks JSON

- [ ] **Step 5: Test save failure**

Temporarily set `CLOUD_API_KEY` to an invalid value. Click "Save now". Expected:
- Status shows "⚠ Cloud save failed — try Save now" in red

Restore the real key.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: add saveToCloud() and wire Save Now button to JSONBin PUT"
```

---

### Task 3: `loadFromCloud()` + async `init()` + cloud-aware reset

**Files:**
- Modify: `index.html` — add `loadFromCloud()`, add `init()`, replace bottom-of-script IIFE, update reset button listener

**Interfaces:**
- Consumes: `CLOUD_BIN_ID`, `CLOUD_API_KEY`, `cloudEnabled()`, `applyOverlay()`, `load()`, `ensureLanes()`, `render()`, `setStatus()`, `saveToCloud()`, `LANES`, `DEFAULT_LANES`, `saveTeams()`, `KEY`
- Produces: `loadFromCloud()` → `Promise<object|null>`, `init()` → `Promise<void>`

- [ ] **Step 1: Add `loadFromCloud()` after `saveToCloud()`**

```js
async function loadFromCloud(){
  if(!cloudEnabled())return null;
  try{
    const r=await fetch('https://api.jsonbin.io/v3/b/'+CLOUD_BIN_ID+'/latest',{
      headers:{'X-Master-Key':CLOUD_API_KEY}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const envelope=await r.json();
    return envelope.record||envelope;
  }catch(e){return null;}
}
```

`null` means the request failed (network error, bad key, timeout). The caller distinguishes "empty bin" from "fetch failed" by checking the shape of the returned object.

- [ ] **Step 2: Add `init()` after `loadFromCloud()`**

```js
async function init(){
  if(!cloudEnabled()){
    let raw=null;try{raw=localStorage.getItem(KEY);}catch(e){}
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
  const arr=Array.isArray(data)?data:(data&&data.tasks);
  if(!Array.isArray(arr)||!arr.length){
    setStatus('Baseline plan — cloud storage is empty');
    return;
  }
  if(data&&Array.isArray(data.teams)){
    LANES=DEFAULT_LANES.concat(data.teams.filter(t=>t&&t.team).map(t=>Object.assign({},t,{custom:true})));
    saveTeams();
  }
  tasks=applyOverlay(arr);ensureLanes();render();
  const when=data.exportedAt?(' — '+new Date(data.exportedAt).toLocaleString()):'';
  setStatus('Synced from cloud'+when,'ok');
}
```

Key behaviour:
- Cloud disabled → restore existing localStorage status message
- `data === null` → fetch failed → offline fallback (tasks already rendered from localStorage before `init()`)
- Empty bin → keep localStorage render, inform user
- Valid cloud data → re-render from cloud, show sync timestamp

- [ ] **Step 3: Replace the bottom-of-script init block**

Find the current bottom of the `<script>` block:

```js
document.getElementById('save').addEventListener('click',async()=>{
  if(autoSaveTimer){clearTimeout(autoSaveTimer);autoSaveTimer=null;}
  save();
  await saveToCloud();
});
document.getElementById('export').addEventListener('click',exportState);
document.getElementById('import').addEventListener('click',()=>document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change',e=>{const f=e.target.files[0];if(f)importState(f);e.target.value='';});
document.getElementById('addteam').addEventListener('click',addTeam);
document.getElementById('reset').addEventListener('click',()=>{tasks=clone(BASELINE);LANES=DEFAULT_LANES.slice();clearSaved();
  try{localStorage.removeItem(TEAMKEY);}catch(e){}render();
  setStatus('Reset to baseline — saved edits & added teams cleared',false);});
render();
(function(){let raw=null;try{raw=localStorage.getItem(KEY);}catch(e){}
  if(raw){const ts=parseInt(localStorage.getItem(KEY+'_ts'))||0;
    setStatus('Restored your saved edits'+(ts?(' from '+new Date(ts).toLocaleString()):''),true);}
  else setStatus('Baseline plan — every change auto-saves to this browser',false);})();
```

Replace it entirely with:

```js
document.getElementById('save').addEventListener('click',async()=>{
  if(autoSaveTimer){clearTimeout(autoSaveTimer);autoSaveTimer=null;}
  save();
  await saveToCloud();
});
document.getElementById('export').addEventListener('click',exportState);
document.getElementById('import').addEventListener('click',()=>document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change',e=>{const f=e.target.files[0];if(f)importState(f);e.target.value='';});
document.getElementById('addteam').addEventListener('click',addTeam);
document.getElementById('reset').addEventListener('click',async()=>{
  tasks=clone(BASELINE);LANES=DEFAULT_LANES.slice();clearSaved();
  try{localStorage.removeItem(TEAMKEY);}catch(e){}
  render();
  if(cloudEnabled()){await saveToCloud();}
  else{setStatus('Reset to baseline — saved edits & added teams cleared',false);}
});
render();
init();
```

Note: `render()` runs synchronously first (shows localStorage data immediately). `init()` runs async after — if cloud has data, it re-renders silently. This prevents a blank page during the cloud fetch.

- [ ] **Step 4: Test — cloud disabled (placeholder keys)**

Open the page. Should behave identically to before this task. Status shows the existing localStorage-based message. No console errors.

- [ ] **Step 5: Test — cloud enabled, first open**

With real keys and a bin that has saved data: open the page. Expected:
- Page briefly shows localStorage data with status "Syncing…"
- Within ~500ms, page re-renders with cloud data and shows "Synced from cloud — [timestamp]" in green

- [ ] **Step 6: Test — cloud enabled, offline fallback**

Disconnect from the internet (or set an invalid Bin ID temporarily). Open the page. Expected:
- Page renders from localStorage
- Status shows "⚠ Cloud unavailable — working offline" in red

- [ ] **Step 7: Test — reset pushes to cloud**

Click "↺ Reset to baseline". Expected:
- Page resets to baseline
- Status shows "Saved to cloud HH:MM" (the cloud was updated with the baseline)
- Open a second browser tab, refresh it — it should also show the baseline

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: add loadFromCloud(), async init(), and cloud-aware reset"
```

---

### Task 4: `markDirty()` + 60-second auto-save timer

**Files:**
- Modify: `index.html` — add `markDirty()`, update `save()`, update `addTeam()`, update `removeTeam()`

**Interfaces:**
- Consumes: `cloudEnabled()`, `isDirty`, `autoSaveTimer`, `saveToCloud()`, `setStatus()`
- Produces: `markDirty()` → void (starts or no-ops the 60s cloud flush timer)

- [ ] **Step 1: Add `markDirty()` after `saveToCloud()`**

```js
function markDirty(){
  if(!cloudEnabled())return;
  isDirty=true;
  setStatus('● Unsaved changes','warn');
  if(!autoSaveTimer)autoSaveTimer=setTimeout(async()=>{
    autoSaveTimer=null;
    if(isDirty)await saveToCloud('Auto-saved');
  },60000);
}
```

Behaviour:
- No-op when cloud is disabled (localStorage-only mode unchanged)
- Sets `isDirty = true` and shows amber "● Unsaved changes"
- Starts a 60-second timer only if one isn't already running
- When the timer fires: if still dirty, pushes to cloud (which clears `isDirty` and updates status)
- `saveToCloud()` already cancels `autoSaveTimer` and clears `isDirty` on success — so manual "Save now" cleanly pre-empts the timer

- [ ] **Step 2: Wire `markDirty()` into `save()`**

Find the updated `save()` from Task 2:

```js
function save(){try{localStorage.setItem(KEY,JSON.stringify(tasks));localStorage.setItem(KEY+'_ts',Date.now());saveTeams();
    if(!cloudEnabled())setStatus('Saved '+new Date().toLocaleTimeString()+' — reloads on refresh',true);}
  catch(e){setStatus('Could not save — browser storage is blocked',false);}}
```

Replace with:

```js
function save(){try{localStorage.setItem(KEY,JSON.stringify(tasks));localStorage.setItem(KEY+'_ts',Date.now());saveTeams();
    if(!cloudEnabled())setStatus('Saved '+new Date().toLocaleTimeString()+' — reloads on refresh',true);}
  catch(e){setStatus('Could not save — browser storage is blocked',false);}
  markDirty();}
```

This covers every existing call path that already calls `save()`: drag end, team dropdown change, and import.

- [ ] **Step 3: Wire `markDirty()` into `addTeam()` and `removeTeam()`**

These two functions mutate `LANES` and call `saveTeams()` but do NOT call `save()`, so they need `markDirty()` added explicitly.

Find `addTeam()`:

```js
  LANES.push({team:id, short:name, label:'Team '+name, fill:pal.fill, ink:pal.ink, custom:true});
  saveTeams(); render(); setStatus('Added team "'+name+'" — pick it from any item\'s dropdown',true);
}
```

Replace that last line inside the function:

```js
  LANES.push({team:id, short:name, label:'Team '+name, fill:pal.fill, ink:pal.ink, custom:true});
  saveTeams(); render(); setStatus('Added team "'+name+'" — pick it from any item\'s dropdown',true);
  markDirty();
}
```

Find `removeTeam()`:

```js
  LANES=LANES.filter(l=>l.team!==id); saveTeams(); render(); setStatus('Team removed',true);
}
```

Replace:

```js
  LANES=LANES.filter(l=>l.team!==id); saveTeams(); render(); setStatus('Team removed',true);
  markDirty();
}
```

- [ ] **Step 4: Test — "● Unsaved changes" appears on drag**

With real keys configured, open the page, drag a bar. Expected:
- Status immediately shows "● Unsaved changes" in amber
- No cloud save fires during the drag

- [ ] **Step 5: Test — "Save now" pre-empts the timer**

Drag a bar (status shows "● Unsaved changes"), then immediately click "Save now". Expected:
- Status shows "Saving to cloud…" then "Saved to cloud HH:MM"
- The 60-second timer is cancelled (you won't see a second "Saved to cloud" message 60s later)

- [ ] **Step 6: Test — auto-save fires after 60 seconds**

Drag a bar and wait without clicking "Save now". Expected after ~60 seconds:
- Status changes from "● Unsaved changes" to "Saved to cloud HH:MM" (or "Auto-saved HH:MM")
- In another browser tab (or device), refreshing the page shows the updated bar position

To verify without waiting 60s during development, temporarily change `60000` to `5000` in `markDirty()`, test, then restore it to `60000`.

- [ ] **Step 7: Test — team add/remove triggers dirty**

Add a new team via "+ Add team". Expected: status shows "● Unsaved changes" after the "Added team…" message briefly appears. (The `setStatus` in `addTeam()` fires first, then `markDirty()` overwrites it — the amber dot confirms dirty state was set. This is expected.)

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: add markDirty() with 60s auto-save timer, wire to all mutation points"
```

---

## End-to-End Verification

After all four tasks are complete, run this full scenario:

1. Open the page on Device A (or Browser Tab A). Make a change. See "● Unsaved changes".
2. Click "Save now". See "Saved to cloud HH:MM".
3. Open the page on Device B (or Browser Tab B, incognito). See "Syncing…" then "Synced from cloud — [timestamp]" with Device A's changes visible.
4. On Device B, make a different change. Wait 60 seconds. See "Auto-saved HH:MM".
5. Refresh Device A. See Device B's changes.
6. Click "↺ Reset to baseline" on either device. Refresh the other — it should also show baseline.
7. Disconnect from the internet on either device. Reload. See "⚠ Cloud unavailable — working offline". Reconnect, reload — see "Synced from cloud" again.
