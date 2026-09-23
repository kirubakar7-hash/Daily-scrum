import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, today } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { canViewEmployee, canActOnEmployee, isReadOnly } from '../lib/scope.js';
import { withDelay, withLateness } from '../lib/delay.js';
import { firstDueDate, nextOccurrence, describeRule, validateRule, legacyFrequencyToRule } from '../lib/recurrence.js';
import { insertOccurrence } from '../lib/recurringOccurrences.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { resolveDefaultCategoryId } from '../lib/masterData.js';

const router = Router();
router.use(requireAuth);

function targetEmployeeId(req) {
  return req.query.employee_id || req.body?.employee_id || req.user.id;
}

/** Looked up whenever an audit entry needs to name the task's owner, separately from who made the change. */
async function employeeName(id) {
  return (await db.prepare('SELECT full_name FROM users WHERE id = ?').get(id))?.full_name || null;
}

async function assertCanView(req, res, employeeId) {
  if (!(await canViewEmployee(req.user, employeeId))) {
    res.status(403).json({ error: "You don't have permission to view this employee's data." });
    return false;
  }
  return true;
}

async function assertEmployeeExists(res, employeeId) {
  const exists = await db.prepare('SELECT id FROM users WHERE id = ?').get(employeeId);
  if (!exists) {
    res.status(400).json({ error: 'That person could not be found.' });
    return false;
  }
  return true;
}

async function assertCanEdit(req, res, employeeId) {
  if (isReadOnly(req.user)) {
    res.status(403).json({ error: 'Your role has read-only access.' });
    return false;
  }
  if (!(await canActOnEmployee(req.user, employeeId))) {
    res.status(403).json({ error: "You don't have permission to edit this employee's data." });
    return false;
  }
  return true;
}

/** GET /api/scrum/today — the full picture for one employee's day, driven by due date not creation date */
router.get('/today', asyncHandler(async (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!(await assertCanView(req, res, employeeId))) return;
  const date = req.query.date || today();

  // Needs Your Update: due date has passed and it isn't done yet — regardless of when it was created,
  // and regardless of whether it's still Pending or already flagged Support Required (they can act again).
  const overdue = (await db.prepare(`
    SELECT c.*, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name FROM commitments c
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id = ? AND c.due_date < ? AND c.status != 'completed' AND c.is_active = 1
    ORDER BY c.due_date
  `).all(employeeId, date)).map((r) => withDelay(r, date));

  // Today's Work: whatever is due today, however long ago it was created (future-dated tasks land here automatically).
  const todayCommitments = await db.prepare(`
    SELECT c.*, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name FROM commitments c
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id = ? AND c.due_date = ? AND c.is_active = 1 ORDER BY c.created_at
  `).all(employeeId, date);

  const openActions = await db.prepare(`
    SELECT * FROM actions WHERE employee_id = ? AND status != 'completed' AND is_active = 1 ORDER BY created_at
  `).all(employeeId);

  const employee = await db.prepare('SELECT id, full_name, role, team_id, job_title FROM users WHERE id = ?').get(employeeId);

  res.json({
    date,
    employee,
    overdue,
    today_commitments: todayCommitments,
    open_actions: openActions,
  });
}));

/** GET /api/scrum/my-tasks — every open task belonging to the logged-in user, for the "My Tasks" page.
 *  Same shape as /api/leader/team-tasks, just scoped to self instead of a team, so both can share the
 *  same TeamTaskList frontend component. */
