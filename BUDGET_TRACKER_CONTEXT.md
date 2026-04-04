# Family Budget Tracker — Project Context

> **Last updated:** April 2, 2026
> **Purpose:** Provide full context to Claude for working on this project across sessions. Upload this file along with `index.html` at the start of each conversation.

---

## 1. Project Identity

**Family Budget Tracker** is a progressive web app (PWA) for Dave and Lindsey to track shared household expenses, recurring charges, credits/refunds, and personal spending. It's a single HTML file hosted on GitHub Pages with Firebase Firestore for real-time sync between devices.

| | |
|---|---|
| **Live URL** | https://hancock-d.github.io/expenses/ |
| **GitHub repo** | `hancock-d/expenses` |
| **Firebase project** | `expenses-414b1` (Google account associated with Dave) |
| **Users** | Dave (Person 1) and Lindsey (Person 2) |

---

## 2. Tech Stack & Constraints

| Layer | Technology |
|---|---|
| Frontend | Single `index.html` — vanilla HTML/CSS/JS, **no build system, no frameworks** |
| Database | Firebase Firestore (free Spark tier) |
| Hosting | GitHub Pages (free) |
| Fonts | DM Serif Display, DM Mono, DM Sans (Google Fonts CDN) |
| Firebase SDK | **10.12.0** (ESM module, loaded via `<script type="module">`) |

### Hard constraints — do not violate:
- **Single-file architecture.** Everything lives in `index.html`. No separate JS/CSS files.
- **No build tools.** No npm, no webpack, no transpilation. Must work as raw HTML served by GitHub Pages.
- **No frameworks.** No React, Vue, Svelte, etc. Vanilla JS only.
- **Firestore paths must be even-segment.** e.g. `months/2026-04` not `budget/months/2026-04`.
- **API key is in the HTML** — mitigated by HTTP referrer restriction in Google Cloud Console (only `hancock-d.github.io/*` and `localhost`).

---

## 3. File Structure

All files must be in the **repo root**:

| File | Purpose |
|---|---|
| `index.html` | The entire app (~2300 lines) |
| `BUDGET_TRACKER_CONTEXT.md` | This file — project context for Claude sessions |
| `manifest.json` | PWA manifest (app name: "Expenses") |
| `icon.png` | 192×192 app icon (dark background, $ symbol) |
| `icon-512.png` | 512×512 app icon |

---

## 4. Data Architecture

### Firestore Collections

| Path | Contents |
|---|---|
| `budget/meta` | Names, RECUR templates, PIN, rOpen, cOpen |
| `months/{YYYY-MM}` | Month data wrapped as `{data: JSON.stringify(...), ts: ...}` |
| `persMeta/data` | Personal subscription templates (PSUBS), subOpen state |
| `personal_1/{YYYY-MM}` | Dave's personal month data (same wrapper format) |
| `personal_2/{YYYY-MM}` | Lindsey's personal month data |

### Firestore Security Rules (permanent, no expiry)
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```
Open read/write, protected by PIN at the app level.

### Month Data Shape (`DB[key]`)
```js
{
  expenses: [
    // Recurring (seeded):
    { date, desc, cat, paidBy, amount, recurId, payment? },
    // One-off:
    { date, desc, cat, paidBy, amount, payment?, notes? }
  ],
  credits: [
    { date, desc, to, amount, payment?, notes? }
    // to: '1' | '2' | 'shared'
  ],
  settled: false,
  seeded: true,
  skips: { "recurId": true, ... },
  overrides: { "recurId": "value", ... }
}
```

### Personal Month Data Shape (`PDB[who][key]`)
```js
{
  expenses: [
    // Subscription seed:
    { date, desc, cat, paidBy, amount, subId, isSubSeed: true },
    // One-off:
    { date, desc, cat, amount, payment?, notes? }
  ],
  credits: [
    { date, desc, amount, payment?, notes? }
  ],
  seeded: true,
  skips: { "subId": true, ... },
  overrides: { "subId": "value", ... }
}
```

### RECUR Template Shape (stored in `budget/meta.recur`)
```js
{
  id: "r" + timestamp,
  name, paidBy, cat, amount, payment, chargeDay,
  covStartRef, covStartDay, covEndRef, covEndDay,
  activeMonths: [1,1,1,1,1,1,1,1,1,1,1,1],  // 12 values, 1=active 0=skip
  active: true,
  notes
}
```

### PSUBS Template Shape (stored in `persMeta/data.subs`)
```js
{
  id: "ps" + timestamp,
  name, amount, payment, notes, active: true,
  chargeDay,
  covStartRef, covStartDay, covEndRef, covEndDay,
  activeMonths: [1,1,1,1,1,1,1,1,1,1,1,1]
}
```

---

## 5. Key Conventions

### People
| | Name | Color | CSS Variable |
|---|---|---|---|
| Person 1 | Dave | Blue | `--p1: #3B6EA5` |
| Person 2 | Lindsey | Purple | `--p2: #9B4F8E` |

