import { Router } from 'express';
import { db, today } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { withDelay } from '../lib/delay.js';
import { visibleEmployeeIds, subordinateIds, isReadOnly } from '../lib/scope.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

async function scopedEmployees(user) {
  if (user.role === 'leader') {
    // Not filtered to role='employee' — a Leader's reporting chain can include other Leaders below them.
    const ids = await subordinateIds(user.id);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return await db.prepare(`SELECT * FROM users WHERE id IN (${placeholders}) AND is_active = 1 ORDER BY full_name`).all(...ids);
  }
  // Wide-open roles (Super Admin, Admin, Senior Management) — same "everyone, org-wide" set org-tasks
  // already uses below. Previously this fell back to role='employee' only, silently dropping other
  // Leaders/Admins from Team Today's and Team Tasks' roster.
  return await allActiveUsers();
}

/** Every active user, any role — unlike scopedEmployees() this isn't team-scoped and isn't limited to
 *  role='employee', since the org-wide Team Tasks view shows Leaders' own tasks too. */
async function allActiveUsers() {
  return await db.prepare(`SELECT * FROM users WHERE is_active = 1 ORDER BY full_name`).all();
}

/** GET /api/leader/team-today — the Quick Mode scrum table: Employee | Today's Work | Delayed | Support | Scrum.
 *  Two aggregate queries for the whole visible team instead of 4 queries per employee — the per-employee
 *  loop this replaced ran 24 sequential round trips today and would have scaled linearly with headcount. */
router.get('/team-today', requireRole('super_admin', 'admin', 'leader', 'senior_management'), asyncHandler(async (req, res) => {
  const date = req.query.date || today();
  const employees = await scopedEmployees(req.user);
  if (employees.length === 0) return res.json({ date, team: [] });

  const ids = employees.map((e) => e.id);
  const clause = ids.map(() => '?').join(',');

  const counts = await db.prepare(`
    SELECT employee_id,
      SUM(CASE WHEN due_date = ? AND status != 'completed' THEN 1 ELSE 0 END) AS today_work_count,
      SUM(CASE WHEN due_date < ? AND status != 'completed' THEN 1 ELSE 0 END) AS delayed,
      SUM(CASE WHEN status = 'support_required' THEN 1 ELSE 0 END) AS support_required
    FROM commitments WHERE employee_id IN (${clause}) AND is_active = 1
    GROUP BY employee_id
  `).all(date, date, ...ids);
  const countsByEmployee = Object.fromEntries(counts.map((c) => [c.employee_id, c]));

  const sessions = await db.prepare(`SELECT employee_id, status, completed_at FROM scrum_sessions WHERE scrum_date = ? AND employee_id IN (${clause})`).all(date, ...ids);
  const sessionByEmployee = Object.fromEntries(sessions.map((s) => [s.employee_id, s]));

  const rows = employees.map((emp) => ({
    employee_id: emp.id,
    full_name: emp.full_name,
    job_title: emp.job_title,
    today_work_count: countsByEmployee[emp.id]?.today_work_count || 0,
    delayed: countsByEmployee[emp.id]?.delayed || 0,
    support_required: countsByEmployee[emp.id]?.support_required || 0,
    scrum_status: sessionByEmployee[emp.id]?.status || 'pending',
    scrum_completed_at: sessionByEmployee[emp.id]?.completed_at || null,
  }));

  res.json({ date, team: rows });
}));

/** GET /api/leader/team-month — one row per team member, one column per day of the given month, each
 *  cell the day's scrum status. Powers the Daily Scrum "Month view" grid. Reuses scopedEmployees() so the
 *  roster here can never drift from Team Overview's own roster. */