router.get('/my-tasks', asyncHandler(async (req, res) => {
  const date = req.query.date || today();
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
    WHERE c.employee_id = ? AND c.is_active = 1 AND c.status != 'completed'
    ORDER BY c.due_date, c.created_at DESC
  `).all(req.user.id);
  res.json({ date, tasks: rows.map((r) => withDelay(r, date)) });
}));

/** POST /api/scrum/commitments — "What will you complete today?" */
router.post('/commitments', asyncHandler(async (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!(await assertCanEdit(req, res, employeeId))) return;
  if (!(await assertEmployeeExists(res, employeeId))) return;
  const b = req.body || {};
  if (!b.description || !b.description.trim()) return res.status(400).json({ error: 'Please describe the activity.' });

  // Type can arrive either as a task_type_id (from the admin-managed Type list) or, for backward
  // compatibility, the raw mechanic directly — either way it resolves to the same 'recurring'/'adhoc' split
  // the rest of the app (delay tracking, the repeat engine, dashboard splits) has always relied on.
  let taskTypeId = b.task_type_id || null;
  let type = b.type;
  if (taskTypeId) {
    const chosenType = await db.prepare('SELECT * FROM task_types WHERE id = ? AND is_active = 1').get(taskTypeId);
    if (!chosenType) return res.status(400).json({ error: 'That type is no longer available. Choose another.' });
    type = chosenType.mechanic;
  }
  if (!['recurring', 'adhoc'].includes(type)) return res.status(400).json({ error: 'Type must be Recurring or Ad-hoc.' });
  if (b.priority && !['Low', 'Medium', 'High'].includes(b.priority)) {
    return res.status(400).json({ error: 'Priority must be Low, Medium, or High.' });
  }

  // Process → Activity is required on every actual task — it answers "what type of work is it" (e.g.
  // FP&A → Bank Reconciliation), not whether the task repeats. Function (the level above Process) is no
  // longer something anyone has to pick day to day — the org has exactly one today, so it's auto-resolved
  // instead of asked for; it only becomes a real required choice again if a second Function ever exists.
  let categoryId = b.category_id || null;
  if (!categoryId) categoryId = await resolveDefaultCategoryId();
  if (!categoryId) return res.status(400).json({ error: 'Choose the Function this task belongs to.' });
  const chosenCategory = await db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
  if (!chosenCategory) return res.status(400).json({ error: 'That Function is no longer available. Choose another.' });

  const mainTaskId = b.main_task_id || null;
  if (!mainTaskId) return res.status(400).json({ error: 'Choose the Process this task belongs to.' });
  const chosenMainTask = await db.prepare('SELECT id FROM main_tasks WHERE id = ? AND is_active = 1').get(mainTaskId);
  if (!chosenMainTask) return res.status(400).json({ error: 'That Process is no longer available. Choose another.' });

  const taskActivityId = b.task_activity_id || null;
  if (!taskActivityId) return res.status(400).json({ error: 'Choose the Activity this task belongs to.' });
  const chosenActivity = await db.prepare('SELECT id FROM task_activities WHERE id = ? AND is_active = 1').get(taskActivityId);
  if (!chosenActivity) return res.status(400).json({ error: 'That Activity is no longer available. Choose another.' });

  // Reviewer is optional and free-standing (not part of the Function/Process/Activity nesting) — who
  // signs off on this employee's work, defaulting to their manager from the org hierarchy (see scope.js)
  // when the caller doesn't name one explicitly.
  let reviewerId = b.reviewer_id;
  if (reviewerId === undefined) {
    reviewerId = (await db.prepare('SELECT manager_id FROM users WHERE id = ?').get(employeeId))?.manager_id || null;
  } else if (reviewerId) {
    const chosenReviewer = await db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(reviewerId);
    if (!chosenReviewer) return res.status(400).json({ error: 'That reviewer is no longer available. Choose another.' });
  } else {
    reviewerId = null;
  }

  // The recurrence rule can arrive as a full { interval, unit, weekdays, end } object (the calendar-style
  // picker), or — for backward compatibility with older clients — as one of the original fixed frequency
  // strings, which maps onto an equivalent rule.
  let rule = null;
  if (type === 'recurring') {
    rule = b.recurrence_rule || (b.frequency ? legacyFrequencyToRule(b.frequency) : legacyFrequencyToRule('Daily'));
    const err = validateRule(rule);
    if (err) return res.status(400).json({ error: err });
  }

  let recurringActivityId = b.recurring_activity_id || null;
  let seriesFirstDue = null;
  if (type === 'recurring' && !recurringActivityId) {
    const existing = await db.prepare('SELECT id FROM recurring_activities WHERE employee_id = ? AND lower(title) = lower(?)').get(employeeId, b.description.trim());
    if (existing) {
      // The recurring activity already exists — its schedule was set when it was first created, so a
      // rule chosen here again is ignored rather than silently changing every past occurrence's cadence.
      recurringActivityId = existing.id;
    } else {
      recurringActivityId = uuid();
      const seriesStart = b.due_date || b.scrum_date || today();
      // Same as Admin's Recurring Tasks form: the first task lands on the pattern (e.g. the next Monday, or
      // the 15th), not on whatever date happened to be in the Due field.
      seriesFirstDue = firstDueDate(seriesStart, rule);
      await db.prepare(`
        INSERT INTO recurring_activities (id, employee_id, title, frequency, recurrence_rule, series_start_date, task_type_id, category_id, main_task_id, task_activity_id, reviewer_id, priority, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(recurringActivityId, employeeId, b.description.trim(), describeRule(rule), JSON.stringify(rule), seriesStart, taskTypeId, categoryId, mainTaskId, taskActivityId, reviewerId, b.priority || 'Medium', req.user.id);
    }
  }

  const id = uuid();
  const date = b.scrum_date || today();
  const dueDate = seriesFirstDue || b.due_date || date;
  await db.prepare(`
    INSERT INTO commitments (
      id, employee_id, scrum_date, description, type, recurring_activity_id, task_type_id, category_id, main_task_id, task_activity_id, reviewer_id, priority, expected_outcome,
      start_date, due_date, original_due_date, due_time, estimated_effort, dependency, dependency_owner, remarks, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, employeeId, date, b.description.trim(), type, recurringActivityId, taskTypeId, categoryId, mainTaskId, taskActivityId, reviewerId, b.priority || 'Medium', b.expected_outcome || null,
    b.start_date || date, dueDate, dueDate, b.due_time || null, b.estimated_effort || null, b.dependency || null,
    b.dependency_owner || null, b.remarks || null, req.user.id, req.user.id
  );
  await recordAudit({
    tableName: 'commitments', recordId: id, fieldName: 'created', newValue: b.description.trim(),
    changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: employeeId, ownerName: await employeeName(employeeId),
  });

  res.status(201).json({ commitment: await db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) });
}));

/** POST /api/scrum/commitments/import — bulk-create ad-hoc tasks from the "Import CSV" button on Team
 *  Tasks. Each row assigns to one person by email; a Leader can only import tasks for people in their own
 *  reporting chain, same as the single Create Task form enforces via assertCanEdit above. Recurring tasks
 *  aren't supported here — Admin's Recurring Tasks import already covers that. */
router.post('/commitments/import', asyncHandler(async (req, res) => {
  if (isReadOnly(req.user)) return res.status(403).json({ error: 'Your role has read-only access.' });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const users = await db.prepare('SELECT id, email FROM users').all();
  const userByEmail = new Map(users.map((u) => [u.email.trim().toLowerCase(), u.id]));
  // Active only, on every one of these four lookups — matching the single-create route's own checks
  // (below, and lines 131/147/152/157) so a bulk CSV import can't create a task against a Task Type,
  // Function, Process, or Activity that's been deactivated, something single-create already refuses.
  const taskTypes = await db.prepare('SELECT id, name, mechanic FROM task_types WHERE is_active = 1').all();
  const taskTypeByName = new Map(taskTypes.map((t) => [t.name.trim().toLowerCase(), t]));
  const categories = await db.prepare('SELECT id, name FROM categories WHERE is_active = 1').all();
  const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const mainTasks = await db.prepare('SELECT id, name FROM main_tasks WHERE is_active = 1').all();
  const mainTaskByName = new Map(mainTasks.map((m) => [m.name.trim().toLowerCase(), m.id]));
  const activities = await db.prepare('SELECT id, name FROM task_activities WHERE is_active = 1').all();
  const activityByName = new Map(activities.map((a) => [a.name.trim().toLowerCase(), a.id]));
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const email = (r.employee_email || '').trim();
      if (!email) throw new Error('employee_email is required.');
      const employeeId = userByEmail.get(email.toLowerCase());
      if (!employeeId) throw new Error(`No user found with email "${email}".`);
      if (!(await canActOnEmployee(req.user, employeeId))) {
        throw new Error("You don't have permission to assign a task to this person.");
      }

      const description = (r.description || '').trim();
      if (!description) throw new Error('description is required.');

      let task_type_id = null;
      const taskTypeName = (r.task_type_name || '').trim();
      if (taskTypeName) {
        const chosenType = taskTypeByName.get(taskTypeName.toLowerCase());
        if (!chosenType) throw new Error(`Task type "${taskTypeName}" was not found or is no longer available.`);
        if (chosenType.mechanic !== 'adhoc') throw new Error(`"${taskTypeName}" is a Recurring-type — use the Recurring Tasks import in Admin instead.`);
        task_type_id = chosenType.id;
      }

      const categoryName = (r.category_name || '').trim();
      let category_id;
      if (categoryName) {
        category_id = categoryByName.get(categoryName.toLowerCase());
        if (!category_id) throw new Error(`Function "${categoryName}" was not found or is no longer available.`);
      } else {
        category_id = await resolveDefaultCategoryId();
        if (!category_id) throw new Error('category_name is required — more than one Function exists, so it can\'t be auto-picked.');
      }

      const mainTaskName = (r.main_task_name || '').trim();
      if (!mainTaskName) throw new Error('main_task_name is required — every task must belong to a Process.');
      const main_task_id = mainTaskByName.get(mainTaskName.toLowerCase());
      if (!main_task_id) throw new Error(`Process "${mainTaskName}" was not found or is no longer available.`);

      const activityName = (r.activity_name || '').trim();
      if (!activityName) throw new Error('activity_name is required — every task must belong to an Activity.');
      const task_activity_id = activityByName.get(activityName.toLowerCase());
      if (!task_activity_id) throw new Error(`Activity "${activityName}" was not found or is no longer available.`);

      let reviewer_id = null;
      const reviewerEmail = (r.reviewer_email || '').trim();
      if (reviewerEmail) {
        reviewer_id = userByEmail.get(reviewerEmail.toLowerCase());
        if (!reviewer_id) throw new Error(`No user found with reviewer email "${reviewerEmail}".`);
      } else {
        reviewer_id = (await db.prepare('SELECT manager_id FROM users WHERE id = ?').get(employeeId))?.manager_id || null;
      }

      const priority = (r.priority || '').trim() || 'Medium';
      if (!['Low', 'Medium', 'High'].includes(priority)) throw new Error('priority must be Low, Medium, or High.');

      const dueDate = (r.due_date || '').trim() || today();

      const id = uuid();
      await db.prepare(`
        INSERT INTO commitments (
          id, employee_id, scrum_date, description, type, task_type_id, category_id, main_task_id, task_activity_id, reviewer_id, priority,
          start_date, due_date, original_due_date, created_by, updated_by
        ) VALUES (?, ?, ?, ?, 'adhoc', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, employeeId, dueDate, description, task_type_id, category_id, main_task_id, task_activity_id, reviewer_id, priority, dueDate, dueDate, dueDate, req.user.id, req.user.id);
      await recordAudit({
        tableName: 'commitments', recordId: id, fieldName: 'created', newValue: description,
        changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Bulk import',
        ownerId: employeeId, ownerName: await employeeName(employeeId),
      });

      results.push({ row: i + 1, success: true });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

/** POST /api/scrum/commitments/:id/carry-forward — push the due date out without losing the original.
 *  The task stays the SAME record; only the current due date moves. original_due_date never changes. */
router.post('/commitments/:id/carry-forward', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Task not found.' });
  if (!(await assertCanEdit(req, res, before.employee_id))) return;

  const newDueDate = req.body?.new_due_date;
  if (!newDueDate) return res.status(400).json({ error: 'Please choose when you expect to complete this.' });

  // Only reset a Completed/Support Required task back to Pending — an In Progress (or already Pending)
  // task keeps its current status; moving its date shouldn't silently undo real progress.
  await db.prepare(`
    UPDATE commitments SET due_date=?, status = CASE WHEN status IN ('completed','support_required') THEN 'pending' ELSE status END,
      updated_at=datetime('now'), updated_by=? WHERE id=?
  `).run(newDueDate, req.user.id, before.id);

  await recordAudit({
    tableName: 'commitments', recordId: before.id, fieldName: 'carried_forward',
    oldValue: before.due_date, newValue: newDueDate, changedBy: req.user.id, changedByName: req.user.full_name,
    reason: req.body?.reason || null, ownerId: before.employee_id, ownerName: await employeeName(before.employee_id),
  });

  res.json({ commitment: await db.prepare('SELECT * FROM commitments WHERE id = ?').get(before.id) });
}));

/** POST /api/scrum/commitments/:id/request-due-date-change — employee-initiated, doesn't touch the
 *  actual due_date. A Leader reviews it in the Requests inbox (routes/requests.js) and applies the same
 *  carry-forward logic on approval. Only the task's owner or a Leader can request one. */
router.post('/commitments/:id/request-due-date-change', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Task not found.' });
  if (!(await assertCanEdit(req, res, before.employee_id))) return;

  const requestedDate = req.body?.requested_due_date;
  if (!requestedDate) return res.status(400).json({ error: "Please choose the date you're requesting." });
  if (requestedDate === before.due_date) {
    return res.status(400).json({ error: "That's already this task's due date — choose a different one." });
  }

  const existingPending = await db.prepare(`SELECT * FROM requests WHERE commitment_id = ? AND type = 'due_date_change' AND status = 'pending'`).get(before.id);
  if (existingPending) return res.status(400).json({ error: 'A due-date change request is already pending for this task.' });

  const id = uuid();
  await db.prepare(`
    INSERT INTO requests (id, commitment_id, type, requested_by, reason, requested_due_date, status)
    VALUES (?, ?, 'due_date_change', ?, ?, ?, 'pending')
  `).run(id, before.id, req.user.id, req.body?.reason || null, requestedDate);

  res.status(201).json({ request: await db.prepare('SELECT * FROM requests WHERE id = ?').get(id) });
}));

