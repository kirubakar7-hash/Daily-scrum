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
const { db, closeDb, today } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const { generateDueOccurrences, insertOccurrence } = await import('../src/lib/recurringOccurrences.js');

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

  // Hierarchy fixture: topLeaderId -> {midLeaderAId, midLeaderBId} -> {reportAId, reportBId}, mirroring
  // the real Anudeep -> {Rajeshwari, Renuka} -> {Shreenidhi, Jeyant} chain this feature was built for.
  const topLeaderId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, manager_id) VALUES (?, ?, ?, ?, 'leader', ?)`)
    .run(topLeaderId, 'Top Leader', 'topleader@test.local', bcrypt.hashSync('TopLead123', 10), superAdminId);
  const midLeaderAId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, manager_id) VALUES (?, ?, ?, ?, 'leader', ?)`)
    .run(midLeaderAId, 'Mid Leader A', 'midleadera@test.local', bcrypt.hashSync('MidLeadA123', 10), topLeaderId);
  const midLeaderBId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, manager_id) VALUES (?, ?, ?, ?, 'leader', ?)`)
    .run(midLeaderBId, 'Mid Leader B', 'midleaderb@test.local', bcrypt.hashSync('MidLeadB123', 10), topLeaderId);
  const reportAId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, manager_id) VALUES (?, ?, ?, ?, 'employee', ?)`)
    .run(reportAId, 'Report A', 'reporta@test.local', bcrypt.hashSync('ReportA123', 10), midLeaderAId);
  const reportBId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, manager_id) VALUES (?, ?, ?, ?, 'employee', ?)`)
    .run(reportBId, 'Report B', 'reportb@test.local', bcrypt.hashSync('ReportB123', 10), midLeaderBId);
  Object.assign(ids, { topLeaderId, midLeaderAId, midLeaderBId, reportAId, reportBId });

  const todayStr = today();
  const midLeaderATaskId = uuid();
  await db.prepare(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, priority, due_date, original_due_date, start_date, created_by, updated_by)
    VALUES (?, ?, ?, 'Mid Leader A task', 'adhoc', 'Medium', ?, ?, ?, ?, ?)`)
    .run(midLeaderATaskId, midLeaderAId, todayStr, todayStr, todayStr, todayStr, midLeaderAId, midLeaderAId);
  Object.assign(ids, { midLeaderATaskId });

  const reportATaskId = uuid();
  await db.prepare(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, priority, due_date, original_due_date, start_date, created_by, updated_by)
    VALUES (?, ?, ?, 'Report A task', 'adhoc', 'Medium', ?, ?, ?, ?, ?)`)
    .run(reportATaskId, reportAId, todayStr, todayStr, todayStr, todayStr, reportAId, reportAId);
  const reportBTaskId = uuid();
  await db.prepare(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, priority, due_date, original_due_date, start_date, created_by, updated_by)
    VALUES (?, ?, ?, 'Report B task', 'adhoc', 'Medium', ?, ?, ?, ?, ?)`)
    .run(reportBTaskId, reportBId, todayStr, todayStr, todayStr, todayStr, reportBId, reportBId);
  Object.assign(ids, { reportATaskId, reportBTaskId });

  // Shared Function/Process/Activity fixture — every actual task now requires all three (see
  // scrum.js/recurringTasks.js), so any test that just needs "a task" as a fixture for unrelated
  // behavior (requests, history, import, etc.) can reuse these instead of building its own each time.
  const fixtureCategoryId = uuid();
  await db.prepare(`INSERT INTO categories (id, name, created_by) VALUES (?, ?, ?)`).run(fixtureCategoryId, 'Test Fixture Finance', superAdminId);
  const fixtureMainTaskId = uuid();
  await db.prepare(`INSERT INTO main_tasks (id, name, category_id, created_by) VALUES (?, ?, ?, ?)`).run(fixtureMainTaskId, 'Test Fixture FP&A', fixtureCategoryId, superAdminId);
  const fixtureActivityId = uuid();
  await db.prepare(`INSERT INTO task_activities (id, name, main_task_id, created_by) VALUES (?, ?, ?, ?)`).run(fixtureActivityId, 'Test Fixture Activity', fixtureMainTaskId, superAdminId);
  Object.assign(ids, { fixtureCategoryId, fixtureMainTaskId, fixtureActivityId });

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
    method: 'POST', headers, body: JSON.stringify({
      description: 'Reconcile the ledger', type: 'adhoc', due_date: '2026-09-15',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
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

  // Team Tasks' "Action Required" indicator (this session's replacement for the old standalone Requests
  // tab) depends on org-tasks/team-tasks surfacing the pending request inline on the task's own row.
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const orgTasks = await fetch(`${baseUrl}/api/leader/org-tasks`, { headers: authed(saLogin.token) });
  const { tasks } = await orgTasks.json();
  const row = tasks.find((t) => t.id === commitment.id);
  assert.ok(row, 'the task must still appear in org-tasks (Support Required tasks stay in the working view)');
  assert.equal(row.pending_request_id, resolved.request.id, 'the row must carry the real pending request id, not a placeholder');
  assert.equal(row.pending_request_type, 'support');
});

test('scrum — an employee cannot edit another employee\'s task; a leader can', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({
      description: "Super Admin's own task", type: 'adhoc', due_date: '2026-09-20', employee_id: ids.superAdminId,
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
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

test('scrum PATCH — an Admin/Super Admin can reassign a task\'s Owner, Process, and Activity; a Leader cannot', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({
      description: 'Reassignment test task', type: 'adhoc', due_date: '2026-09-20', employee_id: ids.reportAId,
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  const { commitment } = await createRes.json();

  // A Leader can still edit fields they're always allowed to (description) on a task in their chain, but
  // an Owner/Process/Activity reassignment they send must be silently ignored, not applied.
  const leaderAttempt = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}`, {
    method: 'PATCH', headers: authed(midLeaderALogin.token),
    body: JSON.stringify({ description: 'Edited by a Leader', employee_id: ids.reportBId }),
  });
  assert.equal(leaderAttempt.status, 200);
  const afterLeader = (await leaderAttempt.json()).commitment;
  assert.equal(afterLeader.description, 'Edited by a Leader', 'a Leader\'s permitted field edit must still apply');
  assert.equal(afterLeader.employee_id, ids.reportAId, 'a Leader\'s attempted owner reassignment must be silently ignored, not applied');

  const adminEdit = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}`, {
    method: 'PATCH', headers: authed(saLogin.token),
    body: JSON.stringify({ employee_id: ids.reportBId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId }),
  });
  assert.equal(adminEdit.status, 200);
  const afterAdmin = (await adminEdit.json()).commitment;
  assert.equal(afterAdmin.employee_id, ids.reportBId, 'a Super Admin must be able to reassign the task\'s Owner');
});

test('scrum PATCH — an Admin cannot flip a task between Recurring and Ad-hoc via task_type_id', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const headers = authed(saLogin.token);

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers,
    body: JSON.stringify({
      description: 'Mechanic-switch test task', type: 'adhoc', due_date: '2026-09-20', employee_id: ids.reportAId,
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  const { commitment } = await createRes.json();

  const recurringType = await db.prepare(`SELECT id FROM task_types WHERE mechanic = 'recurring' AND is_active = 1 LIMIT 1`).get();
  const res = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ task_type_id: recurringType.id }),
  });
  assert.equal(res.status, 400, 'an Ad-hoc task must not be switchable to a Recurring type through this general edit');
});

test('auth — every user can change their own name, and only their name', async () => {
  const selfId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, 'Rename Me', 'renameme@test.local', ?, 'employee')`)
    .run(selfId, bcrypt.hashSync('RenamePass123', 10));
  const { body: session } = await login('renameme@test.local', 'RenamePass123');
  const patchMe = (body, headers = authed(session.token)) => fetch(`${baseUrl}/api/auth/me`, { method: 'PATCH', headers, body: JSON.stringify(body) });

  const ok = await patchMe({ full_name: '  Priya   Sharma ', role: 'super_admin', email: 'hijack@test.local' });
  assert.equal(ok.status, 200);
  const { user } = await ok.json();
  assert.equal(user.full_name, 'Priya Sharma', 'trimmed, with inner spaces tidied');
  assert.equal(user.role, 'employee', 'role cannot be changed this way');
  assert.equal(user.email, 'renameme@test.local', 'email cannot be changed this way');
  assert.equal(user.password_hash, undefined, 'the password hash is never sent back');

  const me = await (await fetch(`${baseUrl}/api/auth/me`, { headers: authed(session.token) })).json();
  assert.equal(me.user.full_name, 'Priya Sharma', 'the new name is what the app shows from now on');
  const stored = await db.prepare('SELECT full_name, role, email FROM users WHERE id = ?').get(selfId);
  assert.deepEqual(stored, { full_name: 'Priya Sharma', role: 'employee', email: 'renameme@test.local' });

  const audit = await db.prepare(`SELECT old_value, new_value, changed_by FROM audit_logs WHERE record_id = ? AND field_name = 'full_name'`).get(selfId);
  assert.deepEqual(audit, { old_value: 'Rename Me', new_value: 'Priya Sharma', changed_by: selfId });

  assert.equal((await patchMe({ full_name: '   ' })).status, 400, 'a blank name is refused');
  assert.equal((await patchMe({ full_name: 'x'.repeat(101) })).status, 400, 'an over-long name is refused');
  assert.equal((await patchMe({})).status, 400);
  assert.equal((await patchMe({ full_name: 'Nobody' }, { 'Content-Type': 'application/json' })).status, 401, 'signed-out requests are rejected');
  assert.equal((await db.prepare('SELECT full_name FROM users WHERE id = ?').get(selfId)).full_name, 'Priya Sharma', 'nothing refused was saved');
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

// An Admin (not Super Admin) minting their own Super Admin account was a real, confirmed privilege-
// escalation path: requireRole('super_admin','admin') let an Admin through to POST/PATCH /api/users, and
// the only role-related guard (is_super_admin_protected) only protects the one designated account, not
// the super_admin role itself.
test('users — an Admin cannot create a new user with role=super_admin', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/users`, {
    method: 'POST', headers: authed(adminLogin.token),
    body: JSON.stringify({ full_name: 'Sneaky Admin', email: 'sneaky-super@test.local', password: 'SneakyPass123', role: 'super_admin' }),
  });
  assert.equal(res.status, 403);
  const found = await db.prepare('SELECT id FROM users WHERE lower(email) = ?').get('sneaky-super@test.local');
  assert.equal(found, undefined, 'no super_admin row must have been created');
});

