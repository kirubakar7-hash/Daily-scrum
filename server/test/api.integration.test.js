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

test('scrum — only Super Admin can delete a task they didn\'t create themselves; other leader-tier roles cannot', async () => {
  const { body: empLogin } = await login('employee@test.local', 'EmpPass123');
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');

  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(empLogin.token),
    body: JSON.stringify({ description: 'Employee-created task', type: 'adhoc', due_date: '2026-09-20' }),
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

test('import — teams: valid row succeeds, row with an unknown leader email fails', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/teams/import`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({ rows: [
      { name: 'Imported Team', leader_email: 'admin@test.local' },
      { name: 'Bad Leader Team', leader_email: 'nobody-such@test.local' },
    ] }),
  });
  const { results } = await res.json();
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.match(results[1].error, /no user found/i);
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
      { title: 'Imported recurring task', employee_emails: 'employee@test.local; nobody-such@test.local', frequency: 'Daily' },
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

  const recurringRes = await fetch(`${baseUrl}/api/recurring-tasks`, {
    method: 'POST', headers: authed(saLogin.token),
    body: JSON.stringify({
      title: 'Monthly close checklist', employee_ids: [ids.employeeId],
      category_id: category.id, main_task_id: mainTask.id, frequency: 'Daily',
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

test('hierarchy — Team Today includes Leaders/Admins in the roster for wide-open roles, not just Employees', async () => {
  const { body: adminLogin } = await login('admin@test.local', 'AdminPass123');
  const res = await fetch(`${baseUrl}/api/leader/team-today`, { headers: authed(adminLogin.token) });
  const { team } = await res.json();
  const rosterIds = team.map((t) => t.employee_id);
  assert.ok(rosterIds.includes(ids.topLeaderId), 'an Admin must see a Leader in Team Today\'s roster, same as org-tasks already shows');
  assert.ok(rosterIds.includes(ids.adminId), 'an Admin must see another Admin in Team Today\'s roster too');
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

test('import — tasks: a valid row succeeds, an unknown email fails, and a Leader cannot import a task for someone outside their reporting chain', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const res = await fetch(`${baseUrl}/api/scrum/commitments/import`, {
    method: 'POST', headers: authed(midLeaderALogin.token),
    body: JSON.stringify({ rows: [
      { employee_email: 'reporta@test.local', description: 'Imported task for a direct report' },
      { employee_email: 'nobody-such@test.local', description: 'Should fail — unknown email' },
      { employee_email: 'reportb@test.local', description: 'Should fail — outside Mid Leader A\'s chain' },
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

test('task history — records a "created" entry, is visible to the task\'s owner and anyone above them, and blocked for everyone else', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const createRes = await fetch(`${baseUrl}/api/scrum/commitments`, {
    method: 'POST', headers: authed(midLeaderALogin.token),
    body: JSON.stringify({ employee_id: ids.reportAId, description: 'Task with a history to check', type: 'adhoc' }),
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
