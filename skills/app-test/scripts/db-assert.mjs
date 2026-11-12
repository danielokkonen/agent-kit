import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB_FILE = 'dev.db';
const EXPECTED_TABLES = ['Game', 'Tokens', 'Settings', 'GameActivity'];
// Mirrors MIGRATION_VERSION in src/backend/database/database.ts.
const MIN_USER_VERSION = 1;

function quoteIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`db-assert: invalid identifier "${name}"`);
  return `"${name}"`;
}

function launchChecks(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  for (const table of EXPECTED_TABLES) {
    if (!tables.has(table)) throw new Error(`db-assert: table "${table}" missing — migrations did not run cleanly`);
  }
  const { user_version: userVersion } = db.prepare('PRAGMA user_version').get();
  if (userVersion < MIN_USER_VERSION) {
    throw new Error(`db-assert: PRAGMA user_version is ${userVersion}, expected >= ${MIN_USER_VERSION}`);
  }
}

function countCheck(db, table, expected) {
  const actual = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
  if (actual !== expected) throw new Error(`db-assert: ${table} row count is ${actual}, expected ${expected}`);
}

function rowCheck(db, table, where, fields) {
  const clauses = Object.entries(where).map(([column, value]) => `${quoteIdentifier(column)} = ?`);
  const params = Object.values(where);
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} WHERE ${clauses.join(' AND ')}`).all(...params);
  if (rows.length === 0) throw new Error(`db-assert: no ${table} row matches ${JSON.stringify(where)}`);
  if (rows.length > 1) throw new Error(`db-assert: expected exactly one ${table} row for ${JSON.stringify(where)}, found ${rows.length}`);

  const row = rows[0];
  for (const [column, expected] of Object.entries(fields ?? {})) {
    const actual = column in row ? row[column] : null;
    if (actual !== expected) {
      throw new Error(`db-assert: ${table}.${column} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
}

function stepCheck(db, check) {
  if (typeof check.count === 'number') return countCheck(db, check.table, check.count);
  if (check.where !== undefined) return rowCheck(db, check.table, check.where, check.fields);
  throw new Error('db-assert: each check needs "count" or "where"');
}

export default async function dbAssert({ cwd, phase, checks = [], dbFile = DB_FILE }) {
  const dbPath = path.join(cwd ?? '.', dbFile);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (phase === 'launch') {
      launchChecks(db);
      return;
    }
    for (const check of checks) stepCheck(db, check);
  } finally {
    db.close();
  }
}
