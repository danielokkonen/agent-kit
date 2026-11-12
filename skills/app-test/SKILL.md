---
name: app-test
description: Playwright-driven UI testing for local Electron and web apps. Use after implementing a feature or fixing a bug to drive the real UI, assert backend state via profile hooks (SQLite, an HTTP API, or anything else), and report pass/fail with screenshots so failures can be fixed and re-run iteratively.
---

# app-test

Test a **running** app by driving its real UI with Playwright (plain library, not `@playwright/test`). The agent authors a scenario file targeting the changed feature, runs it through `scripts/run-scenario.mjs`, and gets pass/fail per step plus screenshots and console errors on failure. Backend state is verified after mutating steps via assertion hooks registered by the profile — the hooks are storage-agnostic (SQLite, HTTP API, Postgres, files, ...).

## Architecture: generic core + per-app profiles

- **Generic core** (app-agnostic): `scripts/run-scenario.mjs` — launches the target (`electron` or `url`), executes scenario steps, screenshots failures, collects console errors, invokes assertion hooks after mutating steps, reports pass/fail. It does **not** depend on the app under test having a `package.json` or its own toolchain: Playwright is installed once in this skill's directory (see Setup).
- **Assertion hooks are storage-agnostic.** A hook is any module with `default export async function(ctx)`. The runner passes it `{ cwd, baseUrl, launch, phase, stepTitle, checks }`, so a hook can assert against whatever the app persists. There is no built-in assumption it's a DB — pick or author whichever matches your backend (see **Assertion hooks** below).
- **Per-app profile**: how to build/start the app, data isolation/seeding, which assertion hook(s) to register, scope-derivation conventions. GameTracker's profile is `profiles/game-tracker.mjs`; its build harness is `scripts/build-app.mjs`, and it asserts the scratch DB with `scripts/sqlite-assert.mjs`. Adding another app = one new profile file (plus any hook scripts it needs), never a fork of the core runner.

## Setup (once)

Playwright lives in this skill's own `node_modules`, not the app's:

    npm install        # run from this skill's directory (the folder with SKILL.md)

Browsers are cached under `~/.cache/ms-playwright` and shared across installs, so a matching Playwright version reuses them. To use a different Playwright instead of the local copy, set `PLAYWRIGHT_MODULE` to a resolvable module/path.

## Workflow

All script paths below are relative to this skill's directory (the folder containing `SKILL.md`); run them from there.

**Profile first:** if the app under test has no `profiles/<app>.mjs`, create one now (see **Adding a new app**) — every step below assumes it exists. Profiles are per-app setup done once; only scenario files are written fresh per run.

1. **Scope** — default: the current branch being worked on, no prompt needed.
   - On a feature branch: diff from `git merge-base origin/master HEAD` to HEAD + uncommitted changes.
   - Working directly on `master`: anchor at the last `chore(release)` commit (everything unreleased).
   - Always overridable: "test only X" or "since commit Y" narrows the scenario instead of re-deriving scope.
   - GameTracker helper: `node profiles/game-tracker.mjs scope` prints `{ branch, anchor, files }`. Map changed files → affected pages/features using the architecture conventions in AGENTS.md (views in `src/client/views/`, features in `src/client/components/<feature>/`). Other apps: just read the diff.
2. **Build / start** — bring the app under test up, however that works for it.
   - GameTracker (Electron): `npm run build:app` (sanctioned harness exception to "never run vite build directly").
   - Web apps: start/confirm your dev or prod server is listening; the runner connects to `baseUrl`. Add a `healthCheckUrl` so the runner waits for readiness instead of racing a slow startup, and a `storageState` path if the app needs a logged-in session.
3. **Data prep** — isolate/seed whatever the app persists, per profile (GameTracker copies its SQLite DB to a scratch dir and never touches the real one):
   ```
   node profiles/game-tracker.mjs prepare --out /tmp/opencode/app-test/target.mjs
   ```
   Prints `{ cwd, baseline, targetFile }`. The baseline (e.g. game count) is what scenario assertions compare against; `teardown` discards the scratch dir afterwards. Other backends seed via their own profile hook/prepare step (HTTP API calls, a throwaway Postgres schema, fixture files), or skip this if the feature under test is stateless.
4. **Drive** — author a scenario file (format below), then:
   ```
   node scripts/run-scenario.mjs /tmp/opencode/app-test/<scenario>.mjs --target <target-file>
   ```
   The window is visible so the user can watch. Cover happy path + edge cases for the changed feature (form validation, IPC round-trips, date display). Rely on Playwright auto-waiting; add explicit waits only where a run shows flakiness.
5. **Assert** — after each mutating step, the profile's hooks run automatically (GameTracker: `sqlite-assert.mjs` checks the scratch DB copy and verifies migrations ran cleanly at launch; an HTTP backend would use `http-assert.mjs`).
6. **Report & loop** — read the pass/fail summary; on failure inspect the screenshot path and console errors printed by the runner, fix, and re-run just the failing scenario.

**Teardown (always):** after a run completes or is abandoned:
```
node profiles/game-tracker.mjs teardown <cwd-from-prepare>
```
The scratch dir is discarded; there is no restore step. (Only for profiles that create scratch state.)

