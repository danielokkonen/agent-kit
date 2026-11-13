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
- Details overlay: heading = game name (h5); sections Progress / Developer / Publisher / Description / Genres / Platforms; close button = `.MuiModal-root button:has(svg[data-testid="CloseIcon"])` (header right side); Escape and backdrop click also close it; status Select — scope to `.MuiModal-root .MuiSelect-select` (the page's franchise/status filter selects come earlier in DOM order)
- Row action IconButtons have no aria-labels — edit = first `button` in the row's last td, delete = second
- Snackbar texts: "Game added", "Game updated" (only when on /games), "Game deleted"
- Settings: "General" heading, "Dark Mode" label
- Steam import: search field placeholder "Search games..."

## Behavior facts (no need to re-read source)
- Delete is immediate — no confirmation dialog; click the delete IconButton at row end, expect "Game deleted" snackbar.
- Details modal status Select auto-saves on change (calls update immediately); there is no Save button.
- Create/edit form has an unlabeled status Select defaulting to `Not started`; created games persist that value.
- For list-presence assertions use one of prepare's `sampleGames` names (baseline-dependent data).

## Gotchas
- MUI Select menu items render with `role="option"` (not "menuitem"), plus `data-value` — select via `getByRole('option', { name, exact: true })`.
- To assert client-side validation failure: MUI sets `aria-invalid="true"` on invalid fields — use `toHaveAttribute('aria-invalid', 'true')`, not exact error text.
- Create form's yup schema requires Franchise (`string().required()`) even though the DB allows empty — fill it in create scenarios.
- Create form Franchise is a freeSolo Autocomplete wired to Formik's handleChange — plain `.fill()` works, no Enter needed. The /games page also has a franchise filter select with `name="franchise"`, so target the form input via `getByRole('combobox', { name: 'Franchise' })`, not `input[name="franchise"]`.
- Details-modal status change is a silent save (no snackbar, no other UI signal) — add a bounded wait before DB assertions.
- `getByText` on game names needs `{ exact: true }` — franchise cells can contain the name as a substring (strict-mode violation otherwise).
- Steps receive a working `expect` injected by the runner (@playwright/test standalone) — use it; don't import plain `playwright` in scenario files (its 1.62 entry no longer exports `expect`).

## DB facts (assertions via sqlite-assert.mjs)
- Table `Game`: id, name, franchise, start, end, created, updated, coverImage, developer, genres, platforms, publisher, summary, appId, playtime_minutes, status — `status` is a real column added by one-shot migration (not in CREATE TABLE)
- Status values: Not started / Started / Completed / Paused / Dropped / Replaying
