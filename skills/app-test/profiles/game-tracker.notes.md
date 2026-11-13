# GameTracker scenario authoring notes

Read before writing scenarios; append durable findings after runs so repeat runs don't re-read source.

## Routes (hash router)
- `/` — dashboard: "Total Games" / "Now Playing" headings, stat cards
- `/games` — game list table + inline create/edit form (not a modal); rows ordered by created DESC
- `/games/:id` — GameDetails overlay modal over the list (list stays mounted underneath)
- `/steam-import`, `/settings`

## Nav labels (left drawer links, role="link")
Home / Games / Import from Steam / Settings — click via `getByRole('link', { name })`.

## Stable texts & selectors
- Add menu: first `button.MuiIconButton-root` on /games; its items render as `role="menuitem"` (MUI MenuItem) — click via `getByRole('menuitem', { name })`; items: "New", "Import from CSV", "Add game details from IGDB"
- Create form fields: labels Name, Franchise (freeSolo Autocomplete), Started/Completed; submit button "Submit"; close button "Close"
- Row cells by td index: 0 checkbox, 1 cover image, 2 name, 3 franchise, 4 status icon, 5 started, 6 completed, last = actions (edit IconButton then delete IconButton)
- Open details by clicking a row's game-name cell (row click → /games/:id); edit/delete IconButtons sit at the row end — avoid them when clicking rows
- Details overlay: heading = game name (h5); sections Progress / Developer / Publisher / Genres / Platforms; close = first `button.MuiIconButton-root` inside `.MuiModal-root`; status Select — scope to `.MuiModal-root .MuiSelect-select` (the page's franchise/status filter selects come earlier in DOM order)
- Snackbar texts: "Game added", "Game updated" (only when on /games), "Game deleted"
- Settings: "General" heading, "Dark Mode" label
- Steam import: search field placeholder "Search games..."

## Gotchas
- MUI Select menu items render with `role="option"` (not "menuitem"), plus `data-value` — select via `getByRole('option', { name, exact: true })`.
- Create form's yup schema requires Franchise (`string().required()`) even though the DB allows empty — fill it in create scenarios.
- Create form Franchise is a freeSolo Autocomplete wired to Formik's handleChange — plain `.fill()` works, no Enter needed.
- `getByText` on game names needs `{ exact: true }` — franchise cells can contain the name as a substring (strict-mode violation otherwise).
- Steps receive a working `expect` injected by the runner (@playwright/test standalone) — use it; don't import plain `playwright` in scenario files (its 1.62 entry no longer exports `expect`).

## DB facts (assertions via sqlite-assert.mjs)
- Table `Game`: id, name, franchise, start, end, created, updated, coverImage, developer, genres, platforms, publisher, summary, appId, playtime_minutes, status — `status` is a real column added by one-shot migration (not in CREATE TABLE)
- Status values: Not started / Started / Completed / Paused / Dropped / Replaying