/** POST /api/scrum/commitments/:id/resolve — mark a task Completed or Support Required.
 *  Support Required automatically creates a task for the employee's Leader asking them to help. */
router.post('/commitments/:id/resolve', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Commitment not found.' });
  if (!(await assertCanEdit(req, res, before.employee_id))) return;

  const b = req.body || {};
  if (!['pending', 'in_progress', 'completed', 'support_required'].includes(b.status)) {
    return res.status(400).json({ error: 'Status must be Pending, In Progress, Completed, or Support Required.' });
  }
  // Support Required must always come with a reason — otherwise a Leader gets a request in their inbox
  // with no context on what help is actually needed. The Request Support modal already collects this;
  // this guard just makes sure nothing can bypass it, including a direct API call.
  if (b.status === 'support_required' && (!b.non_completion_reason || !b.non_completion_reason.trim())) {
    return res.status(400).json({ error: 'Please explain what support is needed before flagging this as Support Required.' });
  }

  // Support Required no longer moves the due date — that's what Carry Forward is for. The task
  // just gets flagged, so it keeps showing as delayed (correctly) until it's actually resolved.
  const clearsSupportFields = b.status === 'pending' || b.status === 'in_progress';
  const after = {
    ...before,
    status: b.status,
    completed_at: b.status === 'completed' ? new Date().toISOString() : null,
    non_completion_reason: b.status === 'support_required' ? (b.non_completion_reason || null) : clearsSupportFields ? null : before.non_completion_reason,
    non_completion_explanation: b.status === 'support_required' ? (b.non_completion_explanation || null) : clearsSupportFields ? null : before.non_completion_explanation,
    new_target_date: b.status === 'support_required' ? (b.new_target_date || null) : clearsSupportFields ? null : before.new_target_date,
  };

  await db.prepare(`
    UPDATE commitments SET status=?, completed_at=?, non_completion_reason=?, non_completion_explanation=?, new_target_date=?,
      updated_at=datetime('now'), updated_by=?
    WHERE id=?
  `).run(
    after.status, after.completed_at, after.non_completion_reason, after.non_completion_explanation, after.new_target_date,
    req.user.id, before.id
  );
  await auditDiff({
    tableName: 'commitments', recordId: before.id, before, after: { status: after.status },
    changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: before.employee_id, ownerName: await employeeName(before.employee_id),
  });

  // Support Required creates a Request for the task's owner's — not a shadow task assigned to a specific
  // team leader — so ANY leader-tier person can review and act on it from the Requests inbox, matching
  // the org-wide (not team-scoped) leader model. See routes/requests.js for the approve/reject side.
  let request = null;
  if (b.status === 'support_required') {
    const existingPending = await db.prepare(`SELECT * FROM requests WHERE commitment_id = ? AND type = 'support' AND status = 'pending'`).get(before.id);
    if (existingPending) {
      request = existingPending;
    } else {
      const requestId = uuid();
      await db.prepare(`
        INSERT INTO requests (id, commitment_id, type, requested_by, reason, explanation, status)
        VALUES (?, ?, 'support', ?, ?, ?, 'pending')
      `).run(requestId, before.id, req.user.id, b.non_completion_reason || null, b.non_completion_explanation || null);
      await recordAudit({
        tableName: 'commitments', recordId: before.id, fieldName: 'support_requested', newValue: requestId,
        changedBy: req.user.id, changedByName: req.user.full_name, reason: b.non_completion_reason,
        ownerId: before.employee_id, ownerName: await employeeName(before.employee_id),
      });
      request = await db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    }
  }

  // Completing a Recurring task lines up its next occurrence automatically, so it shows up on the
  // right future day without anyone having to re-type it. Ad-hoc tasks and any other status don't repeat.
  let nextTask = null;
  let seriesEnded = false;
  if (b.status === 'completed' && before.type === 'recurring' && before.recurring_activity_id) {
    const activity = await db.prepare('SELECT * FROM recurring_activities WHERE id = ? AND is_active = 1').get(before.recurring_activity_id);
    if (activity) {
      const nextDate = nextOccurrence(before.due_date || today(), activity);
      if (!nextDate) {
        // The series has run its course (its end date/occurrence count was reached) — stop repeating it.
        await db.prepare('UPDATE recurring_activities SET is_active = 0 WHERE id = ?').run(activity.id);
        seriesEnded = true;
      } else {
        const already = await db.prepare(`SELECT * FROM commitments WHERE recurring_activity_id = ? AND due_date = ? AND is_active = 1`).get(activity.id, nextDate);
        if (already) {
          nextTask = already;
        } else {
          nextTask = await insertOccurrence({
            activity, dueDate: nextDate, template: before,
            changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Next occurrence of the recurring series',
          });
        }
      }
    }
  }

  const resolved = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(before.id);
  res.json({ commitment: withLateness(resolved), request, next_occurrence: nextTask, series_ended: seriesEnded });
}));

