import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestSchema, dropTestSchema } from './helpers/pgTestSchema.js';

// Neon closes idle connections (its compute pauses after a few minutes of inactivity). An idle pooled
// connection dropped by the server makes the pool emit 'error'; with no listener that's an uncaught
// exception and the whole server process dies. Simulated here by terminating the pool's own connection.
process.env.NODE_ENV = 'test';
const schema = await createTestSchema();
const { db, closeDb } = await import('../src/db.js');

after(async () => {
  await closeDb();
  await dropTestSchema(schema);
});

test('db pool — a connection dropped while idle does not crash the server, and the next query still works', async () => {
  const { pid } = await db.prepare('SELECT pg_backend_pid() AS pid').get();

  const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await other.connect();
  await other.query('SELECT pg_terminate_backend($1)', [pid]);
  await other.end();
  await new Promise((resolve) => setTimeout(resolve, 1500)); // let the idle client notice and error out

  const { ok } = await db.prepare('SELECT 1 AS ok').get();
  assert.equal(ok, 1, 'the pool replaces the dropped connection');
});