test('users — an Admin cannot promote an existing ordinary user to role=super_admin', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/users/${ids.employeeId}`, {
    method: 'PATCH', headers: authed(adminLogin.token), body: JSON.stringify({ role: 'super_admin' }),
  });
  assert.equal(res.status, 403);
  const after = await db.prepare('SELECT role FROM users WHERE id = ?').get(ids.employeeId);
  assert.equal(after.role, 'employee', 'the target\'s role must be completely unchanged after a rejected promotion attempt');
});

test('users — a real Super Admin can still create and promote to super_admin (the guard is role-based, not a blanket ban)', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const created = await fetch(`${baseUrl}/api/users`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ full_name: 'Second Super Admin', email: 'second-super@test.local', password: 'SecondSuper123', role: 'super_admin' }),
  });
  assert.equal(created.status, 201, 'a genuine Super Admin must still be able to create another Super Admin account');
  const { user } = await created.json();
  assert.equal(user.role, 'super_admin');
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

test('scrum — only Super Admin can delete a task they didn\'t create themselves; other leader-tier roles cannot', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(empLogin.token),
    body: JSON.stringify({
      description: 'Employee-created task', type: 'adhoc', due_date: '2026-09-20',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  const { commitment } = await createRes.json();

  const blockedForAdmin = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}`, { method: 'DELETE', headers: authed(adminLogin.token) });
  assert.equal(blockedForAdmin.status, 403, 'an admin who did not create the task must still be blocked, unchanged from before');

  const allowedForSuperAdmin = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}`, { method: 'DELETE', headers: authed(saLogin.token) });
  assert.equal(allowedForSuperAdmin.status, 200, 'Super Admin must be able to delete any task, regardless of who created it');
});

test('import — users: one valid row succeeds, one row with a pre-existing email fails, both reported per-row', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/users/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { full_name: 'Imported Person', email: 'imported1@test.local', password: 'ImportPass123', role: 'employee' },
      { full_name: 'Duplicate', email: 'admin@test.local', password: 'ImportPass123', role: 'employee' },
    ] }),
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results[0].success, true, 'a valid new row must succeed');
  assert.equal(results[1].success, false, 'a row reusing an existing email must fail');
  assert.match(results[1].error, /already exists/i);

  const loginAsImported = await login('imported1@test.local', 'ImportPass123');
  assert.equal(loginAsImported.status, 200, 'the imported user must actually be able to log in');
});

test('import — teams: valid row succeeds, a duplicate name within the same file fails', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/teams/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { name: 'Imported Team' },
      { name: 'Imported Team' },
    ] }),
  });
  const { results } = await res.json();
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.match(results[1].error, /duplicate/i);
});

test('teams — a team\'s leader is computed from who most members report to, not a stored field', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const teamRes = await fetch(`${baseUrl}/api/teams`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ name: 'Computed Leader Team' }),
  });
  const { team } = await teamRes.json();

  await fetch(`${baseUrl}/api/users/${ids.midLeaderAId}`, { method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ team_id: team.id }) });
  await fetch(`${baseUrl}/api/users/${ids.reportAId}`, { method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ team_id: team.id }) });

  const teamsRes = await fetch(`${baseUrl}/api/teams`, { headers: authed(saLogin.token) });
  const { teams } = await teamsRes.json();
  const updated = teams.find((t) => t.id === team.id);
  assert.equal(updated.leader_name, 'Mid Leader A', 'Mid Leader A manages the other member (Report A), so they must be the computed leader');
  assert.equal('leader_user_id' in updated, false, 'leader_user_id is no longer a field the API returns — leader_name is computed instead');
});

test('import — task types: valid row succeeds, row with an invalid mechanic fails', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/task-types/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { name: 'Imported Type', mechanic: 'adhoc' },
      { name: 'Bad Mechanic Type', mechanic: 'sometimes' },
    ] }),
  });
  const { results } = await res.json();
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
});

test('import — categories: valid row succeeds, duplicate name within the same file fails', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/categories/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { name: 'Imported Category', description: 'A test category' },
      { name: 'Imported Category', description: 'Same name again' },
    ] }),
  });
  const { results } = await res.json();
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false, 'a duplicate name within the same file must be caught, not just against existing rows');
  assert.match(results[1].error, /duplicate/i);
});

test('import — recurring tasks: assigns by employee email, reports rows whose emails match nobody', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/recurring-tasks/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { title: 'Imported recurring task', employee_emails: 'employee@test.local; nobody-such@test.local', frequency: 'Daily', category_name: 'Test Fixture Finance', main_task_name: 'Test Fixture FP&A', activity_name: 'Test Fixture Activity' },
      { title: 'Nobody matches', employee_emails: 'nobody-such@test.local' },
    ] }),
  });
  const { results } = await res.json();
  assert.equal(results[0].success, true, 'the row succeeds because one of its two listed emails (employee@test.local) resolves, even though the other does not');
  assert.match(results[0].note, /1 of 2/, 'the partial-match note should say how many of the listed people actually got the task');
  assert.equal(results[1].success, false);
  assert.match(results[1].error, /none of the listed emails/i);
});

test('main tasks — a recurring task tagged with a Category and Main Task carries both onto its seed commitment, and the Main Task cannot be deleted while in use', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const categoryRes = await fetch(`${baseUrl}/api/categories`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ name: 'Finance' }),
  });
  const { category } = await categoryRes.json();

  const mainTaskRes = await fetch(`${baseUrl}/api/main-tasks`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ name: 'FP&A', category_id: category.id }),
  });
  assert.equal(mainTaskRes.status, 201);
  const { main_task: mainTask } = await mainTaskRes.json();
  assert.equal(mainTask.category_id, category.id);

  const activityRes = await fetch(`${baseUrl}/api/task-activities`, {
    method: 'POST', headers: authed(saLogin.token), body: JSON.stringify({ name: 'Monthly close checklist activity', main_task_id: mainTask.id }),
  });
  const { task_activity: taskActivity } = await activityRes.json();

  const recurringRes = await fetch(`${baseUrl}/api/recurring-tasks`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({
      title: 'Monthly close checklist', employee_ids: [ids.employeeId],
      category_id: category.id, main_task_id: mainTask.id, task_activity_id: taskActivity.id, frequency: 'Daily',
    }),
  });
  assert.equal(recurringRes.status, 201);
  const { recurring_tasks: [activity] } = await recurringRes.json();
  assert.equal(activity.main_task_id, mainTask.id, 'the recurring template itself must carry the Main Task');

  const seedCommitment = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ?').get(activity.id);
  assert.equal(seedCommitment.category_id, category.id, 'the seed commitment must carry the Category, same as it always has');
  assert.equal(seedCommitment.main_task_id, mainTask.id, 'the seed commitment must also carry the Main Task, not just the recurring_activities row');

  const blockedDelete = await fetch(`${baseUrl}/api/main-tasks/${mainTask.id}`, { method: 'DELETE', headers: authed(saLogin.token) });
  assert.equal(blockedDelete.status, 409, 'a Main Task already used by a task or template must be blocked from deletion, like Category and Task Type');
});

test('task activities — a task tagged with an Activity carries it through, cannot use an inactive Activity, and cannot be deleted while in use', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const headers = authed(saLogin.token);

  const categoryRes = await fetch(`${baseUrl}/api/categories`, { method: 'POST', headers, body: JSON.stringify({ name: 'Finance QA' }) });
  const { category } = await categoryRes.json();
  const mainTaskRes = await fetch(`${baseUrl}/api/main-tasks`, { method: 'POST', headers, body: JSON.stringify({ name: 'GL Ops QA', category_id: category.id }) });
  const { main_task: mainTask } = await mainTaskRes.json();

  const activityRes = await fetch(`${baseUrl}/api/task-activities`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Journal entry QA', main_task_id: mainTask.id }),
  });
  assert.equal(activityRes.status, 201);
  const { task_activity: activity } = await activityRes.json();
  assert.equal(activity.main_task_id, mainTask.id);

  const listRes = await fetch(`${baseUrl}/api/task-activities`, { headers });
  const { task_activities: listed } = await listRes.json();
  const found = listed.find((a) => a.id === activity.id);
  assert.equal(found.main_task_name, 'GL Ops QA', 'the list endpoint must join in the Main Task name');

  const taskRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.employeeId, description: 'Post journal entries', type: 'adhoc', due_date: '2026-09-25',
      category_id: category.id, main_task_id: mainTask.id, task_activity_id: activity.id,
    }),
  });
  assert.equal(taskRes.status, 201);
  const { commitment } = await taskRes.json();
  assert.equal(commitment.task_activity_id, activity.id, 'the commitment must carry the Activity through');

  await fetch(`${baseUrl}/api/task-activities/${activity.id}`, { method: 'PATCH', headers, body: JSON.stringify({ is_active: false }) });
  const rejectedTask = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.employeeId, description: 'Should fail', type: 'adhoc', due_date: '2026-09-25', task_activity_id: activity.id,
    }),
  });
  assert.equal(rejectedTask.status, 400, 'an inactive Activity must not be assignable to a new task');

  const blockedDelete = await fetch(`${baseUrl}/api/task-activities/${activity.id}`, { method: 'DELETE', headers });
  assert.equal(blockedDelete.status, 409, 'an Activity already used by a task must be blocked from deletion, like Main Task/Category/Task Type');
});

test('finance structure — a task cannot be created without Process and Activity', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const headers = authed(saLogin.token);

  const noMainTask = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.employeeId, description: 'Missing Process', type: 'adhoc', due_date: '2026-09-25', category_id: ids.fixtureCategoryId,
    }),
  });
  assert.equal(noMainTask.status, 400);
  assert.match((await noMainTask.json()).error, /process/i);

  const noActivity = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.employeeId, description: 'Missing Activity', type: 'adhoc', due_date: '2026-09-25',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId,
    }),
  });
  assert.equal(noActivity.status, 400);
  assert.match((await noActivity.json()).error, /activity/i);
});

test('finance structure — Function is no longer asked for: auto-resolved when exactly one is active, still a real required choice if more than one is', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const headers = authed(saLogin.token);

  // Snapshot every OTHER category's current is_active so it can be restored exactly, regardless of what
  // earlier tests left behind — this test must never permanently change global fixture state for tests
  // that run after it.
  const others = await db.prepare(`SELECT id, is_active FROM categories WHERE id != ?`).all(ids.fixtureCategoryId);
  await db.prepare(`UPDATE categories SET is_active = 0 WHERE id != ?`).run(ids.fixtureCategoryId);
  try {
    const autoResolved = await fetch(`${baseUrl}/api/scrum/commitments`, {
      method: 'POST', headers, body: JSON.stringify({
        employee_id: ids.employeeId, description: 'Auto-resolved Function', type: 'adhoc', due_date: '2026-09-25',
        main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
      }),
    });
    assert.equal(autoResolved.status, 201, 'omitting Function must succeed when exactly one Function is active');
    const { commitment } = await autoResolved.json();
    assert.equal(commitment.category_id, ids.fixtureCategoryId, 'must auto-resolve to the single active Function, not leave it null');
  } finally {
    for (const o of others) await db.prepare(`UPDATE categories SET is_active = ? WHERE id = ?`).run(o.is_active, o.id);
  }

  // With more than one Function active again (restored above), auto-resolving would be a real guess —
  // the original required-field error must come back instead of silently picking one.
  const ambiguous = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.employeeId, description: 'Ambiguous Function', type: 'adhoc', due_date: '2026-09-25',
      main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  assert.equal(ambiguous.status, 400, 'omitting Function must still fail once more than one Function exists');
  assert.match((await ambiguous.json()).error, /function/i);
});

test('finance structure — Reviewer defaults to the employee\'s manager but can be overridden, and a Function/Process cannot be deleted while a child record is parked under it', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const headers = authed(saLogin.token);

  const defaulted = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.reportAId, description: 'Reviewer default test', type: 'adhoc', due_date: '2026-09-25',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  assert.equal(defaulted.status, 201);
  const { commitment: defaultedCommitment } = await defaulted.json();
  assert.equal(defaultedCommitment.reviewer_id, ids.midLeaderAId, 'Reviewer must default to the employee\'s own manager when not specified');

  const overridden = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers, body: JSON.stringify({
      employee_id: ids.reportAId, description: 'Reviewer override test', type: 'adhoc', due_date: '2026-09-25',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId, reviewer_id: ids.topLeaderId,
    }),
  });
  assert.equal(overridden.status, 201);
  const { commitment: overriddenCommitment } = await overridden.json();
  assert.equal(overriddenCommitment.reviewer_id, ids.topLeaderId, 'an explicitly chosen Reviewer must override the manager default');

  // A brand-new Function/Process pair, unused by any task — the delete-guard here must fire purely
  // because of the parent/child master-data relationship, not because of task usage.
  const categoryRes = await fetch(`${baseUrl}/api/categories`, { method: 'POST', headers, body: JSON.stringify({ name: 'Empty Function QA' }) });
  const { category: emptyCategory } = await categoryRes.json();
  const mainTaskRes = await fetch(`${baseUrl}/api/main-tasks`, { method: 'POST', headers, body: JSON.stringify({ name: 'Empty Process QA', category_id: emptyCategory.id }) });
  const { main_task: emptyMainTask } = await mainTaskRes.json();
  const activityRes = await fetch(`${baseUrl}/api/task-activities`, { method: 'POST', headers, body: JSON.stringify({ name: 'Unused Activity QA', main_task_id: emptyMainTask.id }) });
  assert.equal(activityRes.status, 201);

  const blockedCategoryDelete = await fetch(`${baseUrl}/api/categories/${emptyCategory.id}`, { method: 'DELETE', headers });
  assert.equal(blockedCategoryDelete.status, 409, 'a Function with a Process still parked under it must not be deletable, even with zero tasks using either');

  const blockedMainTaskDelete = await fetch(`${baseUrl}/api/main-tasks/${emptyMainTask.id}`, { method: 'DELETE', headers });
  assert.equal(blockedMainTaskDelete.status, 409, 'a Process with an Activity still parked under it must not be deletable, even with zero tasks using either');
});

test('hierarchy — a Leader can view and act on a direct report\'s task', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const view = await fetch(`${baseUrl}/api/scrum/today?employee_id=${ids.reportAId}`, { headers: authed(midLeaderALogin.token) });
  assert.equal(view.status, 200);
  const act = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportATaskId}/resolve`, {
    method: 'POST', headers: authed(midLeaderALogin.token), body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(act.status, 200);
});

