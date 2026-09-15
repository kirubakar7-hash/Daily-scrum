import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Regression test for the Critical fix: npm run reset used to omit `requests` from its wipe list, and
// since requests.commitment_id is a NOT NULL foreign key to commitments (with foreign_keys=ON), deleting
// commitments while a request still pointed at one crashed the script partway through. This seeds exactly
// that scenario — a commitment with a pending request against it — then runs the real reset.js as a
// subprocess and confirms it completes cleanly and actually empties both tables.
test('reset.js completes without a foreign-key crash when a request references a commitment', async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'dsm-reset-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  try {
    process.env.DB_PATH = dbPath;
    const { db, closeDb } = await import('../src/db.js');

    const superAdminId = uuid();
    db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, is_super_admin_protected) VALUES (?, ?, ?, ?, 'super_admin', 1)`)
      .run(superAdminId, 'Test Super Admin', 'super@reset-test.local', bcrypt.hashSync('SuperPass123', 10));
    const employeeId = uuid();
    db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'employee')`)
      .run(employeeId, 'Test Employee', 'employee@reset-test.local', bcrypt.hashSync('EmpPass123', 10));

    const commitmentId = uuid();
    db.prepare(`
      INSERT INTO commitments (id, employee_id, scrum_date, description, type, due_date, status)
      VALUES (?, ?, '2026-09-10', 'Test task', 'adhoc', '2026-09-15', 'support_required')
    `).run(commitmentId, employeeId);
    db.prepare(`
      INSERT INTO requests (id, commitment_id, type, requested_by, status)
      VALUES (?, ?, 'support', ?, 'pending')
    `).run(uuid(), commitmentId, employeeId);

    const before = db.prepare('SELECT COUNT(*) c FROM requests').get().c;
    assert.equal(before, 1, 'sanity check: the request row was actually seeded');
    closeDb(); // release the file before a second process (reset.js) opens the same path

    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'reset.js')], {
      env: { ...process.env, DB_PATH: dbPath, NODE_ENV: 'test' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, `reset.js exited non-zero: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /FOREIGN KEY constraint failed/i);

    const { DatabaseSync } = await import('node:sqlite');
    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(verifyDb.prepare('SELECT COUNT(*) c FROM requests').get().c, 0, 'requests table should be fully wiped');
    assert.equal(verifyDb.prepare('SELECT COUNT(*) c FROM commitments').get().c, 0, 'commitments table should be fully wiped');
    assert.equal(verifyDb.prepare('SELECT COUNT(*) c FROM users').get().c, 1, 'only the protected super admin should remain');
    verifyDb.close();
  } finally {
    delete process.env.DB_PATH;
    // Windows can briefly hold the SQLite WAL/SHM files open right after the child process exits —
    // retry instead of failing the whole test over a cleanup race unrelated to what's being tested.
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