router.get('/team-month', requireRole('super_admin', 'admin', 'leader', 'senior_management'), asyncHandler(async (req, res) => {
  const month = req.query.month || today().slice(0, 7); // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month.' });

  const employees = await scopedEmployees(req.user);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of month m (0-indexed as m) = last day of month m (1-indexed)
  const days = Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);

  if (employees.length === 0) return res.json({ month, days, team: [] });

  const ids = employees.map((e) => e.id);
  const clause = ids.map(() => '?').join(',');
  const sessions = await db.prepare(`
    SELECT employee_id, scrum_date, status FROM scrum_sessions
    WHERE employee_id IN (${clause}) AND scrum_date >= ? AND scrum_date <= ?
  `).all(...ids, days[0], days[days.length - 1]);

  const statusesByEmployee = new Map();
  for (const s of sessions) {
    if (!statusesByEmployee.has(s.employee_id)) statusesByEmployee.set(s.employee_id, {});
    statusesByEmployee.get(s.employee_id)[s.scrum_date] = s.status;
  }

  const team = employees.map((e) => ({
    employee_id: e.id,
    full_name: e.full_name,
    statuses: statusesByEmployee.get(e.id) || {},
  }));

  res.json({ month, days, team });
}));

// Shared by team-tasks and org-tasks below — they differ only in which employee-id list is used, so the
// query itself (previously copy-pasted between the two) now lives in one place.
async function openTasksForEmployees(ids, date) {
  if (ids.length === 0) return [];
  const clause = ids.map(() => '?').join(',');
  // Once a task is Completed it no longer needs anyone's attention here — it drops off this list
  // (still fully visible in History, nothing is hidden from the record, just from this working view).
  const rows = await db.prepare(`
    SELECT c.*, u.full_name AS employee_name, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name, mt.name AS main_task_name
    FROM commitments c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    LEFT JOIN main_tasks mt ON mt.id = c.main_task_id
    WHERE c.employee_id IN (${clause}) AND c.is_active = 1 AND c.status != 'completed'
    ORDER BY c.due_date, c.created_at DESC
  `).all(...ids);
  return rows.map((r) => withDelay(r, date));
}

/** GET /api/leader/team-tasks — every open task across the team as a flat list, with delay info, for the Tasks view */
router.get('/team-tasks', requireRole('super_admin', 'admin', 'leader', 'senior_management'), asyncHandler(async (req, res) => {
  const date = req.query.date || today();
  const employees = await scopedEmployees(req.user);
  res.json({ date, tasks: await openTasksForEmployees(employees.map((e) => e.id), date) });
}));

/** GET /api/leader/org-tasks — every task on the "Team Tasks" page. Wide-open roles (Super Admin, Admin,
 *  Senior Management) see every active user's tasks, org-wide, same as always. A Leader or Employee sees
 *  only their own reporting chain here too, same as everywhere else in the app. `can_act` tells the
 *  frontend which rows this specific viewer may edit. */
router.get('/org-tasks', asyncHandler(async (req, res) => {
  const date = req.query.date || today();
  const wideOpen = ['super_admin', 'admin', 'senior_management'].includes(req.user.role);

  let ids;
  if (wideOpen) {
    ids = (await allActiveUsers()).map((e) => e.id);
  } else {
    // visibleEmployeeIds() deliberately doesn't filter is_active (History/Search still need a deactivated
    // person's past data) — this working view does, so intersect against the active-user id set.
    const activeIds = new Set((await allActiveUsers()).map((e) => e.id));
    ids = (await visibleEmployeeIds(req.user)).filter((id) => activeIds.has(id));
  }

  // Precomputed once, not per row — canActOnEmployee's leader branch would otherwise re-run the same
  // recursive query for every task on the page.
  const actionable = wideOpen ? null : new Set(await visibleEmployeeIds(req.user));
  const tasks = (await openTasksForEmployees(ids, date)).map((r) => ({
    ...r, can_act: !isReadOnly(req.user) && (wideOpen || actionable.has(r.employee_id)) ? 1 : 0,
  }));
  res.json({ date, tasks });
}));

export default router;