test('hierarchy — a Leader cannot view or act on an unrelated employee\'s task', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const view = await fetch(`${baseUrl}/api/scrum/today?employee_id=${ids.reportBId}`, { headers: authed(midLeaderALogin.token) });
  assert.equal(view.status, 403, 'Mid Leader A must not be able to view Report B, who reports to Mid Leader B instead');
  const act = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportBTaskId}/resolve`, {
    method: 'POST', headers: authed(midLeaderALogin.token), body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(act.status, 403);
});

test('hierarchy — a Leader two levels up can view and act on a subordinate-of-a-subordinate\'s task', async () => {
  const { body: topLeaderLogin } = await login('topleader@test.local', 'TopLead123');
  const viewMid = await fetch(`${baseUrl}/api/scrum/today?employee_id=${ids.midLeaderAId}`, { headers: authed(topLeaderLogin.token) });
  assert.equal(viewMid.status, 200, 'one level down (a Leader reporting to the Top Leader)');
  const viewReport = await fetch(`${baseUrl}/api/scrum/today?employee_id=${ids.reportAId}`, { headers: authed(topLeaderLogin.token) });
  assert.equal(viewReport.status, 200, 'two levels down (an Employee reporting to a Leader who reports to the Top Leader)');
  const act = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportATaskId}/resolve`, {
    method: 'POST', headers: authed(topLeaderLogin.token), body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(act.status, 200);
});

test('hierarchy — a plain Employee cannot see a coworker\'s task via History', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const res = await fetch(`${baseUrl}/api/history/commitments?employee_id=${ids.reportBId}`, { headers: authed(reportALogin.token) });
  const { commitments } = await res.json();
  assert.deepEqual(commitments, [], 'an out-of-scope employee_id filter must collapse to an empty result, not fall back to showing everyone');
});

test('hierarchy — a plain Employee\'s Team Tasks view only shows their own task', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const res = await fetch(`${baseUrl}/api/leader/org-tasks`, { headers: authed(reportALogin.token) });
  const { tasks } = await res.json();
  const taskIds = tasks.map((t) => t.id);
  assert.ok(taskIds.includes(ids.reportATaskId), 'must include their own task');
  assert.ok(!taskIds.includes(ids.reportBTaskId), 'must not include a coworker\'s task');
});

test('hierarchy — org-tasks includes Leaders\'/Admins\' own tasks for wide-open roles, not just Employees\' tasks', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');

  // A task belonging to a Leader themselves (not one of their reports) — allActiveUsers() must include
  // Leaders/Admins in its population, not just role='employee', or this would never show up for another
  // wide-open-role viewer.
  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({
      description: 'Top Leader\'s own task', type: 'adhoc', due_date: '2026-09-20', employee_id: ids.topLeaderId,
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  assert.equal(createRes.status, 201);
  const { commitment } = await createRes.json();

  const res = await fetch(`${baseUrl}/api/leader/org-tasks`, { headers: authed(adminLogin.token) });
  const { tasks } = await res.json();
  assert.ok(tasks.some((t) => t.id === commitment.id), 'an Admin must see a Leader\'s own task in org-tasks, same as any Employee\'s');
});

test('hierarchy — Admin\'s own Dashboard counts every active user, org-wide, not just Employees', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/dashboard/leader`, { headers: authed(adminLogin.token) });
  const data = await res.json();
  assert.ok(data.team_members >= 8, 'must count every active user (Leaders and Admins included), not just role=employee');
});

test('hierarchy — GET /api/users is scoped to self+reports for a Leader, stays org-wide for Admin', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const leaderRes = await fetch(`${baseUrl}/api/users`, { headers: authed(midLeaderALogin.token) });
  const { users: leaderUsers } = await leaderRes.json();
  const leaderIds = leaderUsers.map((u) => u.id).sort();
  assert.deepEqual(leaderIds, [ids.midLeaderAId, ids.reportAId].sort(), 'Mid Leader A must see only themself and Report A');

  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const adminRes = await fetch(`${baseUrl}/api/users`, { headers: authed(adminLogin.token) });
  const { users: adminUsers } = await adminRes.json();
  assert.ok(adminUsers.length >= 8, 'an Admin must still see every user, org-wide, unchanged');
});

test('hierarchy — Requests inbox is scoped: a Leader can only approve requests about their own reports', async () => {
  const { body: reportBLogin } = await login('reportb@test.local', 'ReportB123');
  const requestRes = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportBTaskId}/request-due-date-change`, {
    method: 'POST', headers: authed(reportBLogin.token), body: JSON.stringify({ requested_due_date: '2099-01-01' }),
  });
  assert.equal(requestRes.status, 201);
  const { request } = await requestRes.json();

  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const wrongLeaderApprove = await fetch(`${baseUrl}/api/requests/${request.id}/approve`, { method: 'POST', headers: authed(midLeaderALogin.token) });
  assert.equal(wrongLeaderApprove.status, 403, 'Mid Leader A must not be able to approve a request belonging to Report B (Mid Leader B\'s report)');

  const { body: midLeaderBLogin } = await login('midleaderb@test.local', 'MidLeadB123');
  const rightLeaderApprove = await fetch(`${baseUrl}/api/requests/${request.id}/approve`, { method: 'POST', headers: authed(midLeaderBLogin.token) });
  assert.equal(rightLeaderApprove.status, 200);
});

test('hierarchy — Dashboard: a Leader cannot view an unrelated employee\'s dashboard, but can view a subordinate\'s', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const blocked = await fetch(`${baseUrl}/api/dashboard/employee?employee_id=${ids.reportBId}`, { headers: authed(midLeaderALogin.token) });
  assert.equal(blocked.status, 403);
  const allowed = await fetch(`${baseUrl}/api/dashboard/employee?employee_id=${ids.reportAId}`, { headers: authed(midLeaderALogin.token) });
  assert.equal(allowed.status, 200);
});

test('hierarchy — Admin can act on any active employee, org-wide; an Employee cannot act on anyone else', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const adminEdit = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportATaskId}`, {
    method: 'PATCH', headers: authed(adminLogin.token), body: JSON.stringify({ priority: 'Low' }),
  });
  assert.equal(adminEdit.status, 200, 'Admin must be able to act on any active employee, org-wide');

  const { body: employeeLogin } = await login('employee@test.local', 'EmpPass123');
  const employeeEdit = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportATaskId}`, {
    method: 'PATCH', headers: authed(employeeLogin.token), body: JSON.stringify({ priority: 'Low' }),
  });
  assert.equal(employeeEdit.status, 403, 'a plain Employee must not be able to act on someone else\'s task');
});

