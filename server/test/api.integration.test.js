import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { createTestSchema, dropTestSchema } from './helpers/pgTestSchema.js';

// JWT_SECRET must be set, and the test schema created, before db.js / middleware/auth.js are first
// imported — both read env at module-load time — so index.js and db.js are imported dynamically below,
// never statically at the top of this file (a static import is hoisted and would run before this code).
process.env.JWT_SECRET = 'test-secret-not-for-production-use';
process.env.NODE_ENV = 'test';

const schema = await createTestSchema();
const { db, closeDb } = await import('../src/db.js');
const { app } = await import('../src/index.js');

let server, baseUrl;
const ids = {};

before(async () => {
  const superAdminId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, is_super_admin_protected) VALUES (?, ?, ?, ?, 'super_admin', 1)`)
    .run(superAdminId, 'Test Super Admin', 'super@test.local', bcrypt.hashSync('SuperPass123', 10));
  const adminId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`)
    .run(adminId, 'Test Admin', 'admin@test.local', bcrypt.hashSync('AdminPass123', 10));
  const employeeId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'employee')`)
    .run(employeeId, 'Test Employee', 'employee@test.local', bcrypt.hashSync('EmpPass123', 10));
  Object.assign(ids, { superAdminId, adminId, employeeId });

  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeDb();
  await dropTestSchema(schema);
});

async function login(email, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}

function authed(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

test('login — wrong password is rejected', async () => {
  const { status, body } = await login('admin@test.local', 'WrongPassword');
  assert.equal(status, 401);
  assert.match(body.error, /incorrect/i);
});

test('login — correct password succeeds and returns a usable token', async () => {
  const { status, body } = await login('admin@test.local', 'AdminPass123');
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.equal(body.user.email, 'admin@test.local');
  assert.equal(body.user.password_hash, undefined, 'the hash must never be sent to the client');
});

// Uses a throwaway email, not one of the seeded accounts — a locked-out account can never log in again
// within the window (by design), so reusing a real account here would break every later test using it.
test('login — locks out after repeated failures', async () => {
  for (let i = 0; i < 8; i++) await login('nobody@test.local', 'wrong');
  const { status, body } = await login('nobody@test.local', 'wrong');
  assert.equal(status, 429);
  assert.match(body.error, /too many/i);
});

test('reset-password — a plain admin cannot reset the protected super admin\'s password', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/users/${ids.superAdminId}/reset-password`, {
    method: 'POST', headers: authed(adminLogin.token), body: JSON.stringify({ password: 'NewPassword123' }),
  });
  assert.equal(res.status, 403);
});

test('reset-password — the super admin can reset their own password, which revokes their old token', async () => {
  const { body: saLogin } = await login('super@test.local', 'SuperPass123');
  const res = await fetch(`${baseUrl}/api/users/${ids.superAdminId}/reset-password`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ password: 'BrandNewPassword123' }),
  });
  assert.equal(res.status, 200);

  const stale = await fetch(`${baseUrl}/api/auth/me`, { headers: authed(saLogin.token) });
  assert.equal(stale.status, 401, 'the token issued before the reset must no longer work');

  const { status } = await login('super@test.local', 'BrandNewPassword123');
  assert.equal(status, 200, 'the new password must work');
});

test('users — password shorter than 8 characters is rejected on both create and reset', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const createRes = await fetch(`${baseUrl}/api/users`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ full_name: 'Short Pw', email: 'shortpw@test.local', password: 'short', role: 'employee' }),
  });
  assert.equal(createRes.status, 400);

  const resetRes = await fetch(`${baseUrl}/api/users/${ids.employeeId}/reset-password`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ password: 'short' }),
  });
  assert.equal(resetRes.status, 400);
});

test('scrum — resolving a task to Support Required requires a reason', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const headers = authed(empLogin.token);

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({ description: 'Reconcile the ledger', type: 'adhoc', due_date: '2026-09-15' }),
  });
  assert.equal(createRes.status, 201);
  const { commitment } = await createRes.json();

  const noReason = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/resolve`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'support_required' }),
  });
  assert.equal(noReason.status, 400, 'a reason-less Support Required must be rejected');

  const withReason = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/resolve`, {
    method: 'POST', headers, body: JSON.stringify({ status: 'support_required', non_completion_reason: 'Workload' }),
  });
  assert.equal(withReason.status, 200);
  const resolved = await withReason.json();
  assert.ok(resolved.request, 'a requests-table row must be created for the Leader to review');
  assert.equal(resolved.request.type, 'support');
});

test('scrum — an employee cannot edit another employee\'s task; a leader can', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ description: "Super Admin's own task", type: 'adhoc', due_date: '2026-09-20', employee_id: ids.superAdminId }),
  });
  const { commitment } = await createRes.json();

  const blocked = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/resolve`, {
    method: 'POST', headers: authed(empLogin.token), body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(blocked.status, 403, 'a plain employee must not be able to act on someone else\'s task');

  const allowed = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/resolve`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(allowed.status, 200, 'a leader-tier role must be able to act on anyone\'s task, org-wide');
});

