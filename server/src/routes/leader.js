import { Router } from 'express';
import { db, today } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { withDelay } from '../lib/delay.js';
import { visibleEmployeeIds, isReadOnly } from '../lib/scope.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

/** Every active user, any role — the org-wide Team Tasks view shows Leaders' own tasks too, not just
 *  role='employee'. */
async function allActiveUsers() {
  return await db.prepare(`SELECT * FROM users WHERE is_active = 1 ORDER BY full_name`).all();
}

// Shared by org-tasks below. Also left-joins each task's most recent still-pending request (support or
// due-date-change), if any — this is what powers Team Tasks' "Action Required" indicator and the inline
// approve/reject action, replacing the old standalone Requests tab. A task can technically accumulate more
// than one pending request over its life (support now, a due-date change later) — the correlated subquery
// picks only the single most recent one, which is the one actually worth surfacing in a list view.
/** Open tasks for these people — plus, when `createdBy` is given, the open tasks that person created for
 *  anyone else (anyone can assign a task to anyone, and should still be able to see what they assigned). */
async function openTasksForEmployees(ids, date, createdBy = null) {
  if (ids.length === 0 && !createdBy) return [];
  const clause = ids.length ? `c.employee_id IN (${ids.map(() => '?').join(',')})` : 'FALSE';
  const whose = createdBy ? `(${clause} OR c.created_by = ?)` : clause;
  // Once a task is Completed it no longer needs anyone's attention here — it drops off this list
  // (still fully visible in History, nothing is hidden from the record, just from this working view).
  const rows = await db.prepare(`
    SELECT c.*, u.full_name AS employee_name, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name, mt.name AS main_task_name, ta.name AS task_activity_name,
      rv.full_name AS reviewer_name, pr.id AS pending_request_id, pr.type AS pending_request_type, pr.requested_due_date AS pending_request_due_date
    FROM commitments c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    LEFT JOIN main_tasks mt ON mt.id = c.main_task_id
    LEFT JOIN task_activities ta ON ta.id = c.task_activity_id
    LEFT JOIN users rv ON rv.id = c.reviewer_id
    LEFT JOIN requests pr ON pr.id = (
      SELECT id FROM requests WHERE commitment_id = c.id AND status = 'pending' ORDER BY created_at DESC LIMIT 1
    )
    WHERE ${whose} AND c.is_active = 1 AND c.status != 'completed'
    ORDER BY c.due_date, c.created_at DESC
  `).all(...ids, ...(createdBy ? [createdBy] : []));
  return rows.map((r) => withDelay(r, date));
}

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
  // A task someone assigned outside their own view shows here read-only (can_act stays 0 below).
  const tasks = (await openTasksForEmployees(ids, date, wideOpen ? null : req.user.id)).map((r) => ({
    ...r, can_act: !isReadOnly(req.user) && (wideOpen || actionable.has(r.employee_id)) ? 1 : 0,
  }));
  res.json({ date, tasks });
}));

export default router;