Names are editable in the names row at top of main page and sync to Firebase.

### CSS Design Tokens
```
--cream: #FAF7F2    (background)
--ink: #1A1410      (header, dark elements)
--rust: #C4541A     (balance card, delete hover, skip highlight)
--sage: #4A7C59     (settled state)
--slate: #4A5568    (secondary text)
--rv: #6B4FBB       (recurring zone accent / purple)
--cv: #2E7D52       (credits zone accent / green)
Gold accent: #C49A6C (header title, current-month ring)
```

### Categories
`Groceries / Household`, `Utilities & Bills`, `Dining Out`, `Kids / Childcare`, `Home Improvement`, `Entertainment`, `Investments`, `Other`

### Payment Methods
`Amex`, `Chase`, `Debit`, `ACH`, `Cash`, `Check`, `Other`

### PIN System
- Default PIN: `1234`
- Single shared PIN for both users
- Stored in `localStorage` AND synced to Firebase `budget/meta.pin`
- Session stays unlocked until tab closes (`sessionStorage` flag)
- Keyboard support on desktop (type numbers + Backspace)

### Seeding Logic
- `seedMonth(y,m)` seeds active RECUR templates into month expenses
- Dedup guard: never adds a `recurId` that already exists
- **No early bail-out on `seeded` flag** — always checks for missing templates and syncs stale amounts
- If a seeded expense has an empty amount but the template has one, it gets updated
- `addRecur()` resets `seeded=false` then calls `seedMonth()`
- Same pattern for personal: `seedPersonalMonth(who,y,m)`

### calcMonth Template Fallback
When `calcMonth` encounters a recurring expense with an empty amount, it falls back to:
1. The month's override for that recurId
2. The RECUR template amount

This ensures totals are correct even if expenses were seeded before amounts were filled in.

### Coverage Date System
Relative (not absolute) — calculated dynamically from the viewed month:
- `covStartRef` / `covEndRef`: `'prev'` | `'curr'` | `'next'`
- `covStartDay` / `covEndDay`: 1-31
- `buildCovLabel(t, viewM, viewY)` generates display string (e.g. "Mar 25 – Apr 24")
- Accepts optional month/year params for personal page context

### Active Months & Skips
- `activeMonths`: array of 12 values (1=active, 0=skip)
- Toggling a month off auto-sets `md.skips[id] = true` for that month
- Skip button was removed — month bubbles handle everything
- Skipped rows get `.rskip` class (light rust background, reduced opacity)
- Inactive template rows get `.ri` class (very low opacity)

---

## 6. Current Feature Set

### Main Page
- **Summary Cards** (4-card grid): Dave total, Lindsey total, Combined Total, Balance (with carryover and settle button)
- **Recurring Charges** (purple collapsible zone): checkbox, name, paid by, category, stacked cost (usual/override), stacked payment (type/charge day), coverage (from/to + month bubbles), notes + delete button
- **Other Expenses** (plain section with running total tag): date, description, category, paid by, payment, amount, notes, delete
- **Credits & Refunds** (green collapsible zone): date, description, credited to, payment, amount, notes, delete
- **By Category** grid showing totals per category
- **Monthly History** table — capped at current viewed month + 11 preceding months

### Personal Pages
Accessed by tapping Dave or Lindsey's summary card on the main page. Full-screen overlay with its own month navigation.
- **Summary Cards** (3 + 1 spanning): Subscriptions, Other Expenses, Credits & Refunds, Total This Month
- **Recurring Subscriptions** (purple zone, same structure as main recurring minus Paid By and Category columns)
- **Other Expenses** (same as main minus Paid By)
- **Credits & Refunds** (green zone, same as main minus Credited To)
- **Monthly History** — capped at 12 months, respects skips

### Balance Math
```
paid1 / paid2 = raw dollars each person paid
cred1 / cred2 = credits applied to each person (shared splits 50/50)
net1 = max(0, paid1 - cred1)
net2 = max(0, paid2 - cred2)
balance = net1 - net2
  positive → Lindsey owes Dave
  negative → Dave owes Lindsey
Carryover = sum of balance from all prior unsettled months
```