test('hierarchy — canActOnEmployee refuses to act on a deactivated employee, even for their own manager', async () => {
  const { body: superAdminLogin } = await login('super@test.local', 'BrandNewPassword123');
  const deactivate = await fetch(`${baseUrl}/api/users/${ids.reportAId}`, {
    method: 'PATCH', headers: authed(superAdminLogin.token), body: JSON.stringify({ is_active: false }),
  });
  assert.equal(deactivate.status, 200);
  try {
    const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
    const editAttempt = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportATaskId}`, {
      method: 'PATCH', headers: authed(midLeaderALogin.token), body: JSON.stringify({ priority: 'High' }),
    });
    assert.equal(editAttempt.status, 403, 'a Leader must not be able to edit a deactivated report\'s task, even one within their own chain');
  } finally {
    await fetch(`${baseUrl}/api/users/${ids.reportAId}`, {
      method: 'PATCH', headers: authed(superAdminLogin.token), body: JSON.stringify({ is_active: true }),
    });
  }
});

test('users — assigning a manager that would create a reporting loop is rejected', async () => {
  const { body: superAdminLogin } = await login('super@test.local', 'BrandNewPassword123');
  // Top Leader already reports (indirectly) to nobody above Super Admin in this fixture; try to make
  // Top Leader report to Mid Leader A, who already reports to Top Leader — a direct 2-node loop.
  const res = await fetch(`${baseUrl}/api/users/${ids.topLeaderId}`, {
    method: 'PATCH', headers: authed(superAdminLogin.token), body: JSON.stringify({ manager_id: ids.midLeaderAId }),
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /loop/i);
});

// requests.commitment_id is NOT NULL with a plain REFERENCES (no ON DELETE clause, so Postgres defaults
// to NO ACTION) — confirmed directly here rather than assumed, since it changes what's actually reachable
// through the live app below.
test('requests — deleting a task with a resolved request against it does not violate the commitment_id foreign key', async () => {
  const { body: reportBLogin } = await login('reportb@test.local', 'ReportB123');
  const requestRes = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportBTaskId}/request-due-date-change`, {
    method: 'POST', headers: authed(reportBLogin.token), body: JSON.stringify({ requested_due_date: '2099-06-01' }),
  });
  assert.equal(requestRes.status, 201);
  const { request } = await requestRes.json();

  const { body: superAdminLogin } = await login('super@test.local', 'BrandNewPassword123');
  const approve = await fetch(`${baseUrl}/api/requests/${request.id}/approve`, { method: 'POST', headers: authed(superAdminLogin.token) });
  assert.equal(approve.status, 200, 'the request must resolve cleanly before the delete attempt below');

  const deleteTask = await fetch(`${baseUrl}/api/scrum/commitments/${ids.reportBTaskId}`, { method: 'DELETE', headers: authed(superAdminLogin.token) });
  assert.equal(deleteTask.status, 200, 'deleting a task must not fail with an unhandled foreign-key error just because a resolved request once referenced it');
});

test('requests — deleting a task with a still-pending request against it leaves an audit trail for that request', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const requestRes = await fetch(`${baseUrl}/api/scrum/commitments/${ids.midLeaderATaskId}/request-due-date-change`, {
    method: 'POST', headers: authed(midLeaderALogin.token), body: JSON.stringify({ requested_due_date: '2099-07-01' }),
  });
  assert.equal(requestRes.status, 201);
  const { request } = await requestRes.json();

  const { body: superAdminLogin } = await login('super@test.local', 'BrandNewPassword123');
  const deleteTask = await fetch(`${baseUrl}/api/scrum/commitments/${ids.midLeaderATaskId}`, { method: 'DELETE', headers: authed(superAdminLogin.token) });
  assert.equal(deleteTask.status, 200, 'deleting a task must not fail just because a request is still pending against it');

  const auditRes = await fetch(`${baseUrl}/api/audit?table_name=requests&record_id=${request.id}`, { headers: authed(superAdminLogin.token) });
  const { logs } = await auditRes.json();
  assert.equal(logs.length, 1, 'the pending request must not just vanish — its auto-rejection needs a trace, like every other resolution in this flow');
});

test('requests — the atomic claim (UPDATE ... WHERE status=pending) lets exactly one of two truly concurrent resolutions win', async () => {
  // Exercises the actual mechanism approve()/reject() rely on directly, at the SQL level — an HTTP-level
  // race (two fetch() calls via Promise.all) isn't reliably tight enough to force both requests' initial
  // reads to land before either write commits, since a fast sequential completion (call A fully finishes,
  // including its own read, mid-request business logic, and write, before call B's read even runs) also
  // produces "one wins, one loses" and would pass a looser test without ever touching this guard. This
  // test removes that ambiguity by firing the two conditional UPDATEs concurrently with no application
  // logic in between, which is exactly the tight-window case the guard exists for.
  const requestId = uuid();
  await db.prepare(`INSERT INTO requests (id, commitment_id, type, requested_by, status) VALUES (?, ?, 'due_date_change', ?, 'pending')`)
    .run(requestId, ids.reportATaskId, ids.reportAId);

  const claim = (status) => db.prepare(`UPDATE requests SET status=?, resolved_at=datetime('now') WHERE id=? AND status='pending'`).run(status, requestId);
  const [approveClaim, rejectClaim] = await Promise.all([claim('approved'), claim('rejected')]);
  const winners = [approveClaim.changes, rejectClaim.changes];
  assert.deepEqual(winners.sort(), [0, 1], 'exactly one of the two concurrent conditional updates must affect a row — the other must affect zero, never both');

  const final = await db.prepare('SELECT status FROM requests WHERE id = ?').get(requestId);
  assert.ok(['approved', 'rejected'].includes(final.status), 'the request must land in exactly one terminal state');
});

test('requests — once resolved, a second approve/reject attempt on the same request is refused, not silently reapplied', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(reportALogin.token),
    body: JSON.stringify({
      description: 'Double-resolve fixture', type: 'adhoc', due_date: '2026-09-20',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  assert.equal(createRes.status, 201);
  const { commitment } = await createRes.json();
  const requestRes = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/request-due-date-change`, {
    method: 'POST', headers: authed(reportALogin.token), body: JSON.stringify({ requested_due_date: '2099-02-02' }),
  });
  assert.equal(requestRes.status, 201);
  const { request } = await requestRes.json();

  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const headers = authed(midLeaderALogin.token);
  const firstApprove = await fetch(`${baseUrl}/api/requests/${request.id}/approve`, { method: 'POST', headers });
  assert.equal(firstApprove.status, 200);

  const secondApprove = await fetch(`${baseUrl}/api/requests/${request.id}/approve`, { method: 'POST', headers });
  assert.ok([400, 409].includes(secondApprove.status), 'a second approve on an already-resolved request must be refused, not reapplied');
  const secondReject = await fetch(`${baseUrl}/api/requests/${request.id}/reject`, { method: 'POST', headers });
  assert.ok([400, 409].includes(secondReject.status), 'rejecting an already-approved request must be refused too');

  const finalCommitment = await db.prepare('SELECT due_date FROM commitments WHERE id = ?').get(commitment.id);
  assert.equal(finalCommitment.due_date, '2099-02-02', 'the due date must reflect the one real approval, unaffected by the two refused re-attempts');
});

test('import — tasks: a valid row succeeds, an unknown email fails, and a Leader cannot import a task for someone outside their reporting chain', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const res = await fetch(`${baseUrl}/api/scrum/commitments/import`, {
    method: 'POST', headers: authed(midLeaderALogin.token),
    body: JSON.stringify({ rows: [
      { employee_email: 'reporta@test.local', description: 'Imported task for a direct report', category_name: 'Test Fixture Finance', main_task_name: 'Test Fixture FP&A', activity_name: 'Test Fixture Activity' },
      { employee_email: 'nobody-such@test.local', description: 'Should fail — unknown email', category_name: 'Test Fixture Finance', main_task_name: 'Test Fixture FP&A', activity_name: 'Test Fixture Activity' },
      { employee_email: 'reportb@test.local', description: 'Should fail — outside Mid Leader A\'s chain', category_name: 'Test Fixture Finance', main_task_name: 'Test Fixture FP&A', activity_name: 'Test Fixture Activity' },
    ] }),
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results[0].success, true, 'importing a task for a direct report must succeed');
  assert.equal(results[1].success, false);
  assert.match(results[1].error, /no user found/i);
  assert.equal(results[2].success, false, 'a Leader must not be able to import a task for someone outside their reporting chain');
  assert.match(results[2].error, /permission/i);

  const created = await db.prepare(`SELECT * FROM commitments WHERE employee_id = ? AND description = ?`).get(ids.reportAId, 'Imported task for a direct report');
  assert.ok(created, 'the successful row must have actually created a commitment');
  assert.equal(created.type, 'adhoc');
});

// The single-create routes for Process/Activity/Task all refuse an inactive parent with a friendly error
// — the CSV import routes resolved names against an unfiltered (active-and-inactive) list and inserted
// straight through with no re-check, silently bypassing that rule. These confirm the fix on all three.
test('import — a Process cannot be bulk-imported under a deactivated Function', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const inactiveCategoryId = uuid();
  await db.prepare(`INSERT INTO categories (id, name, is_active, created_by) VALUES (?, ?, 0, ?)`).run(inactiveCategoryId, 'Deactivated Test Function', ids.superAdminId);

  const res = await fetch(`${baseUrl}/api/main-tasks/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [{ name: 'Should Not Be Created', category_name: 'Deactivated Test Function' }] }),
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results[0].success, false, 'importing a Process against a deactivated Function must fail');
  assert.match(results[0].error, /no longer available/i);
  const created = await db.prepare('SELECT id FROM main_tasks WHERE name = ?').get('Should Not Be Created');
  assert.equal(created, undefined, 'no Process row must have been created');
});

