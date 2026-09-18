import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '001_schema.sql'), 'utf8');

// Each test file runs in its own child process (node --test's default), so it's safe for every file to
// create and drop its own disposable Postgres schema in the same free Neon database used by production —
// full isolation without a second database, matching the old per-file temp-SQLite-file pattern this replaces.
export async function createTestSchema() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set (see .env.example, copy to server/.env) to run tests against Postgres.');
  }
  // Neon's pooled endpoint (PgBouncer, the "-pooler" hostname production uses) rejects the `options`
  // startup parameter this schema-isolation trick relies on ("unsupported startup parameter in options:
  // search_path") — tests connect directly to the compute endpoint instead, same database, just bypassing
  // the connection pooler. Harmless for a test suite's low connection count.
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace('-pooler.', '.');

  const schema = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const setupClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setupClient.connect();
  await setupClient.query(`CREATE SCHEMA "${schema}"`);
  await setupClient.end();

  // Must be set before db.js is first imported — db.js's pool reads it (via pg's PGOPTIONS support) when
  // it opens its first real connection, defaulting every unqualified table/function name to this schema.
  process.env.PGOPTIONS = `-c search_path=${schema}`;

  try {
    const { db } = await import('../../src/db.js');
    await db.exec(migrationSql);
  } catch (e) {
    await dropTestSchema(schema); // don't leave an empty schema behind if the migration itself fails
    throw e;
  }

  return schema;
}

export async function dropTestSchema(schema) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
}