### Data Flow
1. On load: reads localStorage cache immediately (fast display)
2. Fetches Firebase (source of truth), merges, re-renders
3. Real-time listeners (`onSnapshot`) on current month doc + meta doc
4. Every save: writes to localStorage AND Firebase simultaneously
5. Sync dot in header: gold/pulsing = saving, green = synced, red = error

---

## 7. Known Behaviors & Gotchas

### Browser Issues
- **Brave browser** blocks Firebase by default — must disable Shields for the URL
- **iOS Add to Home Screen** requires Safari (not Firefox/Chrome on iOS)
- **iOS anti-zoom**: all inputs have `font-size: 16px` on mobile to prevent Safari auto-zoom, reset to inherited on desktop via media query

### Architecture Sensitivities
- **Mobile CSS nth-child mapping** is highly sensitive to column count. Any time a `<td>` is added or removed from a table row, ALL the mobile `@media` nth-child rules must be updated for that table. Main rtable = 8 columns, personal rtable = 6 columns.
- **Column count summary:**
  - Main rtable: ✓, Name, Paid By, Category, Cost, Payment, Coverage, Notes (8 tds)
  - Personal rtable: ✓, Name, Cost, Payment, Coverage, Notes (6 tds)
  - Main etable: Date, Desc, Category, Paid By, Payment, Amount, Notes, Delete (8 tds)
  - Personal etable: Date, Desc, Category, Payment, Amount, Notes, Delete (7 tds)
  - Main ctable: Date, Desc, Credited To, Payment, Amount, Notes, Delete (7 tds)
  - Personal ctable: Date, Desc, Payment, Amount, Notes, Delete (6 tds)
- **Real-time listener race**: `saveMD()` writes to Firebase, listener fires back and overwrites `DB[k]`, then `render()` runs. This is normally fine but be aware of it.
- The `fmt()` function handles all currency formatting: `$X,XXX.XX`
- The `ordinal()` function handles date suffixes: `1st`, `2nd`, `3rd`, `4th`, etc.

### Deploy Process
1. Make changes to `index.html`
2. Upload to GitHub repo (`hancock-d/expenses`) replacing existing file
3. GitHub Pages deploys in ~60 seconds
4. Both devices get update on next app open
5. Firebase data is unaffected by HTML updates

---

## 8. Agent Instructions

When working on this project, follow these rules:

### Session Workflow
1. **Start of session:** Dave uploads `index.html` and `BUDGET_TRACKER_CONTEXT.md`
2. **During session:** Claude works from these files, makes changes to both as needed
3. **End of session:** Claude outputs the updated `index.html` AND an updated `BUDGET_TRACKER_CONTEXT.md` (change log, TODO, any sections that shifted)
4. **After session:** Dave uploads both files to the GitHub repo (`hancock-d/expenses`)

### Setup
- Always work from the **uploaded `index.html`** — copy it to `/home/claude/index.html` first
- Also copy `BUDGET_TRACKER_CONTEXT.md` to `/home/claude/` for editing
- Read both files before making changes
- Final outputs go to `/mnt/user-data/outputs/`

### Code Style
- **Preserve the single-file architecture.** All HTML, CSS, and JS stay in `index.html`.
- Match existing code style: minified CSS, compact JS, template literals for HTML generation
- Use the existing `fmt()`, `esc()`, `ordinal()` helpers — don't create duplicates
- Use CSS variables from `:root` — don't hardcode colors

### Parallel Updates
- **Always update both main page AND personal pages** when changing shared patterns (table structure, zone styling, card layout, etc.)
- When changing recurring table columns, update: (1) `<thead>` headers, (2) render function row HTML, (3) mobile `@media` nth-child rules for both main and `#pers-overlay` scoped rules

### Mobile Awareness
- After any column change, recount tds and update ALL nth-child grid rules
- Main rtable mobile rules are in the main `@media(max-width:640px)` block
- Personal rtable/etable overrides are scoped under `#pers-overlay` in the same media query
- Test that mobile grid-template-columns still makes sense

### Testing Mindset
- Changes to seeding, calculation, or data shape can affect: summary cards, recurring totals, category grid, history table, carryover, balance
- If touching `calcMonth`, verify the template fallback logic still works
- If touching `seedMonth`/`seedPersonalMonth`, verify the dedup guard and stale-amount sync

### Delivery
- Copy updated `index.html` to `/mnt/user-data/outputs/index.html` and use `present_files`
- Copy updated `BUDGET_TRACKER_CONTEXT.md` to `/mnt/user-data/outputs/` and deliver alongside
- Provide a clear summary of what changed in both files

---

## 9. Change Log

