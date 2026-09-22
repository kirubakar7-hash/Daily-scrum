import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getBusinessDate } from './lib/businessDate.js';

// PostgreSQL replaces the old local SQLite file (see CHANGE_HISTORY.md / MIGRATION.md for why: a single
// file on a single disk cannot survive a real multi-instance, multi-tenant-ready production deployment).
// DATABASE_URL is required in every environment — there is no local-file fallback anymore.
if (!process.env.DATABASE_URL) {
  console.error('Refusing to start: DATABASE_URL environment variable is required (PostgreSQL connection string).');
  process.exit(1);
}

// node-postgres returns BIGINT (OID 20) — what COUNT(*) produces — as a string by default, to avoid
// silently truncating values past Number.MAX_SAFE_INTEGER. Every count in this app (task/user/team
// totals) is tiny, and 53 call sites across dashboard.js/history.js/etc. read `.c` expecting the number
// SQLite always gave them (some feed straight into arithmetic, e.g. `total > rows.length`), so this is
// fixed once, centrally, rather than wrapping every call site in a parseInt.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Route-code call sites are written as `db.prepare(sql).run(...params)` against SQLite's `?` positional
// placeholders (better-sqlite3-style), and many embed SQLite's datetime('now'[, offset]) function inline
// (e.g. `updated_at=datetime('now')`, or dashboard.js's 30-day-scoped `datetime('now', '-30 days')`).
// Rather than rewriting every one of the 284 call sites across 19 files, both translations happen once,
// centrally, here — every existing query string keeps working completely unchanged. now_utc()/
// now_utc_offset() are defined in migrations/001_schema.sql to reproduce SQLite's exact output format.
function toPgSql(sql) {
  let translated = sql
    .replace(/datetime\('now',\s*'(-?\d+)\s*days?'\)/g, (_, n) => `now_utc_offset(${n})`)
    .replace(/datetime\('now'\)/g, 'now_utc()');
  let i = 0;
  return translated.replace(/\?/g, () => `$${++i}`);
}

// A transaction needs every query inside it to run on the SAME checked-out connection, not a fresh one
// from the pool per call — AsyncLocalStorage carries "the current transaction's client" implicitly through
// whatever async call chain is inside a db.transaction(...) callback, so ordinary db.prepare(...) call
// sites don't need to know or care whether they're inside a transaction.
const txContext = new AsyncLocalStorage();

async function query(sql, params) {
  const client = txContext.getStore();
  const pgSql = toPgSql(sql);
  if (client) return client.query(pgSql, params);
  return pool.query(pgSql, params);
}

export const db = {
  exec: async (sql) => { await query(sql, []); },
  prepare: (sql) => ({
    run: async (...params) => {
      const res = await query(sql, params);
      return { changes: res.rowCount, lastInsertRowid: undefined };
    },
    get: async (...params) => {
      const res = await query(sql, params);
      return res.rows[0];
    },
    all: async (...params) => {
      const res = await query(sql, params);
      return res.rows;
    },
  }),
  // Wraps a multi-statement write sequence so a thrown error rolls everything back — same guarantee the
  // SQLite version gave, just over a real transaction now instead of SQLite's implicit-per-statement
  // autocommit. Existing call sites use this as `await db.transaction(async () => {...})` — runs
  // immediately and returns the callback's result, matching the old synchronous db.transaction(fn) shape
  // (not better-sqlite3's real "returns a reusable function" API) so no call site needs restructuring.
  // Every db.prepare(...) call inside `fn` automatically joins this same transaction via the
  // AsyncLocalStorage context above.
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txContext.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};

// This app's business date is India Standard Time, not the server process's own UTC wall clock — see
// lib/businessDate.js for why that distinction matters and how it's computed. today() keeps this exact
// name/signature since ~15 call sites across the routes already depend on it; only what it computes changed.
export function today() {
  return getBusinessDate();
}

// Only needed by tests, which need every pool connection released before a test run's temp resources can
// be cleaned up — the running app itself never calls this, it stays open for the process's whole life.
export async function closeDb() {
  await pool.end();
}
