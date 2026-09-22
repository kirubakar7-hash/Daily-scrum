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

test('scrum — confirming your own scrum shows up as "completed" on your leader\'s Team Today, for today only', async () => {
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');

  const before = await fetch(`${baseUrl}/api/scrum/today`, { headers: authed(reportALogin.token) });
  assert.equal((await before.json()).session.status, 'pending', 'no session row exists yet, so this must default to pending, not error');

  const confirm = await fetch(`${baseUrl}/api/scrum/confirm`, { method: 'POST', headers: authed(reportALogin.token), body: JSON.stringify({}) });
  assert.equal(confirm.status, 200);

  const after = await fetch(`${baseUrl}/api/scrum/today`, { headers: authed(reportALogin.token) });
  assert.equal((await after.json()).session.status, 'completed');

  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const teamToday = await fetch(`${baseUrl}/api/leader/team-today?date=${today()}`, { headers: authed(midLeaderALogin.token) });
  const { team } = await teamToday.json();
  const reportARow = team.find((t) => t.employee_id === ids.reportAId);
  assert.equal(reportARow.scrum_status, 'completed', 'the leader\'s Team Today must reflect the report\'s confirmed scrum for today');
  assert.match(reportARow.scrum_completed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'must return the real confirmation timestamp, not just the status');
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

test('team-month — returns every day of the requested month, scoped to the caller\'s roster, reflecting a real confirmed scrum', async () => {
  const { body: midLeaderALogin } = await login('midleadera@test.local', 'MidLeadA123');
  const { body: reportALogin } = await login('reporta@test.local', 'ReportA123');

  const confirm = await fetch(`${baseUrl}/api/scrum/confirm`, { method: 'POST', headers: authed(reportALogin.token), body: JSON.stringify({}) });
  assert.equal(confirm.status, 200);

  const monthStr = today().slice(0, 7);
  const res = await fetch(`${baseUrl}/api/leader/team-month?month=${monthStr}`, { headers: authed(midLeaderALogin.token) });
  assert.equal(res.status, 200);
  const { month, days, team } = await res.json();
  assert.equal(month, monthStr);

  const [y, m] = monthStr.split('-').map(Number);
  const expectedDayCount = new Date(Date.UTC(y, m, 0)).getUTCDate();
  assert.equal(days.length, expectedDayCount, 'must return exactly one entry per day of the month, no more, no less');
  assert.ok(days[0].endsWith('-01') && days[days.length - 1].endsWith(String(expectedDayCount).padStart(2, '0')), 'days must run from the 1st to the last day of the month, in order');

  const rosterIds = team.map((t) => t.employee_id);
  assert.ok(rosterIds.includes(ids.reportAId), 'Mid Leader A\'s roster must include their direct report');
  assert.ok(!rosterIds.includes(ids.reportBId), 'must not include someone outside the caller\'s reporting chain');

  const reportARow = team.find((t) => t.employee_id === ids.reportAId);
  assert.equal(reportARow.statuses[today()], 'completed', 'the confirmed scrum from above must show up on the correct day');
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
    body: JSON.stringify({ description: 'Double-resolve fixture', type: 'adhoc', due_date: '2026-09-20' }),
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
    body: JSON.stringify({ description: 'Overdue test task', type: 'adhoc', due_date: '2020-01-01' }),
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

test('dashboard — Org Dashboard\'s By Team shows a computed leader and a real scrum-completion rate, and Needs Attention is populated org-wide', async () => {
  const { body: saLogin } = await login('super@test.local', 'BrandNewPassword123');
  const res = await fetch(`${baseUrl}/api/dashboard/org`, { headers: authed(saLogin.token) });
  assert.equal(res.status, 200);
  const data = await res.json();

  // Reuses the team created by the earlier "teams — a team's leader is computed..." test (Mid Leader A
  // and Report A were assigned to it there, with Mid Leader A as the computed leader) — same DB, same file.
  const computedTeam = data.by_team.find((t) => t.team_name === 'Computed Leader Team');
  assert.ok(computedTeam, 'the team created earlier in this file must be present');
  assert.equal(computedTeam.leader_name, 'Mid Leader A', 'By Team must show the same computed leader as the Teams tab does');
  assert.ok('scrum_completed' in computedTeam, 'by_team rows must carry a real scrum-completion count, not just a headcount');

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
