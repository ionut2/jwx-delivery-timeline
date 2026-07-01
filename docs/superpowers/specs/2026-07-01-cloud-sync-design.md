# Cloud Sync — Design Spec
**Date:** 2026-07-01  
**Project:** JWX Delivery Timeline (`index.html`)  
**Status:** Approved

---

## Goal

Make the timeline plan portable across devices. Any team member who opens the hosted page sees the same data. Edits made on one machine are visible on any other machine after a page refresh.

---

## Constraints

- Single self-contained HTML file — no build system, no bundler
- Static hosting only (no server component)
- Open access: anyone with the URL can view and edit
- Sync on refresh (not real-time / WebSocket)
- Small team, single shared plan

---

## Backend: JSONBin.io

Free JSON document hosting. One "bin" = one JSON document with a stable URL.

- **Read:** `GET https://api.jsonbin.io/v3/b/{BIN_ID}/latest`
- **Write:** `PUT https://api.jsonbin.io/v3/b/{BIN_ID}`
- **Auth:** `X-Master-Key` header (API key scoped to the bin)
- **Conflict strategy:** last-write-wins (acceptable for a small team on a shared plan)
- **Free tier limits:** 10,000 requests/month — well within range for a small team

---

## Configuration

Two constants at the top of the `<script>` block:

```js
const CLOUD_BIN_ID  = 'YOUR_BIN_ID_HERE';
const CLOUD_API_KEY = 'YOUR_API_KEY_HERE';
```

If either value is the placeholder string, cloud sync is **silently disabled** and the app behaves exactly as before (localStorage only). This makes the file safe to share without credentials.

### Setup steps (one-time, per deployment)
1. Create a free account at [jsonbin.io](https://jsonbin.io)
2. Create a new bin — initial content can be `{}`
3. Copy the **Bin ID** and **Master Key** from the dashboard
4. Paste both into the two constants in `index.html`

---

## Data Format

The cloud stores the same JSON shape already produced by the Export button:

```json
{
  "app": "jwx-timeline",
  "version": 1,
  "exportedAt": "2026-07-01T10:00:00.000Z",
  "teams": [ ...custom team definitions... ],
  "tasks": [ ...task overlays (id, s, dur, team)... ]
}
```

BASELINE (task names, types, sizes, dependency definitions) stays hardcoded in the HTML and is never stored in the cloud — only the user-editable fields (`s`, `dur`, `team`) are persisted. This means updating the BASELINE in code takes effect on next load without corrupting saved data.

---

## Load Flow

On page open:

1. Show status: `Syncing…`
2. `GET` from JSONBin
3. **Success:** call `applyOverlay()` with the cloud tasks array + restore custom teams → render → show `Synced from cloud — MM/DD HH:MM`
4. **Failure (network error / bad key / timeout):** fall back to localStorage, render from local cache → show `⚠ Cloud unavailable — working offline`
5. **Empty bin (first run):** treat as no saved state → render BASELINE → show `Baseline plan — cloud storage is empty`

localStorage remains populated as an offline cache throughout normal operation.

---

## Save Flow

### Manual save ("Save now" button)
1. `PUT` full state JSON to JSONBin
2. Write same state to localStorage
3. Clear dirty flag, reset auto-save timer
4. Show `Saved to cloud HH:MM` on success, `⚠ Cloud save failed — try Save now` on error

### Auto-save (throttled)
- Any change (drag, resize, team dropdown, team add/remove) marks state as **dirty**
- If no auto-save timer is running, start a **60-second countdown**
- When timer fires: if still dirty → run the same save flow as manual save → show `Auto-saved HH:MM`
- If "Save now" fires while timer is running: save immediately, cancel timer
- New changes arriving during an active timer ride the same timer (no re-schedule, no double-save within the window)
- localStorage is still written on every change (existing behaviour) for local resilience

---

## UI: Status Bar States

All feedback uses the existing `.status` element in the toolbar. No new UI chrome.

| State | Message | Colour |
|---|---|---|
| Loading | `Syncing…` | muted |
| Clean / synced | `Synced from cloud — MM/DD HH:MM` | green |
| Dirty (pending auto-save) | `● Unsaved changes` | amber |
| Saving in progress | `Saving to cloud…` | muted |
| Auto-saved | `Auto-saved HH:MM` | green |
| Manual saved | `Saved to cloud HH:MM` | green |
| Cloud save failed | `⚠ Cloud save failed — try Save now` | red |
| Offline fallback | `⚠ Cloud unavailable — working offline` | red |
| Empty bin / first run | `Baseline plan — cloud storage is empty` | muted |
| Cloud disabled (no key) | `Baseline plan — every change auto-saves to this browser` | muted (existing) |

---

## Code Changes (scope)

All changes are inside the single `<script>` block in `index.html`. No new files.

| What | How |
|---|---|
| Config constants | Add `CLOUD_BIN_ID` and `CLOUD_API_KEY` at the top of the script |
| `loadFromCloud()` | New `async` function: GET → parse → `applyOverlay()` + team restore |
| `saveToCloud()` | New `async` function: PUT with full state JSON |
| `load()` replacement | Init now calls `loadFromCloud()` (async), falls back to localStorage |
| `save()` update | Calls `saveToCloud()` in addition to existing localStorage write |
| Auto-save logic | `markDirty()` helper sets flag + starts 60s timer; called from every mutation point |
| Status messages | Update `setStatus()` calls throughout to reflect cloud states |

---

## Out of Scope

- Real-time sync (WebSocket / polling)
- Authentication / login
- Per-user plans
- Conflict resolution beyond last-write-wins
- JSONBin bin creation automation (manual setup)