/** GET /api/scrum/commitments/:id/history — one task's full audit trail (created, status changes, due-date
 *  changes, deletion, etc.), for the "View History" popout on Team Tasks. Scoped by the same view rule as
 *  everything else — whoever can see the task (its owner, or someone above them in the hierarchy) can see
 *  its history; nobody else can. */
router.get('/commitments/:id/history', asyncHandler(async (req, res) => {
  const commitment = await db.prepare('SELECT id, employee_id FROM commitments WHERE id = ?').get(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Task not found.' });
  if (!(await assertCanView(req, res, commitment.employee_id))) return;
  const logs = await db.prepare(`
    SELECT * FROM audit_logs WHERE table_name = 'commitments' AND record_id = ? ORDER BY changed_at DESC
  `).all(req.params.id);
  res.json({ logs });
}));

/** PATCH /api/scrum/commitments/:id — general edit (due date change etc.), keeps audit trail */
router.patch('/commitments/:id', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Commitment not found.' });
  if (!(await assertCanEdit(req, res, before.employee_id))) return;
  const fields = ['description', 'priority', 'expected_outcome', 'due_date', 'due_time', 'estimated_effort', 'dependency', 'dependency_owner', 'remarks'];
  const after = { ...before };
  for (const f of fields) if (req.body?.[f] !== undefined) after[f] = req.body[f];
  // Reviewer, unlike Function/Process/Activity, can be reassigned or cleared after creation — it's who
  // signs off on the work, not part of the master-data nesting those three fields enforce.
  if (req.body?.reviewer_id !== undefined) {
    if (req.body.reviewer_id) {
      const chosenReviewer = await db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(req.body.reviewer_id);
      if (!chosenReviewer) return res.status(400).json({ error: 'That reviewer is no longer available. Choose another.' });
    }
    after.reviewer_id = req.body.reviewer_id || null;
  }

  // Reassigning the Owner, Process, Activity, or Task Type is a more privileged edit than everything
  // above (available to anyone who can already act on the task via assertCanEdit) — only Admin/Super Admin
  // can do it, so a Leader correcting their own report's due date can't accidentally also move the task to
  // someone else entirely. Status isn't included here: it's already fully editable by anyone authorized,
  // through the existing status dropdown / Complete / Request Support flows, which also handle the side
  // effects (advancing a recurring series, creating a support request) a bare status write here would skip.
  if (['admin', 'super_admin'].includes(req.user.role)) {
    if (req.body?.employee_id !== undefined && req.body.employee_id !== before.employee_id) {
      const chosenEmployee = await db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(req.body.employee_id);
      if (!chosenEmployee) return res.status(400).json({ error: 'That person is no longer available. Choose another.' });
      after.employee_id = req.body.employee_id;
    }
    if (req.body?.task_type_id !== undefined && req.body.task_type_id !== before.task_type_id) {
      if (req.body.task_type_id) {
        const chosenType = await db.prepare('SELECT * FROM task_types WHERE id = ? AND is_active = 1').get(req.body.task_type_id);
        if (!chosenType) return res.status(400).json({ error: 'That type is no longer available. Choose another.' });
        // Recurring vs Ad-hoc is a structural property tied to recurring_activity_id, not something a
        // single occurrence can switch on its own — changing the schedule itself belongs to Admin's
        // Recurring Tasks screen, not this edit.
        if (chosenType.mechanic !== before.type) {
          return res.status(400).json({ error: `This task is ${before.type === 'recurring' ? 'Recurring' : 'Ad-hoc'} — pick a type that matches, or change the schedule from Admin's Recurring Tasks screen instead.` });
        }
        after.task_type_id = req.body.task_type_id;
      } else {
        after.task_type_id = null;
      }
    }
    if (req.body?.main_task_id !== undefined && req.body.main_task_id !== before.main_task_id) {
      const chosenMainTask = await db.prepare('SELECT id FROM main_tasks WHERE id = ? AND is_active = 1').get(req.body.main_task_id);
      if (!chosenMainTask) return res.status(400).json({ error: 'That Process is no longer available. Choose another.' });
      after.main_task_id = req.body.main_task_id;
    }
    if (req.body?.task_activity_id !== undefined && req.body.task_activity_id !== before.task_activity_id) {
      const chosenActivity = await db.prepare('SELECT id FROM task_activities WHERE id = ? AND is_active = 1').get(req.body.task_activity_id);
      if (!chosenActivity) return res.status(400).json({ error: 'That Activity is no longer available. Choose another.' });
      after.task_activity_id = req.body.task_activity_id;
    }
  }

  // A due-date change made through this general-purpose edit must reset a resolved task's status the
  // same way the dedicated carry-forward endpoint does — otherwise a task can end up shown as Completed
  // or Support Required with a due date that's silently moved out from under it.
  if (after.due_date !== before.due_date && ['completed', 'support_required'].includes(before.status)) {
    after.status = 'pending';
  }
  await db.prepare(`
    UPDATE commitments SET description=?, priority=?, expected_outcome=?, due_date=?, due_time=?, estimated_effort=?, dependency=?, dependency_owner=?, remarks=?, status=?, reviewer_id=?,
      employee_id=?, task_type_id=?, main_task_id=?, task_activity_id=?, updated_at=datetime('now'), updated_by=?
    WHERE id=?
  `).run(
    after.description, after.priority, after.expected_outcome, after.due_date, after.due_time, after.estimated_effort, after.dependency, after.dependency_owner, after.remarks, after.status, after.reviewer_id,
    after.employee_id, after.task_type_id, after.main_task_id, after.task_activity_id, req.user.id, before.id
  );
  await auditDiff({
    tableName: 'commitments', recordId: before.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason,
    ownerId: before.employee_id, ownerName: await employeeName(before.employee_id),
  });
  res.json({ commitment: await db.prepare('SELECT * FROM commitments WHERE id = ?').get(before.id) });
}));