test('import — an Activity cannot be bulk-imported under a deactivated Process', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const inactiveMainTaskId = uuid();
  await db.prepare(`INSERT INTO main_tasks (id, name, category_id, is_active, created_by) VALUES (?, ?, ?, 0, ?)`)
    .run(inactiveMainTaskId, 'Deactivated Test Process', ids.fixtureCategoryId, ids.superAdminId);

  const res = await fetch(`${baseUrl}/api/task-activities/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [{ name: 'Should Not Be Created', main_task_name: 'Deactivated Test Process' }] }),
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results[0].success, false, 'importing an Activity against a deactivated Process must fail');
  assert.match(results[0].error, /no longer available/i);
  const created = await db.prepare('SELECT id FROM task_activities WHERE name = ?').get('Should Not Be Created');
  assert.equal(created, undefined, 'no Activity row must have been created');
});

test('import — a Task cannot be bulk-imported against a deactivated Function, Process, or Activity', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const inactiveCategoryId = uuid();
  await db.prepare(`INSERT INTO categories (id, name, is_active, created_by) VALUES (?, ?, 0, ?)`).run(inactiveCategoryId, 'Deactivated Task Function', ids.superAdminId);

  const res = await fetch(`${baseUrl}/api/scrum/commitments/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { employee_email: 'reporta@test.local', description: 'Should not be created', category_name: 'Deactivated Task Function', main_task_name: 'Test Fixture FP&A', activity_name: 'Test Fixture Activity' },
    ] }),
  });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.equal(results[0].success, false, 'importing a task against a deactivated Function must fail, not silently attach to it');
  assert.match(results[0].error, /no longer available/i);
  const created = await db.prepare('SELECT id FROM commitments WHERE description = ?').get('Should not be created');
  assert.equal(created, undefined, 'no commitment row must have been created');
});

test('task history — records a "created" entry, is visible to the task\'s owner and anyone above them, and blocked for everyone else', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(midLeaderALogin.token),
    body: JSON.stringify({
      employee_id: ids.reportAId, description: 'Task with a history to check', type: 'adhoc',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  assert.equal(createRes.status, 201);
  const { commitment } = await createRes.json();

  const asCreator = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/history`, { headers: authed(midLeaderALogin.token) });
  assert.equal(asCreator.status, 200);
  const { logs: creatorLogs } = await asCreator.json();
  assert.equal(creatorLogs.length, 1, 'a freshly created task must have exactly one history entry so far');
  assert.equal(creatorLogs[0].field_name, 'created');
  assert.equal(creatorLogs[0].changed_by_name, 'Mid Leader A');
  assert.equal(creatorLogs[0].owner_name, 'Report A');

  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const asOwner = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/history`, { headers: authed(reportALogin.token) });
  assert.equal(asOwner.status, 200, 'the task\'s own owner must always be able to view its history');

  const { body: midLeaderBLogin } = await login('midleaderb@test.local', 'MidLeadB123');
  const asUnrelated = await fetch(`${baseUrl}/api/scrum/commitments/${commitment.id}/history`, { headers: authed(midLeaderBLogin.token) });
  assert.equal(asUnrelated.status, 403, 'a Leader outside this task\'s reporting chain must not see its history');
});

test('users — PATCH cannot deactivate or demote a Leader who still has active direct reports', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const deactivate = await fetch(`${baseUrl}/api/users/${ids.midLeaderAId}`, {
    method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ is_active: false }),
  });
  assert.equal(deactivate.status, 409, 'Mid Leader A still has Report A reporting to them');
  assert.match((await deactivate.json()).error, /active report/i);

  const demote = await fetch(`${baseUrl}/api/users/${ids.midLeaderAId}`, {
    method: 'PATCH', headers: authed(saLogin.token), body: JSON.stringify({ role: 'employee' }),
  });
  assert.equal(demote.status, 409, 'demoting away from a manager-capable role must be blocked the same way');

  // Confirm nothing actually changed — a rejected request must not have side effects.
  const stillActive = await db.prepare('SELECT is_active, role FROM users WHERE id = ?').get(ids.midLeaderAId);
  assert.equal(stillActive.is_active, 1);
  assert.equal(stillActive.role, 'leader');
});

test('users — Reports To rejects a deactivated manager, both on create and on edit', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const headers = authed(saLogin.token);

  const throwawayId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'leader')`)
    .run(throwawayId, 'Throwaway Leader', 'throwaway@test.local', bcrypt.hashSync('Throwaway123', 10));
  const deactivateThrowaway = await fetch(`${baseUrl}/api/users/${throwawayId}`, { method: 'PATCH', headers, body: JSON.stringify({ is_active: false }) });
  assert.equal(deactivateThrowaway.status, 200, 'a leader with zero reports must still be deactivatable');

  const onEdit = await fetch(`${baseUrl}/api/users/${ids.reportAId}`, { method: 'PATCH', headers, body: JSON.stringify({ manager_id: throwawayId }) });
  assert.equal(onEdit.status, 400);
  assert.match((await onEdit.json()).error, /deactivated/i);

  const onCreate = await fetch(`${baseUrl}/api/users`, {
    method: 'POST', headers, body: JSON.stringify({ full_name: 'New Hire', email: 'newhire@test.local', password: 'NewHire123', role: 'employee', manager_id: throwawayId }),
  });
  assert.equal(onCreate.status, 400);
  assert.match((await onCreate.json()).error, /deactivated/i);
});

test('history — "Overdue" is a real filter, completed_at is returned, and a truncation flag exists', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const create = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(reportALogin.token),
    body: JSON.stringify({
      description: 'Overdue test task', type: 'adhoc', due_date: '2020-01-01',
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });
  assert.equal(create.status, 201);
  const { commitment } = await create.json();

  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const overdueRes = await fetch(`${baseUrl}/api/history/commitments?employee_id=${ids.reportAId}&status=overdue`, { headers: authed(saLogin.token) });
  const { commitments: overdueRows, commitments_truncated } = await overdueRes.json();
  assert.ok(overdueRows.some((c) => c.id === commitment.id), 'a past-due, not-completed task must show up under the Overdue filter');
  assert.equal(typeof commitments_truncated, 'boolean', 'the truncation flag must always be present, even when false');

  const completedRes = await fetch(`${baseUrl}/api/history/commitments?employee_id=${ids.reportAId}&status=completed`, { headers: authed(saLogin.token) });
  const { commitments: completedRows } = await completedRes.json();
  assert.ok(!completedRows.some((c) => c.id === commitment.id), 'a pending task must not show up under the Completed filter just because it\'s also overdue');
});

test('dashboard — Org Dashboard\'s By Team shows a computed leader and real open-task counts, and Needs Attention is populated org-wide', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/dashboard/org`, { headers: authed(saLogin.token) });
  assert.equal(res.status, 200);
  const data = await res.json();

  // Reuses the team created by the earlier "teams — a team's leader is computed..." test (Mid Leader A
  // and Report A were assigned to it there, with Mid Leader A as the computed leader) — same DB, same file.
  const computedTeam = data.by_team.find((t) => t.team_name === 'Computed Leader Team');
  assert.ok(computedTeam, 'the team created earlier in this file must be present');
  assert.equal(computedTeam.leader_name, 'Mid Leader A', 'By Team must show the same computed leader as the Teams tab does');
  assert.ok('open_tasks' in computedTeam, 'by_team rows must carry a real open-task count, not just a headcount');
  assert.ok(typeof data.pending_requests === 'number', 'Org Dashboard must return a real pending_requests count');

  assert.ok(data.attention_required, 'Org Dashboard must return an attention_required block, same shape as the Leader dashboard');
  assert.ok(Array.isArray(data.attention_required.support_requests));
  assert.ok(Array.isArray(data.attention_required.delayed_commitments));
});

test('scrum — the orphaned Escalations endpoints were removed, not just left unreachable from the UI', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const res = await fetch(`${baseUrl}/api/scrum/escalations`, { method: 'POST', headers: authed(empLogin.token), body: JSON.stringify({ issue: 'test' }) });
  assert.equal(res.status, 404, 'the route itself should no longer exist');
});

// UTC-safe day offset, matching the same discipline lib/recurrence.js itself uses — never round-trip
// through a locally-parsed Date, which can silently land on the wrong calendar day.
function daysAgo(n) {
  const [y, m, d] = today().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

async function seedRecurringSeries({ rule, occurrencesCreated = 1, lastDueDate, employeeId = ids.reportAId }) {
  const activityId = uuid();
  await db.prepare(`
    INSERT INTO recurring_activities (id, employee_id, title, recurrence_rule, series_start_date, occurrences_created, created_by)
    VALUES (?, ?, 'Daily status update', ?, ?, ?, ?)
  `).run(activityId, employeeId, JSON.stringify(rule), lastDueDate, occurrencesCreated, ids.superAdminId);
  const commitmentId = uuid();
  await db.prepare(`
    INSERT INTO commitments (id, employee_id, scrum_date, description, type, recurring_activity_id, priority, due_date, original_due_date, start_date, created_by, updated_by)
    VALUES (?, ?, ?, 'Daily status update', 'recurring', ?, 'Medium', ?, ?, ?, ?, ?)
  `).run(commitmentId, employeeId, lastDueDate, activityId, lastDueDate, lastDueDate, lastDueDate, ids.superAdminId, ids.superAdminId);
  return { activityId, commitmentId };
}

test('recurring generation — a Daily series nobody completed still advances to today, on its own schedule', async () => {
  const { activityId, commitmentId: staleId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'never' } },
    lastDueDate: daysAgo(5),
  });

  const result = await generateDueOccurrences();
  assert.ok(result.created >= 1, 'at least this one stalled series must produce a new occurrence');

  const rows = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId);
  assert.equal(rows.length, 2, 'the stale occurrence must stay, plus exactly one new current occurrence — not one row per skipped day');
  const stale = rows.find((r) => r.id === staleId);
  assert.equal(stale.status, 'pending', 'the old, never-completed occurrence must be left exactly as it was, still trackable as delayed');
  const fresh = rows.find((r) => r.id !== staleId);
  assert.equal(fresh.due_date, today(), 'the new occurrence must be due today, computed from the schedule — not from whenever someone gets to the old one');

  const activity = await db.prepare('SELECT occurrences_created FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(activity.occurrences_created, 2, 'occurrences_created must be bumped exactly once for the one new row, same bookkeeping as the completion-triggered path');
});

test('recurring generation — running twice the same day does not create a duplicate', async () => {
  const { activityId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'never' } },
    lastDueDate: daysAgo(3),
  });
  await generateDueOccurrences();
  const afterFirst = await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId);
  await generateDueOccurrences();
  const afterSecond = await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId);
  assert.equal(afterSecond.c, afterFirst.c, 'a series already caught up to today must be left alone on a repeat run');
});

