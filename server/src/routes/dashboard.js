import { Router } from 'express';
import { db, today } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { withDelay } from '../lib/delay.js';
import { recordAudit } from '../lib/audit.js';
import { buildStatusEmail } from '../lib/statusEmail.js';
import { sendMail, mailIsConfigured, stakeholderRecipients } from '../lib/mail.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { subordinateIds } from '../lib/scope.js';

const router = Router();
router.use(requireAuth);

function inClause(ids) {
  return ids.length ? ids.map(() => '?').join(',') : "'__none__'";
}

/** GET /api/dashboard/employee — "What do I need to do today?" An Employee may only ever see their own
 *  dashboard. A Leader may see their own reporting chain, any depth (scope.js). Admin/Super Admin/Senior
 *  Management stay org-wide, matching their scope everywhere else. Anyone asking for someone outside
 *  their scope is refused outright, rather than silently falling back to their own. */
router.get('/employee', asyncHandler(async (req, res) => {
  const requestedId = req.query.employee_id;
  if (requestedId && requestedId !== req.user.id) {
    if (req.user.role === 'employee') {
      return res.status(403).json({ error: 'You can only view your own dashboard.' });
    }
    if (req.user.role === 'leader' && !(await subordinateIds(req.user.id)).includes(requestedId)) {
      return res.status(403).json({ error: "You can only view your own dashboard or someone reporting to you." });
    }
  }
  const employeeId = requestedId || req.user.id;
  const date = today();

  const todayCommitments = await db.prepare(`SELECT * FROM commitments WHERE employee_id=? AND due_date=? AND is_active=1`).all(employeeId, date);
  const delayed = (await db.prepare(`
    SELECT * FROM commitments WHERE employee_id=? AND status != 'completed' AND due_date < ? AND is_active=1
  `).all(employeeId, date)).map((r) => withDelay(r, date));
  const supportRequested = await db.prepare(`SELECT * FROM commitments WHERE employee_id=? AND status='support_required' AND is_active=1`).all(employeeId);
  const openActions = await db.prepare(`SELECT * FROM actions WHERE employee_id=? AND status != 'completed' AND is_active=1`).all(employeeId);

  // Due-so-far, not merely "left pending" — a task overdue but never started must count against
  // reliability, not sit outside the denominator entirely.
  const totalDue = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id=? AND due_date <= ?`).get(employeeId, date)).c;
  const totalCompleted = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id=? AND status='completed'`).get(employeeId)).c;
  const commitmentRate = totalDue ? Math.round((totalCompleted / totalDue) * 1000) / 10 : null;

  const pendingCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id=? AND status='pending'`).get(employeeId)).c;
  const inProgressCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id=? AND status='in_progress'`).get(employeeId)).c;
  const supportRequiredCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE employee_id=? AND status='support_required'`).get(employeeId)).c;

  res.json({
    date,
    today_commitments: todayCommitments,
    delayed_work: delayed,
    support_requested: supportRequested,
    open_actions: openActions,
    commitment_completion_rate: commitmentRate,
    pending: pendingCount,
    in_progress: inProgressCount,
    completed: totalCompleted,
    support_required: supportRequiredCount,
  });
}));

/** GET /api/dashboard/leader — "What needs my attention today?" */
router.get('/leader', requireRole('super_admin', 'admin', 'leader', 'senior_management'), asyncHandler(async (req, res) => {
  // subordinateIds() already excludes the caller — reused directly so this KPI and scopedEmployees() in
  // leader.js can never disagree, unlike before when each hand-rolled its own copy of the same query.
  let teamIds;
  if (req.user.role === 'leader') {
    const activeIds = new Set((await db.prepare('SELECT id FROM users WHERE is_active=1').all()).map((r) => r.id));
    teamIds = (await subordinateIds(req.user.id)).filter((id) => activeIds.has(id));
  } else {
    // Admin/Super Admin/Senior Management — every active user, org-wide, same population org-tasks and
    // Team Today already use. Previously filtered to role='employee' only, which silently excluded other
    // Leaders/Admins from Admin's own dashboard numbers.
    teamIds = (await db.prepare(`SELECT id FROM users WHERE is_active=1`).all()).map((r) => r.id);
  }

  const empIds = teamIds.length ? teamIds : ['__none__'];
  const clause = inClause(empIds);
  const date = today();

  const teamCount = empIds.length && empIds[0] !== '__none__' ? empIds.length : 0;
  const scrumCompleted = (await db.prepare(`SELECT COUNT(*) c FROM scrum_sessions WHERE scrum_date=? AND status='completed' AND employee_id IN (${clause})`).get(date, ...empIds)).c;

  const commitmentsToday = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE due_date=? AND employee_id IN (${clause})`).get(date, ...empIds)).c;
  const completed = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='completed' AND employee_id IN (${clause})`).get(...empIds)).c;
  const pendingCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='pending' AND employee_id IN (${clause})`).get(...empIds)).c;
  const inProgressCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='in_progress' AND employee_id IN (${clause})`).get(...empIds)).c;
  const supportRequiredCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='support_required' AND employee_id IN (${clause})`).get(...empIds)).c;
  const delayed = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status != 'completed' AND due_date < ? AND employee_id IN (${clause})`).get(date, ...empIds)).c;

  // Due-so-far, not merely "left pending" — see the matching comment in GET /employee above.
  const totalDue = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE due_date <= ? AND employee_id IN (${clause})`).get(date, ...empIds)).c;
  const totalCompleted = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='completed' AND employee_id IN (${clause})`).get(...empIds)).c;
  const commitmentPct = totalDue ? Math.round((totalCompleted / totalDue) * 1000) / 10 : null;

  const recurringCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE type='recurring' AND employee_id IN (${clause})`).get(...empIds)).c;
  const adhocCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE type='adhoc' AND employee_id IN (${clause})`).get(...empIds)).c;
  const totalWork = recurringCount + adhocCount;

  // Attention required
  const delayedList = (await db.prepare(`
    SELECT c.*, u.full_name FROM commitments c JOIN users u ON u.id = c.employee_id
    WHERE c.status != 'completed' AND c.due_date < ? AND c.employee_id IN (${clause})
    ORDER BY c.due_date LIMIT 20
  `).all(date, ...empIds)).map((r) => withDelay(r, date));

  const supportRequests = await db.prepare(`
    SELECT c.*, u.full_name FROM commitments c JOIN users u ON u.id = c.employee_id
    WHERE c.status='support_required' AND c.employee_id IN (${clause})
    ORDER BY c.updated_at DESC LIMIT 20
  `).all(...empIds);

  // Scoped to the last 30 days so someone who struggled once, long ago, doesn't stay flagged forever.
  const repeatedSupportRequests = await db.prepare(`
    SELECT description, employee_id, COUNT(*) c FROM commitments
    WHERE status='support_required' AND employee_id IN (${clause}) AND created_at >= datetime('now', '-30 days')
    GROUP BY employee_id, description HAVING COUNT(*) >= 2 ORDER BY c DESC LIMIT 10
  `).all(...empIds);

  const openEscalations = await db.prepare(`
    SELECT e.*, u.full_name FROM escalations e JOIN users u ON u.id = e.employee_id
    WHERE e.status='open' AND e.employee_id IN (${clause}) ORDER BY e.escalation_date LIMIT 20
  `).all(...empIds);

  // Same 30-day scoping as repeatedSupportRequests above — this is meant to reflect current workload,
  // not a lifetime ratio that never recovers once tripped.
  const highAdhocEmployees = await db.prepare(`
    SELECT u.full_name, u.id,
      SUM(CASE WHEN c.type='adhoc' THEN 1 ELSE 0 END) AS adhoc_count,
      COUNT(c.id) AS total_count
    FROM users u LEFT JOIN commitments c ON c.employee_id = u.id AND c.created_at >= datetime('now', '-30 days')
    WHERE u.id IN (${clause})
    GROUP BY u.id HAVING COUNT(c.id) >= 3 AND (SUM(CASE WHEN c.type='adhoc' THEN 1 ELSE 0 END) * 1.0 / COUNT(c.id)) > 0.5
  `).all(...empIds);

  res.json({
    date,
    team_members: teamCount,
    scrum_completed: scrumCompleted,
    scrum_pending: Math.max(teamCount - scrumCompleted, 0),
    commitments: commitmentsToday,
    completed,
    pending: pendingCount,
    in_progress: inProgressCount,
    support_required: supportRequiredCount,
    delayed,
    commitment_pct: commitmentPct,
    recurring_pct: totalWork ? Math.round((recurringCount / totalWork) * 1000) / 10 : null,
    adhoc_pct: totalWork ? Math.round((adhocCount / totalWork) * 1000) / 10 : null,
    attention_required: {
      delayed_commitments: delayedList,
      support_requests: supportRequests,
      repeated_support_requests: repeatedSupportRequests,
      open_escalations: openEscalations,
      high_adhoc_workload: highAdhocEmployees,
    },
  });
}));

/** GET /api/dashboard/org — Super Admin / Senior Management organization view */
router.get('/org', requireRole('super_admin', 'senior_management'), asyncHandler(async (req, res) => {
  const date = today();
  const activeUsers = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE is_active=1`).get()).c;
  const teams = (await db.prepare(`SELECT COUNT(*) c FROM teams WHERE is_active=1`).get()).c;

  const totalEmployees = (await db.prepare(`SELECT COUNT(*) c FROM users WHERE role='employee' AND is_active=1`).get()).c;
  const scrumCompleted = (await db.prepare(`SELECT COUNT(*) c FROM scrum_sessions WHERE scrum_date=? AND status='completed'`).get(date)).c;

  const commitments = (await db.prepare(`SELECT COUNT(*) c FROM commitments`).get()).c;
  const actions = (await db.prepare(`SELECT COUNT(*) c FROM actions WHERE status != 'completed'`).get()).c;
  const escalations = (await db.prepare(`SELECT COUNT(*) c FROM escalations WHERE status='open'`).get()).c;
  const supportRequired = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='support_required'`).get()).c;
  const delayed = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status != 'completed' AND due_date < ?`).get(date)).c;
  const pendingCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='pending'`).get()).c;
  const inProgressCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='in_progress'`).get()).c;
  const completedCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE status='completed'`).get()).c;

  const recurringCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE type='recurring'`).get()).c;
  const adhocCount = (await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE type='adhoc'`).get()).c;
  const totalWork = recurringCount + adhocCount;

  const byTeam = await db.prepare(`
    SELECT t.name AS team_name, COUNT(DISTINCT u.id) AS employees
    FROM teams t
    LEFT JOIN users u ON u.team_id = t.id AND u.is_active = 1
    WHERE t.is_active = 1 GROUP BY t.id ORDER BY t.name
  `).all();

  res.json({
    date,
    active_users: activeUsers,
    teams,
    total_employees: totalEmployees,
    scrum_completed: scrumCompleted,
    scrum_pending: Math.max(totalEmployees - scrumCompleted, 0),
    commitments,
    actions,
    escalations,
    support_required: supportRequired,
    delayed,
    pending: pendingCount,
    in_progress: inProgressCount,
    completed: completedCount,
    recurring_pct: totalWork ? Math.round((recurringCount / totalWork) * 1000) / 10 : null,
    adhoc_pct: totalWork ? Math.round((adhocCount / totalWork) * 1000) / 10 : null,
    by_team: byTeam,
  });
}));

/** GET /api/dashboard/status-email-ready — lets the button know, before it's clicked, whether email is
 *  actually configured and who it would go to, so the UI can explain a missing setup rather than fail silently. */
router.get('/status-email-ready', requireRole('super_admin', 'admin', 'leader'), asyncHandler((req, res) => {
  res.json({ configured: mailIsConfigured(), recipients: stakeholderRecipients() });
}));

/** POST /api/dashboard/send-status-email — the on-demand "send now" button. Builds today's outstanding-work
 *  summary fresh (never a stale cached copy) and emails it to the configured stakeholder list. */
router.post('/send-status-email', requireRole('super_admin', 'admin', 'leader'), asyncHandler(async (req, res) => {
  const recipients = stakeholderRecipients();
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients configured — set STAKEHOLDER_EMAILS in the server .env file.' });
  }
  if (!mailIsConfigured()) {
    return res.status(400).json({ error: 'Email is not configured yet — set SMTP_HOST, SMTP_USER, and SMTP_PASS in the server .env file.' });
  }

  const { subject, html, text, taskCount } = buildStatusEmail();
  try {
    await sendMail({ to: recipients, subject, html, text });
  } catch (e) {
    return res.status(502).json({ error: `Could not send the email: ${e.message}` });
  }

  await recordAudit({
    tableName: 'status_email', recordId: today(), fieldName: 'sent',
    newValue: `${recipients.length} recipient(s), ${taskCount} outstanding task(s)`,
    changedBy: req.user.id, changedByName: req.user.full_name,
  });
  res.json({ ok: true, sent_to: recipients, task_count: taskCount });
}));

export default router;