### April 2026 (current session)
- Added `$` signs to all card amounts (verified `fmt()` already handles this)
- Added ordinal suffixes to date dropdowns (1st, 2nd, 3rd, etc.)
- Changed Other Expenses and Credits amount fields to left-aligned
- Restructured personal pages to mirror main page (same `section` wrapper, `rzone`/`czone` classes, `rtable`/`etable`/`ctable` table classes)
- Added Credits & Refunds section to personal pages (with zone, table, totals, history column)
- Updated cost field placeholders to "Usual Cost" / "Override Cost" → later "$0.00" with labeled headers
- Added `Investments` spending category
- Removed "Skip Month" button — month bubbles handle the same function
- Fixed `seedMonth` and `seedPersonalMonth`: removed `if(md.seeded) return` bail-out, always checks for missing templates via dedup guard, syncs stale amounts from templates to seeded expenses
- Fixed `calcMonth` to fall back to RECUR template amount when seeded expense has empty amount
- Merged Usual Cost / Actual Cost into single stacked "Cost" column
- Merged Payment Type / Charge Day into single stacked "Payment" column
- Moved delete button from separate column into Notes cell as small "Delete" text button
- Added `.rskip` class for skipped-month rows (light rust background, reduced opacity)
- Capped Monthly History to current viewed month + 11 preceding months (both main and personal)
- Fixed personal history to respect `md.skips` in subscription totals
- Added `renderPersHist` calls to all personal sub modification functions
- Bumped personal page `max-width` from 900px to 1100px to match main page
- Removed all dead CSS for old personal-specific classes (psub-table, pexp-table, etc.)
- **Tech debt cleanup:**
  - Removed dead CSS: `.skip-btn`, `.skip-on`, `.skip-off` (unused since skip button removal)
  - Removed broken `collection()`/`getDocs` query from `loadAll()` (was dead code, never worked)
  - Removed Firebase `_ping` test write on every page load (unnecessary noise in Firestore)
  - Consolidated duplicate `pmk()` function into alias for `mk()` (identical logic)
  - Added `APP_VERSION` constant (`1.0.0`) — logged to console on startup for debugging
  - Added safety comment on `savePMD()` documenting its global `PY`/`PM` dependency

### March 2026 (prior sessions, from memory)
- Added dollar signs, ordinal suffixes, credits sections to personal pages
- Added full timeframe fields for personal recurring subscriptions
- Firefox desktop layout fixes (min-width, column mapping corrections)
- Various iterative UI and data flow improvements

---

## 10. Future Plans / TODO

### High Priority
- [ ] Verify all recurring charges seed and calculate correctly across months on both main and personal pages (ongoing)
- [ ] Test mobile layout thoroughly after recent column restructuring
- [ ] Consider whether personal page subscription totals should show in the main page's history or remain separate

### Features
- [ ] Search/filter within expenses
- [ ] Export to CSV or printable summary
- [ ] Year-end summary view (annual totals by category, by person)
- [ ] Recurring charge "pause" vs "delete" — archive templates without losing history
- [ ] Dark mode toggle (CSS variables are already set up for this)
- [ ] Per-category budget targets / alerts
- [ ] Split expense support (e.g. 60/40 instead of just who-paid)

### Technical Debt
- [x] ~~Clean up dead CSS (`.skip-btn`, `.skip-on`, `.skip-off` classes are unused now)~~ — removed
- [x] ~~The `loadAll()` function tries to load a `collection()` query that doesn't work — dead code~~ — removed
- [x] ~~Consider adding a version number to the HTML for cache-busting and debugging~~ — added `APP_VERSION`
- [x] ~~Firebase test write on every load (`_ping`) is unnecessary noise~~ — removed
- [x] ~~Duplicate `pmk()` function identical to `mk()`~~ — consolidated as alias
- [ ] Consider moving `calcMonth` template-fallback logic into `seedMonth` so seeded data is always complete
- [ ] Audit `savePMD` — it uses global `PY`/`PM` which could be a bug source if called from a non-current-month context (safety comment added)

### Nice to Have
- [ ] Animations / transitions when switching months
- [ ] Drag to reorder recurring charges
- [ ] Duplicate a recurring charge template
- [ ] Batch edit recurring charges (e.g. change all "Debit" to "Chase")
- [ ] Push notifications for upcoming charges (would need a service worker upgrade)
- [ ] Multi-month comparison charts

---

*This file lives in the GitHub repo at `hancock-d/expenses/BUDGET_TRACKER_CONTEXT.md`. Upload it alongside `index.html` at the start of each Claude session. Claude will return an updated copy at the end of each session with the change log and any sections that shifted.*
