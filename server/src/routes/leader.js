import { Router } from 'express';
import { db, today } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { withDelay } from '../lib/delay.js';
import { canActOnEmployee, isReadOnly } from '../lib/scope.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

async function scopedEmployees(user) {
  if (user.role === 'leader') {
    const teamIds = (await db.prepare('SELECT id FROM teams WHERE leader_user_id = ?').all(user.id)).map((r) => r.id);
    if (teamIds.length === 0) return [];
    const placeholders = teamIds.map(() => '?').join(',');
    return await db.prepare(`SELECT * FROM users WHERE team_id IN (${placeholders}) AND is_active = 1 AND role = 'employee' ORDER BY full_name`).all(...teamIds);
  }
  return await db.prepare(`SELECT * FROM users WHERE role = 'employee' AND is_active = 1 ORDER BY full_name`).all();
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

  const sessions = await db.prepare(`SELECT employee_id, status FROM scrum_sessions WHERE scrum_date = ? AND employee_id IN (${clause})`).all(date, ...ids);
  const sessionByEmployee = Object.fromEntries(sessions.map((s) => [s.employee_id, s.status]));

  const rows = employees.map((emp) => ({
    employee_id: emp.id,
    full_name: emp.full_name,
    job_title: emp.job_title,
    today_work_count: countsByEmployee[emp.id]?.today_work_count || 0,
    delayed: countsByEmployee[emp.id]?.delayed || 0,
    support_required: countsByEmployee[emp.id]?.support_required || 0,
    scrum_status: sessionByEmployee[emp.id] || 'pending',
  }));

  res.json({ date, team: rows });
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

/** GET /api/leader/org-tasks — every active user's open tasks, org-wide, for the universal "Team Tasks"
 *  page every role can see. `can_act` tells the frontend which rows this specific viewer may edit —
 *  their own tasks, or (for a Leader-tier viewer) anyone's. */
router.get('/org-tasks', asyncHandler(async (req, res) => {
  const date = req.query.date || today();
  const ids = (await allActiveUsers()).map((e) => e.id);
  const tasks = (await openTasksForEmployees(ids, date)).map((r) => ({
    ...r, can_act: !isReadOnly(req.user) && canActOnEmployee(req.user, r.employee_id) ? 1 : 0,
  }));
  res.json({ date, tasks });
}));

export default router;