test('auth — self-service change-password works for any role, rejects a wrong current password, and revokes the old session', async () => {
  // A dedicated throwaway account — mutating the shared 'employee@test.local' seeded account here would
  // break every later test that still logs in with its original password.
  const changePwId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'employee')`)
    .run(changePwId, 'Change Pw Test', 'changepw@test.local', bcrypt.hashSync('OriginalPass123', 10));

  const { body: empLogin } = await login('changepw@test.local', 'OriginalPass123');
  const headers = authed(empLogin.token);

  const wrongCurrent = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: 'POST', headers, body: JSON.stringify({ current_password: 'NotMyPassword', new_password: 'NewEmpPass456' }),
  });
  // 400, not 401 — the frontend force-logs-out on ANY 401, and a wrong current password on an otherwise
  // valid session must not do that (see the comment on this check in auth.js).
  assert.equal(wrongCurrent.status, 400, 'a wrong current password must be rejected without invalidating the session');

  const stillValid = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal(stillValid.status, 200, 'the session must still be valid after a wrong current-password attempt');

  const tooShort = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: 'POST', headers, body: JSON.stringify({ current_password: 'OriginalPass123', new_password: 'short' }),
  });
  assert.equal(tooShort.status, 400, 'a too-short new password must be rejected');

  const changed = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: 'POST', headers, body: JSON.stringify({ current_password: 'OriginalPass123', new_password: 'NewEmpPass456' }),
  });
  assert.equal(changed.status, 200);

  const stale = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal(stale.status, 401, 'the token used to change the password must no longer work afterward');

  const { status } = await login('changepw@test.local', 'NewEmpPass456');
  assert.equal(status, 200, 'the new password must work');
});

test('users — an admin can change a user\'s email, but not to one already in use', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const changed = await fetch(`${baseUrl}/api/users/${ids.employeeId}`, {
    method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ email: 'employee-renamed@test.local' }),
  });
  assert.equal(changed.status, 200);
  const { user } = await changed.json();
  assert.equal(user.email, 'employee-renamed@test.local');

  const duplicate = await fetch(`${baseUrl}/api/users/${ids.adminId}`, {
    method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ email: 'employee-renamed@test.local' }),
  });
  assert.equal(duplicate.status, 400, 'changing to an email already used by another account must be rejected');

  // Restore, so later tests that log in as 'employee@test.local' keep working.
  await fetch(`${baseUrl}/api/users/${ids.employeeId}`, {
    method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ email: 'employee@test.local' }),
  });
});

test('dashboard — an employee cannot view another employee\'s personal dashboard via employee_id', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const ownDashboard = await fetch(`${baseUrl}/api/dashboard/employee`, { headers: authed(empLogin.token) });
  assert.equal(ownDashboard.status, 200, 'an employee must be able to load their own dashboard');

  const spoofed = await fetch(`${baseUrl}/api/dashboard/employee?employee_id=${ids.superAdminId}`, { headers: authed(empLogin.token) });
  assert.equal(spoofed.status, 403, 'an employee must not be able to view a colleague\'s dashboard by changing employee_id');

  const leaderView = await fetch(`${baseUrl}/api/dashboard/employee?employee_id=${ids.employeeId}`, { headers: authed(saLogin.token) });
  assert.equal(leaderView.status, 200, 'a leader-tier role must still be able to view any employee\'s dashboard');
});

test('users — deleting a person with recurring-task assignments or scrum sessions is blocked, like other history', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const withRecurring = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'employee')`)
    .run(withRecurring, 'Has Recurring Task', 'recurring@test.local', bcrypt.hashSync('Pass12345', 10));
  await db.prepare(`INSERT INTO recurring_activities (id, employee_id, title) VALUES (?, ?, 'Weekly report')`).run(uuid(), withRecurring);

  const blockedRecurring = await fetch(`${baseUrl}/api/users/${withRecurring}`, { method: 'DELETE', headers: authed(saLogin.token) });
  assert.equal(blockedRecurring.status, 409, 'a user with a recurring-task assignment must not be hard-deleted');

  const withSession = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'employee')`)
    .run(withSession, 'Has Scrum Session', 'session@test.local', bcrypt.hashSync('Pass12345', 10));
  await db.prepare(`INSERT INTO scrum_sessions (id, employee_id, scrum_date) VALUES (?, ?, '2026-09-15')`).run(uuid(), withSession);

  const blockedSession = await fetch(`${baseUrl}/api/users/${withSession}`, { method: 'DELETE', headers: authed(saLogin.token) });
  assert.equal(blockedSession.status, 409, 'a user with a scrum session recorded must not be hard-deleted');
});
