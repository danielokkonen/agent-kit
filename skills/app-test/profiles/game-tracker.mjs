import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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
    return { gameCount: db.prepare('SELECT COUNT(*) AS count FROM Game').get().count };
  } finally {
    db.close();
  }
}

function prepareData() {
  const entryPath = path.join(projectDir, ELECTRON_ENTRY);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Built app not found at ${entryPath} — run "npm run build:app" first`);
  }
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
  buildCommand: 'npm run build:app',
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
    teardown(rest[0]);
    console.log(`Removed ${rest[0]}`);
    return;
  }
  if (command === 'scope') {
    console.log(JSON.stringify(deriveScope(), null, 2));
    return;
  }
  throw new Error('Usage: game-tracker.mjs <prepare [--out <file>] | teardown <cwd> | scope>');
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
