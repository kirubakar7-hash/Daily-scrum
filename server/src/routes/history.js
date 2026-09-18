import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { visibleEmployeeIds } from '../lib/scope.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

async function buildFilters(req) {
  const allowed = await visibleEmployeeIds(req.user);
  let employeeIds = allowed;
  if (req.query.employee_id) {
    employeeIds = allowed.includes(req.query.employee_id) ? [req.query.employee_id] : [];
  }
  if (req.query.team_id) {
    const teamUsers = (await db.prepare('SELECT id FROM users WHERE team_id = ?').all(req.query.team_id)).map((r) => r.id);
    employeeIds = employeeIds.filter((id) => teamUsers.includes(id));
  }
  return employeeIds;
}

// Shared by /summary and /export.csv so both apply the exact same filter set /commitments does — this
// used to be date-only on both, which meant Summary and CSV Export silently ignored Type/Status/Category
// while the Task Records table right next to them obeyed all five.
function buildCommitmentFilter(req) {
  let clause = '';
  const params = [];
  if (req.query.date_from) { clause += ' AND scrum_date >= ?'; params.push(req.query.date_from); }
  if (req.query.date_to) { clause += ' AND scrum_date <= ?'; params.push(req.query.date_to); }
  if (req.query.type) { clause += ' AND type = ?'; params.push(req.query.type); }
  if (req.query.status) { clause += ' AND status = ?'; params.push(req.query.status); }
  if (req.query.priority) { clause += ' AND priority = ?'; params.push(req.query.priority); }
  if (req.query.category_id) { clause += ' AND category_id = ?'; params.push(req.query.category_id); }
  return { clause, params };
}

/** GET /api/history/commitments — filterable history of commitments (recurring occurrences, ad-hoc, carry-forwards) */
router.get('/commitments', asyncHandler(async (req, res) => {
  const employeeIds = await buildFilters(req);
  if (employeeIds.length === 0) return res.json({ commitments: [] });
  const clause = employeeIds.map(() => '?').join(',');
  const params = [...employeeIds];
  let sql = `
    SELECT c.*, u.full_name, t.name AS task_type_name, cat.name AS category_name,
      EXISTS(SELECT 1 FROM requests r WHERE r.commitment_id = c.id AND r.type = 'support') AS had_support_request
    FROM commitments c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN task_types t ON t.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id IN (${clause})
  `;

  if (req.query.date_from) { sql += ' AND c.scrum_date >= ?'; params.push(req.query.date_from); }
  if (req.query.date_to) { sql += ' AND c.scrum_date <= ?'; params.push(req.query.date_to); }
  if (req.query.type) { sql += ' AND c.type = ?'; params.push(req.query.type); }
  if (req.query.status) { sql += ' AND c.status = ?'; params.push(req.query.status); }
  if (req.query.priority) { sql += ' AND c.priority = ?'; params.push(req.query.priority); }
  if (req.query.category_id) { sql += ' AND c.category_id = ?'; params.push(req.query.category_id); }
  sql += ' ORDER BY c.scrum_date DESC, c.created_at DESC LIMIT 500';

  const rows = (await db.prepare(sql).all(...params)).map((r) => ({
    ...r,
    code: `TSK-${String(r.seq).padStart(6, '0')}`,
    task_type: r.task_type_name || (r.type === 'recurring' ? 'Recurring' : 'Ad-hoc'),
  }));
  res.json({ commitments: rows });
}));

