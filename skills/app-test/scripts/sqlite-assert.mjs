import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_FILE = 'dev.db';

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`sqlite-assert: invalid identifier "${name}"`);
  return `"${name}"`;
}

// Launch-phase sanity checks. Both are optional so this hook is reusable across SQLite apps:
// pass `expectedTables` / `minUserVersion` (via the profile's assertion args) to enforce them,
// or omit both and launch just confirms the file opens as a readable SQLite database.
function launchChecks(db, { expectedTables, minUserVersion }) {
  if (expectedTables !== undefined) {
    if (!Array.isArray(expectedTables) || expectedTables.some((t) => typeof t !== 'string' || !t)) {
      throw new Error('sqlite-assert: "expectedTables" must be an array of table names');
    }
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    );
    for (const table of expectedTables) {
      if (!tables.has(table)) throw new Error(`sqlite-assert: table "${table}" missing — migrations did not run cleanly`);
    }
  }
  if (minUserVersion !== undefined) {
    if (typeof minUserVersion !== 'number' || !Number.isFinite(minUserVersion)) {
      throw new Error('sqlite-assert: "minUserVersion" must be a number');
    }
    const { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
    if (userVersion < minUserVersion) {
      throw new Error(`sqlite-assert: PRAGMA user_version is ${userVersion}, expected >= ${minUserVersion}`);
    }
  }
}

function countCheck(db, table, expected) {
  const actual = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
  if (actual !== expected) throw new Error(`sqlite-assert: ${table} row count is ${actual}, expected ${expected}`);
}

function rowCheck(db, table, where, fields) {
  const clauses = Object.entries(where).map(([column, value]) => `${quoteIdentifier(column)} = ?`);
  const params = Object.values(where);
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${clauses.join(' AND ')}`).all(...params);
  if (rows.length === 0) throw new Error(`sqlite-assert: no ${table} row matches ${JSON.stringify(where)}`);
  if (rows.length > 1) throw new Error(`sqlite-assert: expected exactly one ${table} row for ${JSON.stringify(where)}, found ${rows.length}`);

  const row = rows[0];
  for (const [column, expected] of Object.entries(fields ?? {})) {
    const actual = column in row ? row[column] : null;
    if (actual !== expected) {
      throw new Error(`sqlite-assert: ${table}.${column} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
}

function stepCheck(db, check) {
  if (typeof check.count === 'number') return countCheck(db, check.table, check.count);
  if (check.where !== undefined) return rowCheck(db, check.table, check.where, check.fields);
  throw new Error('sqlite-assert: each check needs "count" or "where"');
}

export default async function sqliteAssert({ cwd, phase, checks = [], dbFile = DB_FILE, expectedTables, minUserVersion }) {
  const dbPath = path.join(cwd ?? '.', dbFile);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (phase === 'launch') {
      launchChecks(db, { expectedTables, minUserVersion });
      return;
    }
    for (const check of checks) stepCheck(db, check);
  } finally {
    db.close();
  }
}