test('recurring generation — a series already current (due today or later) is left alone', async () => {
  const { activityId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'week', weekdays: [], end: { type: 'never' } },
    lastDueDate: today(),
  });
  await generateDueOccurrences();
  const count = await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId);
  assert.equal(count.c, 1, 'nothing is due yet for this series, so no new occurrence should appear');
});

test('recurring generation — a series past its end condition is deactivated, not regenerated forever', async () => {
  const { activityId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'after_count', count: 1 } },
    occurrencesCreated: 1,
    lastDueDate: daysAgo(4),
  });
  await generateDueOccurrences();
  const activity = await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(activity.is_active, 0, 'a series that already reached its occurrence count must be turned off, not kept generating');
  const count = await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId);
  assert.equal(count.c, 1, 'no occurrence beyond the series\' own end condition should ever be created');
});

test('recurring generation — a long-dormant, count-limited series stops exactly at its true final occurrence, not the date it happens to catch up to', async () => {
  // 2 occurrences already exist (occurrencesCreated: 2), the rule allows 3 total, and the series has sat
  // untouched for 12 days — long enough that a walk-forward loop which doesn't re-check the count at each
  // hop would sail straight past the 3rd (final) occurrence's real due date and land on today instead.
  const { activityId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'after_count', count: 3 } },
    occurrencesCreated: 2,
    lastDueDate: daysAgo(12),
  });
  const expectedFinalDueDate = daysAgo(11); // the day right after the last real occurrence — the true 3rd/final one
  await generateDueOccurrences();

  const rows = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId);
  assert.equal(rows.length, 2, 'exactly one new occurrence — the true final one — must be created, nothing between it and today');
  assert.equal(rows[1].due_date, expectedFinalDueDate, 'the series must stop at its actual 3rd occurrence\'s real due date, not overshoot to whatever date the walk happened to reach');

  const activity = await db.prepare('SELECT is_active, occurrences_created FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(activity.occurrences_created, 3);
  assert.equal(activity.is_active, 0, 'the series must be deactivated in the same run that creates its final occurrence, not one run later');
});

test('recurring generation — a race between two callers inserting the same occurrence cannot produce a duplicate row', async () => {
  // Simulates exactly what two overlapping triggers (a double-fired cron invocation, or the schedule
  // sweep racing an employee's completion) would each independently decide to do: both read "nothing
  // exists yet" and both call insertOccurrence for the identical (activity, dueDate) with no guard between
  // them. The database's unique index — not an application-level check — is what has to catch this.
  const { activityId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'never' } },
    lastDueDate: daysAgo(10),
  });
  const activity = await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(activityId);
  const dueDate = daysAgo(9); // one day past the seeded occurrence — a date nothing else in this test has touched
  const template = { description: 'Race condition check', employee_id: ids.reportAId, priority: 'Medium' };

  const [a, b] = await Promise.all([
    insertOccurrence({ activity, dueDate, template, changedBy: null, changedByName: 'Race A', reason: 'test' }),
    insertOccurrence({ activity, dueDate, template, changedBy: null, changedByName: 'Race B', reason: 'test' }),
  ]);
  assert.equal(a.id, b.id, 'both concurrent callers must end up pointing at the same single row, not two different ones');

  const rows = await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ? AND due_date = ?').get(activityId, dueDate);
  assert.equal(rows.c, 1, 'only one commitment must exist for this (activity, due_date) pair no matter how many callers raced to create it');

  const after = await db.prepare('SELECT occurrences_created FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(after.occurrences_created, 2, 'the loser of the race must not still bump the counter for a row it didn\'t actually create');
});

// A series row on its own, with NO occurrence row — what a series looks like after its only task was
// deleted (task delete is a hard delete), which is exactly the state every live series was found in.
async function seedSeriesOnly({ rule, startDate, isActive = 1, occurrencesCreated = 1 }) {
  const activityId = uuid();
  await db.prepare(`
    INSERT INTO recurring_activities (id, employee_id, title, recurrence_rule, series_start_date, occurrences_created, reviewer_id, priority, is_active, created_by)
    VALUES (?, ?, 'Bank reconciliation', ?, ?, ?, ?, 'High', ?, ?)
  `).run(activityId, ids.reportAId, JSON.stringify(rule), startDate, occurrencesCreated, ids.midLeaderAId, isActive, ids.superAdminId);
  return activityId;
}

function monthsAgo(n) {
  const [y, m, d] = today().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 - n, d)).toISOString().slice(0, 10);
}

test('recurring generation — Weekly: an occurrence a week old gets this week\'s occurrence, a 10-day-old one lands on its own weekday', async () => {
  const rule = { interval: 1, unit: 'week', weekdays: [], end: { type: 'never' } };
  const onTime = await seedRecurringSeries({ rule, lastDueDate: daysAgo(7) });
  const offset = await seedRecurringSeries({ rule, lastDueDate: daysAgo(10) });
  await generateDueOccurrences();
  const a = await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(onTime.activityId);
  assert.deepEqual(a.map((r) => r.due_date), [daysAgo(7), today()]);
  const b = await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(offset.activityId);
  assert.deepEqual(b.map((r) => r.due_date), [daysAgo(10), daysAgo(3)], 'the next weekly date is 7 days after the last one, not "today"');
});

test('recurring generation — Monthly: an occurrence one month old gets this month\'s occurrence', { skip: Number(today().slice(8)) > 28 && 'month-end clamping makes the exact date vary on the 29th–31st' }, async () => {
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'month', end: { type: 'never' } }, lastDueDate: monthsAgo(1) });
  await generateDueOccurrences();
  const rows = await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId);
  assert.deepEqual(rows.map((r) => r.due_date), [monthsAgo(1), today()]);
});

test('recurring generation — a paused series generates nothing, however far behind it is', async () => {
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(6) });
  await db.prepare('UPDATE recurring_activities SET is_active = 0 WHERE id = ?').run(activityId);
  const orphanPaused = await seedSeriesOnly({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, startDate: daysAgo(6), isActive: 0 });
  await generateDueOccurrences();
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId)).c, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(orphanPaused)).c, 0);
});

test('recurring generation — an end date is respected: the last in-range occurrence is created and the series stops', async () => {
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'on_date', date: daysAgo(2) } }, lastDueDate: daysAgo(5) });
  await generateDueOccurrences();
  const rows = await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId);
  assert.deepEqual(rows.map((r) => r.due_date), [daysAgo(5), daysAgo(2)], 'nothing after the end date, and nothing for the skipped days in between');
  assert.equal((await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(activityId)).is_active, 0);
});

test('recurring generation — a series whose every occurrence was deleted still generates today\'s, built from the series itself', async () => {
  const activityId = await seedSeriesOnly({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, startDate: daysAgo(4) });
  await generateDueOccurrences();
  const rows = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ?').all(activityId);
  assert.equal(rows.length, 1, 'exactly one current occurrence, not one per day since the series started');
  const [c] = rows;
  assert.equal(c.due_date, today());
  assert.equal(c.type, 'recurring');
  assert.equal(c.status, 'pending');
  assert.equal(c.description, 'Bank reconciliation', 'the task name comes from the series title');
  assert.equal(c.employee_id, ids.reportAId);
  assert.equal(c.priority, 'High');
  assert.equal(c.reviewer_id, ids.midLeaderAId);

  await generateDueOccurrences();
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId)).c, 1, 'a second run the same day must not add another');
});

test('recurring generation — a series with no occurrence that has not started yet waits for its start date', async () => {
  const activityId = await seedSeriesOnly({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, startDate: daysAgo(-3) });
  await generateDueOccurrences();
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId)).c, 0);
});

test('recurring generation — a count-limited series with no occurrence left never goes past its count', async () => {
  const activityId = await seedSeriesOnly({ rule: { interval: 1, unit: 'day', end: { type: 'after_count', count: 1 } }, startDate: daysAgo(3), occurrencesCreated: 1 });
  await generateDueOccurrences();
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId)).c, 0, 'its one allowed occurrence was already used (and deleted)');
  assert.equal((await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(activityId)).is_active, 0);
});

test('recurring generation — a scheduler-created task shows up in My Tasks, Team Tasks, and History, with its old overdue one still there', async () => {
  const { activityId, commitmentId: overdueId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(2) });
  await generateDueOccurrences();
  const fresh = await db.prepare('SELECT id FROM commitments WHERE recurring_activity_id = ? AND due_date = ?').get(activityId, today());
  assert.ok(fresh, 'the scheduler must have created today\'s occurrence');

  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const { body: saLogin } = await login('admin@test.local', 'AdminPass123');

  const my = await (await fetch(`${baseUrl}/api/scrum/my-tasks`, { headers: authed(reportALogin.token) })).json();
  const myIds = my.tasks.map((t) => t.id);
  assert.ok(myIds.includes(fresh.id), 'My Tasks must list the new occurrence');
  assert.ok(myIds.includes(overdueId), 'My Tasks must still list the uncompleted previous one');
  const mine = my.tasks.find((t) => t.id === fresh.id);
  assert.equal(mine.type, 'recurring');
  assert.equal(mine.employee_name, 'Report A');
  assert.ok(mine.recurring_activity_id);

  const team = await (await fetch(`${baseUrl}/api/leader/org-tasks`, { headers: authed(saLogin.token) })).json();
  assert.ok(team.tasks.some((t) => t.id === fresh.id), 'Team Tasks must list it');

  const hist = await (await fetch(`${baseUrl}/api/history/commitments?type=recurring&from=${daysAgo(3)}&to=${today()}`, { headers: authed(saLogin.token) })).json();
  const histIds = hist.commitments.map((c) => c.id);
  assert.ok(histIds.includes(fresh.id) && histIds.includes(overdueId), 'History must list both occurrences');
});