/** DELETE /api/scrum/commitments/:id — a Leader/Admin can remove a task they typed in themselves, by
 *  mistake. Never allowed for a task an employee logged for their own day, or an auto-generated
 *  support task — those stay permanent, matching the rest of the app's no-erase design for real activity.
 *  Super Admin is the one exception: they can delete any task outright, regardless of who created it. */
router.delete('/commitments/:id', asyncHandler(async (req, res) => {
  if (!['leader', 'admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only a Leader or Admin can delete a task.' });
  }
  const commitment = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Task not found.' });
  if (!(await assertCanEdit(req, res, commitment.employee_id))) return;
  if (req.user.role !== 'super_admin' && commitment.created_by !== req.user.id) {
    return res.status(403).json({ error: "You can only delete a task you created yourself — not something someone logged for their own day." });
  }
  if (commitment.carried_forward_to_id) {
    return res.status(400).json({ error: 'This task already created a follow-up task for someone else, so it can\'t be deleted. Change its status instead.' });
  }
  // requests.commitment_id is NOT NULL with no ON DELETE clause, so any request row referencing this
  // commitment — pending or already resolved — would fail the delete below with a raw foreign-key error.
  // A still-pending one needs its own trace before it disappears (the outcome is otherwise lost — audit_logs
  // is the permanent record here, not the operational requests row, same reasoning as the standalone
  // reject() path's orphaned-request handling in requests.js).
  const stillPending = await db.prepare(`SELECT id, type FROM requests WHERE commitment_id = ? AND status = 'pending'`).all(commitment.id);
  for (const r of stillPending) {
    await recordAudit({
      tableName: 'requests', recordId: r.id, fieldName: 'resolved',
      oldValue: null, newValue: `Auto-rejected — the task this ${r.type === 'support' ? 'support' : 'due-date-change'} request was about was deleted`,
      changedBy: req.user.id, changedByName: req.user.full_name,
    });
  }
  await db.transaction(async () => {
    await db.prepare('DELETE FROM requests WHERE commitment_id = ?').run(commitment.id);
    await db.prepare('DELETE FROM commitments WHERE id = ?').run(commitment.id);
  });
  await recordAudit({
    tableName: 'commitments', recordId: commitment.id, fieldName: 'deleted', oldValue: commitment.description,
    changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: commitment.employee_id, ownerName: await employeeName(commitment.employee_id),
  });
  res.json({ ok: true });
}));

