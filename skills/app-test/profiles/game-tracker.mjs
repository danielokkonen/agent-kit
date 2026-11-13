import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Load node:sqlite after clearing warning listeners so its ExperimentalWarning stays out of CLI output.
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function findProjectDir(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate project root (package.json)');
    dir = parent;
  }
}

// Invoked with cwd = the project root; this script may live outside the repo (global skill).
const startDir = fs.existsSync(path.join(process.cwd(), 'package.json')) ? process.cwd() : scriptDir;
const projectDir = findProjectDir(startDir);

const SCRATCH_ROOT = '/tmp/opencode/game-tracker';
const DB_FILE = 'dev.db';
const ELECTRON_ENTRY = '.vite/build/main.js';
const MASTER_BRANCH = 'master';
const RELEASE_COMMIT_PATTERN = '^chore(release)';

function git(args) {
  try {
    // Trailing-only trim: porcelain status lines carry a meaningful leading space.
    return execFileSync('git', args, { cwd: projectDir }).toString().replace(/\s+$/, '');
  } catch (err) {
    const stderr = err.stderr?.toString().trim() ?? '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function readBaseline(cwd) {
  const db = new DatabaseSync(path.join(cwd, DB_FILE), { readOnly: true });
  try {
    return {
      gameCount: db.prepare('SELECT COUNT(*) AS count FROM Game').get().count,
      sampleGames: db.prepare('SELECT id, name, status FROM Game ORDER BY created DESC LIMIT 3').all(),
    };
  } finally {
    db.close();
  }
}

function schema() {
  const dbSource = path.join(projectDir, DB_FILE);
  if (!fs.existsSync(dbSource)) {
    throw new Error(`${DB_FILE} not found in ${projectDir} — run the app once to create it`);
  }
  const db = new DatabaseSync(dbSource, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(
      tables.map((t) => [t.name, db.prepare(`PRAGMA table_info("${t.name}")`).all().map((c) => ({ name: c.name, type: c.type }))])
    );
  } finally {
    db.close();
  }
}

const BUILD_SCRIPT = path.resolve(scriptDir, '..', 'scripts', 'build-app.mjs');
const SOURCE_PATHS = ['src', 'vite.base.config.ts', 'package.json'];

function newestSourceMtime() {
  let latest = 0;
  const visit = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) visit(path.join(p, entry.name));
    } else if (stat.mtimeMs > latest) {
      latest = stat.mtimeMs;
    }
  };
  for (const rel of SOURCE_PATHS) {
    const p = path.join(projectDir, rel);
    if (fs.existsSync(p)) visit(p);
  }
  return latest;
}

function ensureBuilt() {
  const entryPath = path.join(projectDir, ELECTRON_ENTRY);
  const builtAt = fs.existsSync(entryPath) ? fs.statSync(entryPath).mtimeMs : 0;
  if (builtAt >= newestSourceMtime()) return;
  console.error(`[game-tracker] app build missing or stale — running: node ${BUILD_SCRIPT}`);
  try {
    execFileSync(process.execPath, [BUILD_SCRIPT], { cwd: projectDir });
  } catch (err) {
    throw new Error(`app build failed: ${(err.stderr?.toString() ?? err.message).trim()}`);
  }
}

function prepareData() {
  ensureBuilt();
  const dbSource = path.join(projectDir, DB_FILE);
  if (!fs.existsSync(dbSource)) {
    throw new Error(`${DB_FILE} not found in ${projectDir} — run the app once to create it`);
  }

  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'run-'));
  for (const file of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    const source = path.join(projectDir, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(cwd, file));
  }

  return { cwd, baseline: readBaseline(cwd) };
}

function teardown(cwd) {
  const root = path.resolve(SCRATCH_ROOT);
  const target = path.resolve(cwd);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to remove ${cwd}: outside scratch root ${root}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function teardownAll() {
  const root = path.resolve(SCRATCH_ROOT);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}

function buildTarget({ cwd }) {
  return {
    type: 'electron',
    launch: {
      entry: path.join(projectDir, ELECTRON_ENTRY),
      cwd,
      executablePath: path.join(projectDir, 'node_modules/electron/dist/electron'),
    },
    assertions: [
      {
        file: path.resolve(scriptDir, '..', 'scripts', 'sqlite-assert.mjs'),
        // Launch-phase migration check for GameTracker's schema (see sqlite-assert.mjs).
        args: { expectedTables: ['Game', 'Tokens', 'Settings', 'GameActivity'], minUserVersion: 1 },
      },
    ],
  };
}

function writeTarget(file, target) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `export default ${JSON.stringify(target, null, 2)};\n`);
}

function parseStatusPaths(statusOutput) {
  return statusOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"(.*)"$/, '$1'));
}

function deriveScope() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  let anchor;
  if (branch === MASTER_BRANCH) {
    anchor = git(['rev-list', '-n', '1', `--grep=${RELEASE_COMMIT_PATTERN}`, 'HEAD']);
    if (!anchor) throw new Error(`No commit matching "${RELEASE_COMMIT_PATTERN}" found on ${MASTER_BRANCH}`);
  } else {
    anchor = git(['merge-base', 'origin/master', 'HEAD']);
  }

  const committed = git(['diff', '--name-only', `${anchor}..HEAD`]).split('\n').filter(Boolean);
  const uncommitted = parseStatusPaths(git(['status', '--porcelain']));
  return { branch, anchor, files: [...new Set([...committed, ...uncommitted])] };
}

const profile = {
  name: 'game-tracker',
  // Run from the app root; mirrors forge's VitePlugin entries (see scripts/build-app.mjs).
  buildCommand: `node ${path.resolve(scriptDir, '..', 'scripts', 'build-app.mjs')}`,
  prepareData,
  teardown,
  deriveScope,
};

function cli(argv) {
  const [command, ...rest] = argv;
  if (command === 'prepare') {
    let out;
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '--out') out = rest[++i];
    }
    const { cwd, baseline } = prepareData();
    if (out) writeTarget(out, buildTarget({ cwd }));
    console.log(JSON.stringify({ cwd, baseline, targetFile: out ?? null }, null, 2));
    return;
  }
  if (command === 'teardown') {
    if (rest[0] === '--all') {
      teardownAll();
      console.log(`Removed all scratch dirs under ${SCRATCH_ROOT}`);
    } else {
      teardown(rest[0]);
      console.log(`Removed ${rest[0]}`);
    }
    return;
  }
  if (command === 'scope') {
    console.log(JSON.stringify(deriveScope(), null, 2));
    return;
  }
  if (command === 'schema') {
    console.log(JSON.stringify(schema(), null, 2));
    return;
  }
  throw new Error('Usage: game-tracker.mjs <prepare [--out <file>] | teardown <cwd> | scope | schema>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli(process.argv.slice(2));
  } catch (err) {
    console.error(`game-tracker profile: ${err.message}`);
    process.exitCode = 1;
  }
}

export default profile;