test('recurring API — each named frequency is stored as its rule, labelled plainly, and its first task lands on the chosen day', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const base = { employee_ids: [ids.reportAId], category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId, start_date: '2026-09-23' };
  const cases = [
    ['Freq Daily', { interval: 1, unit: 'day' }, 'Every day', '2026-09-23'],
    ['Freq Weekly', { interval: 1, unit: 'week', weekdays: [1] }, 'Weekly on Mon', '2026-09-28'],
    ['Freq Business', { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }, 'Every business day (Mon–Fri)', '2026-09-23'],
    ['Freq Monthly', { interval: 1, unit: 'month', day_of_month: 15 }, 'Monthly on day 15', '2026-10-15'],
    ['Freq Month end', { interval: 1, unit: 'month', last_day: true }, 'Monthly on the last day', '2026-09-30'],
    ['Freq Quarterly', { interval: 3, unit: 'month', day_of_month: 1 }, 'Quarterly on day 1', '2026-10-01'],
    ['Freq Half', { interval: 6, unit: 'month', day_of_month: 15 }, 'Half-yearly on day 15', '2026-10-15'],
    ['Freq Yearly', { interval: 12, unit: 'month', month: 1, day_of_month: 1 }, 'Yearly on 1 Jan', '2027-01-01'],
  ];
  for (const [title, rule, label, firstDue] of cases) {
    const res = await fetch(`${baseUrl}/api/recurring-tasks`, {
      method: 'POST', headers: authed(adminLogin.token),
      body: JSON.stringify({ ...base, title, recurrence_rule: { ...rule, end: { type: 'never' } } }),
    });
    assert.equal(res.status, 201, title);
    const [series] = (await res.json()).recurring_tasks;
    assert.equal(series.frequency, label, title);
    assert.deepEqual(JSON.parse(series.recurrence_rule), { ...rule, end: { type: 'never' } }, `${title}: the rule is stored in the database as sent`);
    const seedTask = await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ?').get(series.id);
    assert.equal(seedTask.due_date, firstDue, title);
  }

  const bad = await fetch(`${baseUrl}/api/recurring-tasks`, {
    method: 'POST', headers: authed(adminLogin.token),
    body: JSON.stringify({ ...base, title: 'Freq Bad', recurrence_rule: { interval: 12, unit: 'month', month: 4, day_of_month: 31, end: { type: 'never' } } }),
  });
  assert.equal(bad.status, 400, '31 April must be refused, not silently turned into another date');
  assert.match((await bad.json()).error, /April|Apr/);
});

test('recurring API — a recurring task made from Team Tasks also starts on its pattern, not on the Due date typed in', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(adminLogin.token),
    body: JSON.stringify({
      description: 'Team Tasks weekly Monday check', type: 'recurring', due_date: '2026-09-23', employee_id: ids.reportAId,
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
      recurrence_rule: { interval: 1, unit: 'week', weekdays: [1], end: { type: 'never' } },
    }),
  });
  assert.equal(res.status, 201);
  const { commitment } = await res.json();
  assert.equal(commitment.due_date, '2026-09-28', 'a Wednesday due date becomes the next Monday');
});

test('recurring edit — changes apply from the next task on; the task already on someone\'s list keeps its details', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { activityId, commitmentId: existingId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(1) });

  const res = await fetch(`${baseUrl}/api/recurring-tasks/${activityId}`, {
    method: 'PATCH', headers: authed(adminLogin.token),
    body: JSON.stringify({ title: 'Edited recurring name', priority: 'High', reviewer_id: ids.midLeaderAId, employee_id: ids.reportBId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId }),
  });
  assert.equal(res.status, 200);
  const { recurring_task: series } = await res.json();
  assert.equal(series.title, 'Edited recurring name');
  assert.equal(series.employee_id, ids.reportBId);

  const existing = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(existingId);
  assert.equal(existing.description, 'Daily status update', 'the task already created is not rewritten');
  assert.equal(existing.employee_id, ids.reportAId);

  await generateDueOccurrences();
  const next = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ? AND due_date = ?').get(activityId, today());
  assert.ok(next, 'the series still generates today\'s task after an edit');
  assert.equal(next.description, 'Edited recurring name');
  assert.equal(next.employee_id, ids.reportBId, 'the next task goes to the newly assigned person');
  assert.equal(next.priority, 'High');
  assert.equal(next.reviewer_id, ids.midLeaderAId);
  assert.equal(next.main_task_id, ids.fixtureMainTaskId);

  const audit = await db.prepare(`SELECT field_name, old_value, new_value FROM audit_logs WHERE record_id = ? AND table_name = 'recurring_activities' ORDER BY field_name`).all(activityId);
  const byField = Object.fromEntries(audit.map((a) => [a.field_name, a]));
  assert.equal(byField.employee_id.old_value, 'Report A', 'the audit trail shows names, not IDs');
  assert.equal(byField.employee_id.new_value, 'Report B');
  assert.equal(byField.reviewer_id.new_value, 'Mid Leader A');
  assert.equal(byField.title.new_value, 'Edited recurring name');
  assert.ok(!byField.recurrence_rule, 'the schedule was not sent, so it is not touched');
});

test('recurring edit — a new schedule takes over from the most recent task', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(1) });
  const yesterday = daysAgo(1);
  const weekday = ((new Date(`${yesterday}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // ISO weekday of yesterday
  const rule = { interval: 1, unit: 'week', weekdays: [weekday], end: { type: 'never' } };

  const res = await fetch(`${baseUrl}/api/recurring-tasks/${activityId}`, { method: 'PATCH', headers: authed(adminLogin.token), body: JSON.stringify({ recurrence_rule: rule }) });
  assert.equal(res.status, 200);
  const { recurring_task: series } = await res.json();
  assert.deepEqual(series.rule, rule);
  assert.match(series.frequency, /^Weekly on /);

  await generateDueOccurrences();
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId)).c, 1,
    'now weekly on yesterday\'s weekday, so the next one is a week after yesterday — nothing today');

  const audit = await db.prepare(`SELECT old_value, new_value FROM audit_logs WHERE record_id = ? AND field_name = 'frequency'`).get(activityId);
  assert.ok(audit && /^Weekly on /.test(audit.new_value), 'the schedule change is recorded by its readable label');
});

test('recurring edit — refuses bad input, name clashes and non-admins; Pause still works', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: today() });
  const patch = (body, token = adminLogin.token) => fetch(`${baseUrl}/api/recurring-tasks/${activityId}`, { method: 'PATCH', headers: authed(token), body: JSON.stringify(body) });

  assert.equal((await patch({ title: '   ' })).status, 400, 'empty name');
  assert.equal((await patch({ priority: 'Urgent' })).status, 400);
  assert.equal((await patch({ recurrence_rule: { interval: 12, unit: 'month', month: 4, day_of_month: 31, end: { type: 'never' } } })).status, 400, '31 April');
  assert.equal((await patch({ employee_id: uuid() })).status, 400, 'unknown person');
  const adhocType = await db.prepare(`SELECT id FROM task_types WHERE mechanic = 'adhoc' AND is_active = 1 LIMIT 1`).get();
  assert.equal((await patch({ task_type_id: adhocType.id })).status, 400, 'an ad-hoc type would stop it repeating');

  await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: today(), employeeId: ids.reportBId });
  await db.prepare(`UPDATE recurring_activities SET title = 'Taken name' WHERE id = (SELECT id FROM recurring_activities WHERE employee_id = ? ORDER BY created_at DESC LIMIT 1)`).run(ids.reportBId);
  const clash = await patch({ title: 'Taken name', employee_id: ids.reportBId });
  assert.equal(clash.status, 400, 'the same person cannot have two recurring tasks with one name');

  const { body: leaderLogin } = await login('midleadera@test.local', 'MidLeadA123');
  assert.equal((await patch({ title: 'Leader rename' }, leaderLogin.token)).status, 403, 'only Admins manage recurring tasks');

  const unchanged = await db.prepare('SELECT title, is_active FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(unchanged.title, 'Daily status update', 'nothing refused was saved');

  assert.equal((await patch({ is_active: 0 })).status, 200);
  assert.equal((await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(activityId)).is_active, 0, 'Pause via the same endpoint still works');
});

test('recurring delete — removes the series, keeps every task it created, and nothing more is generated', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { activityId, commitmentId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(3), employeeId: ids.reportBId });
  await db.prepare(`UPDATE recurring_activities SET title = 'Series to delete' WHERE id = ?`).run(activityId);
  await generateDueOccurrences(); // adds today's task, so the series has an old overdue task and a current one
  const before = await db.prepare('SELECT id FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId);
  assert.equal(before.length, 2);

  const res = await fetch(`${baseUrl}/api/recurring-tasks/${activityId}`, { method: 'DELETE', headers: authed(adminLogin.token) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).tasks_kept, 2);

  assert.equal(await db.prepare('SELECT id FROM recurring_activities WHERE id = ?').get(activityId), undefined, 'the series is gone');
  const kept = await db.prepare(`SELECT id, type, recurring_activity_id, status FROM commitments WHERE id IN (?, ?)`).all(before[0].id, before[1].id);
  assert.equal(kept.length, 2, 'both tasks it already created are kept');
  assert.ok(kept.every((t) => t.recurring_activity_id === null && t.type === 'recurring'), 'unlinked from the deleted series, still marked Recurring');
  assert.ok(kept.some((t) => t.id === commitmentId), 'including the old overdue one');

  const audit = await db.prepare(`SELECT old_value, reason, owner_name FROM audit_logs WHERE record_id = ? AND field_name = 'deleted'`).get(activityId);
  assert.match(audit.old_value, /Series to delete/);
  assert.match(audit.reason, /2 tasks/);
  assert.equal(audit.owner_name, 'Report B');

  const tasksBefore = (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE employee_id = ? AND description = ?').get(ids.reportBId, 'Daily status update')).c;
  await generateDueOccurrences();
  const tasksAfter = (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE employee_id = ? AND description = ?').get(ids.reportBId, 'Daily status update')).c;
  assert.equal(tasksAfter, tasksBefore, 'a deleted series generates nothing');

  // A kept task can still be completed without anything trying to line up a next occurrence.
  const { body: reportBLogin } = await login('reportb@test.local', 'ReportB123');
  const done = await fetch(`${baseUrl}/api/scrum/commitments/${commitmentId}/resolve`, { method: 'POST', headers: authed(reportBLogin.token), body: JSON.stringify({ status: 'completed' }) });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).next_occurrence, null);

  // The name is free again for a new series for the same person.
  const again = await fetch(`${baseUrl}/api/recurring-tasks`, {
    method: 'POST', headers: authed(adminLogin.token),
    body: JSON.stringify({ title: 'Series to delete', employee_ids: [ids.reportBId], category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId }),
  });
  assert.equal(again.status, 201);
});

test('recurring delete — only Admins, and an unknown series is a 404', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { body: leaderLogin } = await login('midleadera@test.local', 'MidLeadA123');
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: today() });
  const asLeader = await fetch(`${baseUrl}/api/recurring-tasks/${activityId}`, { method: 'DELETE', headers: authed(leaderLogin.token) });
  assert.equal(asLeader.status, 403);
  assert.ok(await db.prepare('SELECT id FROM recurring_activities WHERE id = ?').get(activityId), 'still there after a refused delete');
  const missing = await fetch(`${baseUrl}/api/recurring-tasks/${uuid()}`, { method: 'DELETE', headers: authed(adminLogin.token) });
  assert.equal(missing.status, 404);
});

test('scrum resolve — completing an old overdue task does not recreate the dates the scheduler skipped', async () => {
  const { activityId, commitmentId: oldId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(10) });
  await generateDueOccurrences(); // catch-up: creates today's task only, skipping the 9 days in between
  assert.deepEqual((await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId)).map((r) => r.due_date), [daysAgo(10), today()]);

  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const res = await fetch(`${baseUrl}/api/scrum/commitments/${oldId}/resolve`, { method: 'POST', headers: authed(reportALogin.token), body: JSON.stringify({ status: 'completed' }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.series_ended, false);
  assert.equal(body.next_occurrence?.due_date, today(), 'the next task is the one already lined up for today');

  const after = (await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId)).map((r) => r.due_date);
  assert.deepEqual(after, [daysAgo(10), today()], `no task for a skipped date (${daysAgo(9)}) may be created`);
  assert.equal((await db.prepare('SELECT occurrences_created FROM recurring_activities WHERE id = ?').get(activityId)).occurrences_created, 2);
});

test('recurring generation — a deactivated person gets no new recurring tasks; reactivating them resumes it', async () => {
  const personId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role, is_active) VALUES (?, 'Left The Company', 'left@test.local', ?, 'employee', 0)`)
    .run(personId, bcrypt.hashSync('LeftPass123', 10));
  const { activityId } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(2), employeeId: personId });

  await generateDueOccurrences();
  assert.equal((await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId)).c, 1, 'nothing new for someone who is deactivated');
  assert.equal((await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(activityId)).is_active, 1, 'the series itself is left as it was, not paused or ended');

  await db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(personId);
  await generateDueOccurrences();
  const dues = (await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId)).map((r) => r.due_date);
  assert.deepEqual(dues, [daysAgo(2), today()], 'once reactivated, the series picks up again from today');
});

