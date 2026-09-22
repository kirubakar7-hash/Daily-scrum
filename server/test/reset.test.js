import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { createTestSchema, dropTestSchema } from './helpers/pgTestSchema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression test for two Critical fixes found in this app's reset.js history:
// (1) npm run reset used to omit `requests` from its wipe list, and since requests.commitment_id is a
//     NOT NULL foreign key to commitments, deleting commitments while a request still pointed at one
//     crashed the script partway through.
// (2) It also omitted `main_tasks`/`task_activities` from its wipe list entirely, so `DELETE FROM
//     categories` (main_tasks.category_id -> categories.id, no ON DELETE clause) crashed on Postgres
//     whenever a Process still existed — SQLite's old, effectively-unenforced default silently allowed
//     this same delete order, masking the bug until the app moved to real Postgres.
// This seeds both scenarios — a commitment with a pending request against it, and a full Function ->
// Process -> Activity chain — then runs the real reset.js as a subprocess (pointed at this same
// disposable schema via PGOPTIONS) and confirms it completes cleanly and empties every table involved.
test('reset.js completes without a foreign-key crash when a request references a commitment, or when Function/Process/Activity data exists', async () => {
  const schema = await createTestSchema();
  try {
    const { db, closeDb } = await import('../src/db.js');

    const superAdminId = uuid();
    await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, is_super_admin_protected) VALUES (?, ?, ?, ?, 'super_admin', 1)`)
      .run(superAdminId, 'Test Super Admin', 'super@reset-test.local', bcrypt.hashSync('SuperPass123', 10));
    const employeeId = uuid();
    await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'employee')`)
      .run(employeeId, 'Test Employee', 'employee@reset-test.local', bcrypt.hashSync('EmpPass123', 10));

    const categoryId = uuid();
    await db.prepare(`INSERT INTO categories (id, name, created_by) VALUES (?, ?, ?)`).run(categoryId, 'Reset Test Finance', superAdminId);
    const mainTaskId = uuid();
    await db.prepare(`INSERT INTO main_tasks (id, name, category_id, created_by) VALUES (?, ?, ?, ?)`).run(mainTaskId, 'Reset Test FP&A', categoryId, superAdminId);
    const activityId = uuid();
    await db.prepare(`INSERT INTO task_activities (id, name, main_task_id, created_by) VALUES (?, ?, ?, ?)`).run(activityId, 'Reset Test Activity', mainTaskId, superAdminId);

    const commitmentId = uuid();
    await db.prepare(`
      INSERT INTO commitments (id, employee_id, scrum_date, description, type, due_date, status, category_id, main_task_id, task_activity_id)
      VALUES (?, ?, '2026-09-10', 'Test task', 'adhoc', '2026-09-15', 'support_required', ?, ?, ?)
    `).run(commitmentId, employeeId, categoryId, mainTaskId, activityId);
    await db.prepare(`
      INSERT INTO requests (id, commitment_id, type, requested_by, status)
      VALUES (?, ?, 'support', ?, 'pending')
    `).run(uuid(), commitmentId, employeeId);

    const before = await db.prepare('SELECT COUNT(*) c FROM requests').get();
    assert.equal(before.c, 1, 'sanity check: the request row was actually seeded');
    await closeDb(); // release the pool before a second process (reset.js) connects to the same schema

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'reset.js'), '--force'], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, PGOPTIONS: `-c search_path=${schema}`, NODE_ENV: 'test' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `reset.js exited non-zero: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /foreign key/i);

    const { db: verifyDb, closeDb: closeVerifyDb } = await import(`../src/db.js?verify=${schema}`);
    assert.equal((await verifyDb.prepare('SELECT COUNT(*) c FROM requests').get()).c, 0, 'requests table should be fully wiped');
    assert.equal((await verifyDb.prepare('SELECT COUNT(*) c FROM commitments').get()).c, 0, 'commitments table should be fully wiped');
    assert.equal((await verifyDb.prepare('SELECT COUNT(*) c FROM task_activities').get()).c, 0, 'task_activities should be fully wiped');
    assert.equal((await verifyDb.prepare('SELECT COUNT(*) c FROM main_tasks').get()).c, 0, 'main_tasks should be fully wiped');
    assert.equal((await verifyDb.prepare('SELECT COUNT(*) c FROM categories').get()).c, 0, 'categories should be fully wiped');
    assert.equal((await verifyDb.prepare('SELECT COUNT(*) c FROM users').get()).c, 1, 'only the protected super admin should remain');
    await closeVerifyDb();
  } finally {
    await dropTestSchema(schema);
  }
});