## Target config format

Default export of the `--target` file (GameTracker's is generated by `prepare --out`):

```js
export default {
  type: 'electron', // or 'url'
  launch: { entry, cwd }, // electron; url targets use { baseUrl } instead
  assertions: [{ file, args }], // optional hook modules, run after mutating steps and at launch
};
```

- `type: 'electron'` → launched via Playwright `_electron.launch({ args: [entry], cwd })`; the first window is driven. `launch.executablePath` points at the app's Electron binary.
- `type: 'url'` → Chromium navigates to `launch.baseUrl`. Optional fields on `launch`:
  - `healthCheckUrl` — polled until it returns 2xx/3xx before steps run (waits for a slow server instead of racing it).
  - `storageState` — path to a Playwright storage-state JSON, for apps that need a logged-in session.
  - `headless` — default `true`; set `false` to watch the browser.
- Each assertion in `assertions` is a module whose default export is `async function ({ cwd, baseUrl, launch, phase, stepTitle, checks }) => {}`. `phase` is `'launch'` (before steps) or `'step'` (after each mutating step).

## Scenario file format

Default export of the scenario file: `{ name, steps }`, or shorthand `{ name, run }` for a single-step scenario.

```js
export default {
  name: 'create game',
  steps: [
    { title: 'open games page', run: async ({ page }) => { /* Playwright actions */ } },
    {
      title: 'submit new game form',
      mutating: true, // hooks run after this step (also triggered by a non-empty assertions array)
      assertions: [
        { table: 'Game', count: 13 }, // baseline.gameCount + 1 — shape depends on your hook
        { table: 'Game', where: { name: 'Hades' }, fields: { franchise: '', status: 'Not started' } },
      ],
      run: async ({ page }) => { /* fill form, submit */ },
    },
  ],
};
```

The step's `assertions` array is passed to your hook as `checks`; see **Assertion hooks** below for the check shapes each example expects.

### Assertion hooks (storage-agnostic)

The runner just loads each `assertions[].file` module and calls its default export with the context above — it knows nothing about your storage. Two examples ship in this skill:

- **SQLite** — `scripts/sqlite-assert.mjs`. Step check shapes: `{ table, count }` for an exact row count; `{ table, where, fields? }` for exactly one matching row with optional field equality (`null` matches SQL NULL); compute expected counts from the `baseline` printed by `prepare`. The launch phase is opt-in — pass `args: { expectedTables?, minUserVersion? }` in your profile to verify migrations ran (GameTracker does this), or omit both and it just confirms the file opens as a readable SQLite DB. `dbFile` (default `dev.db`) can also be overridden via args.
- **HTTP API** — `scripts/http-assert.mjs` (generic backend). Check shapes: `{ method?, path, status?, expect?, body? }` where `path` is a route or absolute URL, `status` defaults to 200, and `expect` must be a subset of the parsed JSON response. It reads `baseUrl` from the url target (or pass an absolute `path`).

To support another backend, add a hook module with the same default-export signature and register it in your profile — never fork the runner.

## Adding a new app (profile)

A profile is per-app setup done **once**, before any test run — never written fresh per scenario. It lives at `profiles/<app>.mjs`. The only hard requirement is that it can produce the target config file for the runner; everything else is convention:

- `prepare [--out <file>]` — seed/isolate data and write the target file (print `{ baseline, targetFile }`; the baseline feeds your scenario's expected values).
- `teardown <cwd>` — discard scratch state (only if you create any).
- `scope` — print changed files for scope derivation (optional; "just read the diff" works too).

Minimal URL-app profile:

```js
// profiles/my-web-app.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function cli(argv) {
  const [command, ...rest] = argv;
  if (command === 'prepare') {
    let out; for (let i = 0; i < rest.length - 1; i++) if (rest[i] === '--out') out = rest[++i];
    const target = {
      type: 'url',
      launch: { baseUrl: 'http://localhost:3000/', healthCheckUrl: 'http://localhost:3000/health' },
      assertions: [{ file: path.resolve(scriptDir, '..', 'scripts', 'http-assert.mjs') }],
    };
    if (out) fs.writeFileSync(out, `export default ${JSON.stringify(target, null, 2)};\n`);
    console.log(JSON.stringify({ baseline: {}, targetFile: out ?? null }, null, 2));
    return;
  }
  throw new Error('Usage: my-web-app.mjs prepare [--out <file>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
export default { name: 'my-web-app' };
```

Adapt `baseUrl`/`healthCheckUrl`, swap in the assertion hook that matches your backend, and add `teardown` if you seed scratch state. Then run it exactly like GameTracker's: `node profiles/my-web-app.mjs prepare --out /tmp/opencode/app-test/target.mjs`.

## Evidence & artifacts

- Screenshots on failure: `/tmp/opencode/app-test/<scenario-slug>-<timestamp>/step-NN.png` (paths are printed in the report).
- Scratch data dirs: under `/tmp/opencode/game-tracker/`; scenario/target files: keep them under `/tmp/opencode/app-test/`.
- Exit code: `0` all steps passed, `1` any failure or launch error, `2` bad CLI usage. The runner stops at the first failing step; later steps are reported as skipped.