test('scrum create — a task cannot be attached to someone else\'s recurring series', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const { activityId: othersSeries } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: today(), employeeId: ids.reportBId });
  const { activityId: ownSeries } = await seedRecurringSeries({ rule: { interval: 1, unit: 'day', end: { type: 'never' } }, lastDueDate: daysAgo(1) });
  const create = (recurringActivityId, description) => fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(reportALogin.token),
    body: JSON.stringify({
      description, type: 'recurring', due_date: today(), employee_id: ids.reportAId, recurring_activity_id: recurringActivityId,
      category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId,
    }),
  });

  const hijack = await create(othersSeries, 'Hijack attempt');
  assert.equal(hijack.status, 400, 'another person\'s series is refused');
  assert.equal((await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE description = 'Hijack attempt'`).get()).c, 0);

  const madeUp = await create(uuid(), 'Made-up series');
  assert.equal(madeUp.status, 400, 'a series that does not exist is a clear 400, not a server error');

  const own = await create(ownSeries, 'Daily status update');
  assert.equal(own.status, 201, 'their own series is still fine');
});

test('recurring API — a Leader can be assigned a recurring task, not silently skipped', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/recurring-tasks`, {
    method: 'POST', headers: authed(adminLogin.token),
    body: JSON.stringify({ title: 'Leader weekly review', employee_ids: [ids.midLeaderAId, ids.reportAId], category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId }),
  });
  assert.equal(res.status, 201);
  const { recurring_tasks: created } = await res.json();
  assert.deepEqual(created.map((s) => s.employee_id).sort(), [ids.midLeaderAId, ids.reportAId].sort(), 'both the Leader and the Employee get their own copy');
});

test('recurring list — every series carries its parsed schedule, including old ones that only have a label', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const legacyId = uuid();
  await db.prepare(`INSERT INTO recurring_activities (id, employee_id, title, frequency, series_start_date, created_by) VALUES (?, ?, 'Legacy weekday task', 'Weekdays', ?, ?)`)
    .run(legacyId, ids.reportAId, today(), ids.superAdminId);
  const { recurring_tasks: rows } = await (await fetch(`${baseUrl}/api/recurring-tasks`, { headers: authed(adminLogin.token) })).json();
  const legacy = rows.find((r) => r.id === legacyId);
  assert.deepEqual(legacy.rule.weekdays, [1, 2, 3, 4, 5]);
  assert.ok(rows.every((r) => r.rule && r.rule.unit), 'every row has a usable rule for the Edit form');
  assert.equal(legacy.task_count, 0, 'the Delete confirmation can say how many tasks will be kept');
  assert.ok(rows.every((r) => Number.isInteger(r.task_count)));
});

test('due dates — a half-typed or impossible date is refused everywhere a due date is set; a real one saves', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');
  const headers = authed(reportALogin.token);
  const taskId = uuid();
  await db.prepare(`INSERT INTO commitments (id, employee_id, scrum_date, description, type, priority, due_date, original_due_date, start_date, created_by, updated_by)
    VALUES (?, ?, ?, 'Date change check', 'adhoc', 'Medium', ?, ?, ?, ?, ?)`).run(taskId, ids.reportAId, today(), today(), today(), today(), ids.reportAId, ids.reportAId);
  const move = (date) => fetch(`${baseUrl}/api/scrum/commitments/${taskId}/carry-forward`, { method: 'POST', headers, body: JSON.stringify({ new_due_date: date }) });

  for (const bad of ['0002-09-25', '2026-02-31', '2026-13-01', '26-09-30', 'tomorrow', '2026-9-30', '3026-01-01']) {
    const res = await move(bad);
    assert.equal(res.status, 400, `"${bad}" must be refused`);
    assert.match((await res.json()).error, /real date/);
  }
  assert.equal((await db.prepare('SELECT due_date FROM commitments WHERE id = ?').get(taskId)).due_date, today(), 'nothing refused was saved');

  const ok = await move('2026-10-15');
  assert.equal(ok.status, 200);
  assert.equal((await db.prepare('SELECT due_date FROM commitments WHERE id = ?').get(taskId)).due_date, '2026-10-15');
  assert.equal((await move('2028-02-29')).status, 200, 'a leap day is a real date');

  const request = await fetch(`${baseUrl}/api/scrum/commitments/${taskId}/request-due-date-change`, { method: 'POST', headers, body: JSON.stringify({ requested_due_date: '0002-10-20', reason: 'test' }) });
  assert.equal(request.status, 400, 'a date-change request with a half-typed date is refused');

  const create = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers,
    body: JSON.stringify({ description: 'Bad date task', type: 'adhoc', due_date: '2026-02-30', employee_id: ids.reportAId, category_id: ids.fixtureCategoryId, main_task_id: ids.fixtureMainTaskId, task_activity_id: ids.fixtureActivityId }),
  });
  assert.equal(create.status, 400, 'a new task with an impossible due date is refused');
});

// The completion-triggered path (an employee marking today's occurrence done, via POST .../resolve) is a
// second way a recurring series advances, alongside the schedule-triggered sweep tested above — it had no
// integration test at all before this.
test('scrum resolve — completing a recurring task lines up its next occurrence', async () => {
  const { activityId, commitmentId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'never' } },
    lastDueDate: today(),
  });
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');

  const res = await fetch(`${baseUrl}/api/scrum/commitments/${commitmentId}/resolve`, {
    method: 'POST', headers: authed(reportALogin.token), body: JSON.stringify({ status: 'completed' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.series_ended, false, 'a "never"-ending series must not be marked ended just because one occurrence was completed');
  assert.ok(body.next_occurrence, 'completing today\'s occurrence must line up the next one, not leave the series stalled until the schedule sweep runs');
  assert.equal(body.next_occurrence.due_date, daysAgo(-1), 'a daily series\' next occurrence must be due tomorrow');

  const rows = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(activityId);
  assert.equal(rows.length, 2, 'exactly the completed occurrence plus its one new successor — not a duplicate or none at all');
  const activity = await db.prepare('SELECT occurrences_created FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(activity.occurrences_created, 2, 'occurrences_created must be bumped for the newly-created next occurrence');
});

test('scrum resolve — completing the final occurrence of a count-limited series ends it, without creating another', async () => {
  const { activityId, commitmentId } = await seedRecurringSeries({
    rule: { interval: 1, unit: 'day', end: { type: 'after_count', count: 1 } },
    occurrencesCreated: 1,
    lastDueDate: today(),
  });
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');

  const res = await fetch(`${baseUrl}/api/scrum/commitments/${commitmentId}/resolve`, {
    method: 'POST', headers: authed(reportALogin.token), body: JSON.stringify({ status: 'completed' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.series_ended, true, 'completing the one-and-only allowed occurrence must end the series');
  assert.equal(body.next_occurrence, null, 'a series that just ended must not also get a next occurrence created for it');

  const activity = await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(activityId);
  assert.equal(activity.is_active, 0, 'the series must be deactivated in the same request that completes its final occurrence');
  const count = await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(activityId);
  assert.equal(count.c, 1, 'no occurrence beyond the series\' own end condition should ever be created, on this path either');
});

test('cron — /api/cron/generate-recurring refuses every request without the right shared secret, even a valid user login', async () => {
  process.env.CRON_SECRET = 'test-cron-secret-value';
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const noAuth = await fetch(`${baseUrl}/api/cron/generate-recurring`);
  assert.equal(noAuth.status, 401);

  const wrongSecret = await fetch(`${baseUrl}/api/cron/generate-recurring`, { headers: { Authorization: 'Bearer wrong-value' } });
  assert.equal(wrongSecret.status, 401);

  const userToken = await fetch(`${baseUrl}/api/cron/generate-recurring`, { headers: authed(saLogin.token) });
  assert.equal(userToken.status, 401, 'a normal logged-in session must not double as cron access');

  const withSecret = await fetch(`${baseUrl}/api/cron/generate-recurring`, { headers: { Authorization: 'Bearer test-cron-secret-value' } });
  assert.equal(withSecret.status, 200);
  const body = await withSecret.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.checked, 'number');
});

test('cron — with CRON_SECRET unset, nothing gets in (not an empty Bearer, not "Bearer undefined")', async () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    for (const header of [undefined, 'Bearer ', 'Bearer undefined', 'Bearer']) {
      const res = await fetch(`${baseUrl}/api/cron/generate-recurring`, header === undefined ? {} : { headers: { Authorization: header } });
      assert.equal(res.status, 401);
    }
  } finally {
    process.env.CRON_SECRET = saved;
  }
});
