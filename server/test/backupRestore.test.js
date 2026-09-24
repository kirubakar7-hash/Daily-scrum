import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestSchema, dropTestSchema } from './helpers/pgTestSchema.js';
import { createBackup, decrypt, encrypt, restoreBackup } from '../scripts/dbBackup.js';

// A backup only counts once it has been restored: fill one disposable schema, back it up, encrypt and
// decrypt it, restore into a second empty schema, and compare every row.
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_schema.sql'), 'utf8');
const PASSPHRASE = 'correct horse battery staple';

const source = await createTestSchema(); // also sets PGOPTIONS so plain clients land in this schema
const target = `${source}_restore`;
let src;
let dst;

before(async () => {
  src = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await src.connect();
  const q = (sql, params) => src.query(sql, params);
  await q(`INSERT INTO teams (id, name) VALUES ('t1', 'AP Team')`);
  await q(`INSERT INTO users (id, full_name, email, password_hash, role, team_id) VALUES ('boss', 'Boss', 'boss@x.local', 'h1', 'leader', 't1')`);
  await q(`INSERT INTO users (id, full_name, email, password_hash, role, manager_id) VALUES ('emp', 'Emp', 'emp@x.local', 'h2', 'employee', 'boss')`);
  await q(`INSERT INTO recurring_activities (id, employee_id, title, recurrence_rule, series_start_date, created_by) VALUES ('ra1', 'emp', 'Daily check', '{"interval":1,"unit":"day"}', '2026-09-20', 'boss')`);
  await q(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, recurring_activity_id, priority, due_date, original_due_date, start_date, created_by, updated_by)
           VALUES ('c1', 'emp', '2026-09-20', 'Daily check', 'recurring', 'ra1', 'High', '2026-09-20', '2026-09-20', '2026-09-20', 'boss', 'boss')`);
  await q(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, priority, due_date, original_due_date, start_date, carried_forward_from_id, created_by, updated_by)
           VALUES ('c2', 'emp', '2026-09-21', 'Follow-up', 'adhoc', 'Low', '2026-09-22', '2026-09-21', '2026-09-21', 'c1', 'boss', 'boss')`);
  await q(`UPDATE commitments SET carried_forward_to_id = 'c2' WHERE id = 'c1'`);
  await q(`INSERT INTO audit_logs (id, table_name, record_id, field_name, new_value, changed_by, changed_by_name, owner_id) VALUES ('a1', 'commitments', 'c1', 'created', 'Daily check', 'boss', 'Boss', 'emp')`);

  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${target}"`);
  await admin.end();
  dst = new pg.Client({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${target}` });
  await dst.connect();
});

after(async () => {
  await src?.end();
  await dst?.end();
  await dropTestSchema(target);
  await dropTestSchema(source);
});

test('backup → encrypt → decrypt → restore gives back exactly the same data', async () => {
  const backup = await createBackup(src);
  const file = encrypt(Buffer.from(JSON.stringify(backup)), PASSPHRASE);
  assert.ok(!file.includes(Buffer.from('boss@x.local')), 'nothing readable in the file itself');
  const reopened = JSON.parse(decrypt(file, PASSPHRASE).toString('utf8'));

  const counts = await restoreBackup(dst, reopened, migrationSql);
  assert.equal(counts.users, 2);
  assert.equal(counts.commitments, 2);

  for (const table of Object.keys(backup.tables)) {
    const a = (await src.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows;
    const b = (await dst.query(`SELECT * FROM "${table}" ORDER BY 1`)).rows;
    assert.deepEqual(b, a, `${table} matches row for row`);
  }
  const boss = (await dst.query(`SELECT manager_id FROM users WHERE id = 'emp'`)).rows[0];
  assert.equal(boss.manager_id, 'boss', 'a self-link (manager) survives');
  const link = (await dst.query(`SELECT carried_forward_to_id FROM commitments WHERE id = 'c1'`)).rows[0];
  assert.equal(link.carried_forward_to_id, 'c2', 'a task-to-task link survives');

  const { rows: [next] } = await dst.query(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, priority, due_date, original_due_date, start_date, created_by, updated_by)
    VALUES ('c3', 'emp', '2026-09-23', 'New after restore', 'adhoc', 'Low', '2026-09-23', '2026-09-23', '2026-09-23', 'boss', 'boss') RETURNING seq`);
  const maxBefore = Math.max(...backup.tables.commitments.map((c) => Number(c.seq)));
  assert.ok(Number(next.seq) > maxBefore, 'new tasks keep numbering after the restored ones');
});

test('restore refuses a database that already has data, and a wrong passphrase is caught', async () => {
  const backup = await createBackup(src);
  await assert.rejects(() => restoreBackup(dst, backup, migrationSql), /already has users or tasks/);
  await assert.rejects(() => restoreBackup(src, backup, migrationSql), /already has users or tasks/, 'never over a live database');

  const file = encrypt(Buffer.from(JSON.stringify(backup)), PASSPHRASE);
  assert.throws(() => decrypt(file, 'the wrong passphrase!!'), /passphrase is wrong/);
  assert.throws(() => encrypt(Buffer.from('x'), 'short'), /at least 12 characters/);
});