/** POST /api/scrum/actions */
router.post('/actions', asyncHandler(async (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!(await assertCanEdit(req, res, employeeId))) return;
  if (!(await assertEmployeeExists(res, employeeId))) return;
  const b = req.body || {};
  if (!b.description || !b.description.trim()) return res.status(400).json({ error: 'Please describe the action needed.' });
  const id = uuid();
  await db.prepare(`
    INSERT INTO actions (id, employee_id, scrum_date, description, owner, due_date, priority, source, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, employeeId, b.scrum_date || today(), b.description.trim(), b.owner || null, b.due_date || null,
    b.priority || 'Medium', b.source || null, req.user.id, req.user.id
  );
  res.status(201).json({ action: await db.prepare('SELECT * FROM actions WHERE id = ?').get(id) });
}));

router.patch('/actions/:id', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Action not found.' });
  if (!(await assertCanEdit(req, res, before.employee_id))) return;
  const status = req.body?.status || before.status;
  const completionDate = status === 'completed' ? new Date().toISOString() : before.completion_date;
  await db.prepare(`UPDATE actions SET status=?, completion_date=?, remarks=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(status, completionDate, req.body?.remarks ?? before.remarks, req.user.id, before.id);
  await auditDiff({ tableName: 'actions', recordId: before.id, before, after: { status }, changedBy: req.user.id, changedByName: req.user.full_name });
  res.json({ action: await db.prepare('SELECT * FROM actions WHERE id = ?').get(before.id) });
}));

/** GET /api/scrum/suggestions — free-text reuse suggestions, never mandatory */
router.get('/suggestions', asyncHandler(async (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!(await assertCanView(req, res, employeeId))) return;
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = await db.prepare(`
    SELECT DISTINCT description FROM commitments WHERE employee_id = ? AND description LIKE ? ORDER BY created_at DESC LIMIT 8
  `).all(employeeId, q);
  res.json({ suggestions: rows.map((r) => r.description) });
}));

export default router;