/** GET /api/history/summary — the per-employee rollup shown in the History module */
router.get('/summary', asyncHandler(async (req, res) => {
  const employeeIds = await buildFilters(req);
  if (employeeIds.length === 0) return res.json({ summary: [] });

  const { clause: filterClause, params: filterParams } = buildCommitmentFilter(req);
  let scrumDateFilter = '';
  const scrumParams = [];
  if (req.query.date_from) { scrumDateFilter += ' AND scrum_date >= ?'; scrumParams.push(req.query.date_from); }
  if (req.query.date_to) { scrumDateFilter += ' AND scrum_date <= ?'; scrumParams.push(req.query.date_to); }

  const summary = await Promise.all(employeeIds.map(async (id) => {
    const user = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(id);
    const params = [id, ...filterParams];

    const scrumDays = (await db.prepare(`SELECT COUNT(*) c FROM scrum_sessions WHERE employee_id = ? AND status='completed'${scrumDateFilter}`).get(id, ...scrumParams)).c;
    const activities = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id = ?${filterClause}`).get(...params)).c;
    const completed = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id = ? AND status='completed'${filterClause}`).get(...params)).c;
    const supportRequired = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id = ? AND status='support_required'${filterClause}`).get(...params)).c;
    // "Escalated" = how many of this employee's tasks needed leader escalation — either the current
    // requests-table Support flow, or (for tasks predating that table) the old carried_forward_to_id
    // link to an auto-generated leader task. Must match the per-row "Escalated to Leader" logic in
    // history.js's /commitments and History.jsx exactly, or the summary count won't match the detail rows.
    const escalatedToLeader = (await db.prepare(`
      SELECT COUNT(*) c FROM commitments cm
      WHERE cm.employee_id = ?${filterClause} AND (
        cm.carried_forward_to_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM requests r WHERE r.commitment_id = cm.id AND r.type = 'support')
      )
    `).get(...params)).c;
    const recurring = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id = ? AND type='recurring'${filterClause}`).get(...params)).c;
    const adhoc = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id = ? AND type='adhoc'${filterClause}`).get(...params)).c;

    return {
      employee_id: id,
      full_name: user?.full_name,
      scrum_days: scrumDays,
      activities,
      completed,
      support_required: supportRequired,
      escalated_to_leader: escalatedToLeader,
      recurring_activities: recurring,
      adhoc_activities: adhoc,
    };
  }));

  res.json({ summary });
}));

/** GET /api/history/export.csv — CSV export of commitments history */
router.get('/export.csv', asyncHandler(async (req, res) => {
  const employeeIds = await buildFilters(req);
  if (employeeIds.length === 0) {
    res.set('Content-Type', 'text/csv');
    return res.send('No data');
  }
  const clause = employeeIds.map(() => '?').join(',');
  const { clause: filterClause, params: filterParams } = buildCommitmentFilter(req);
  const params = [...employeeIds, ...filterParams];
  let sql = `
    SELECT c.seq, c.scrum_date, u.full_name, c.description, c.type, t.name AS task_type_name,
           cat.name AS category_name, c.priority, c.status, c.due_date, c.non_completion_reason
    FROM commitments c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN task_types t ON t.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id IN (${clause})${filterClause}
    ORDER BY c.scrum_date DESC
  `;
  const rows = await db.prepare(sql).all(...params);

  const header = ['Code', 'Date', 'Employee', 'Activity', 'Type', 'Task Type', 'Category', 'Priority', 'Status', 'Due Date', 'Reason If Not Completed'];
  // Guards against spreadsheet formula injection: a cell value starting with =, +, -, or @ is treated as
  // a formula by Excel/Sheets when the file is opened. Any employee can type free text into a task
  // description, so this file is the one place that text leaves React's safe rendering and lands
  // somewhere with its own code-execution surface.
  const escape = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header.join(',')].concat(
    rows.map((r) => {
      const code = `TSK-${String(r.seq).padStart(6, '0')}`;
      const taskType = r.task_type_name || (r.type === 'recurring' ? 'Recurring' : 'Ad-hoc');
      return [code, r.scrum_date, r.full_name, r.description, r.type, taskType, r.category_name || '', r.priority, r.status, r.due_date, r.non_completion_reason].map(escape).join(',');
    })
  );
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="scrum-history.csv"');
  res.send(lines.join('\n'));
}));

export default router;
