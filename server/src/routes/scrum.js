import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, today } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { canViewEmployee, canActOnEmployee, isReadOnly } from '../lib/scope.js';
import { withDelay, withLateness } from '../lib/delay.js';
import { nextOccurrence, describeRule, validateRule, legacyFrequencyToRule } from '../lib/recurrence.js';

const router = Router();
router.use(requireAuth);

function targetEmployeeId(req) {
  return req.query.employee_id || req.body?.employee_id || req.user.id;
}

/** Looked up whenever an audit entry needs to name the task's owner, separately from who made the change. */
function employeeName(id) {
  return db.prepare('SELECT full_name FROM users WHERE id = ?').get(id)?.full_name || null;
}

function assertCanView(req, res, employeeId) {
  if (!canViewEmployee(req.user, employeeId)) {
    res.status(403).json({ error: "You don't have permission to view this employee's data." });
    return false;
  }
  return true;
}

function assertEmployeeExists(res, employeeId) {
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(employeeId);
  if (!exists) {
    res.status(400).json({ error: 'That person could not be found.' });
    return false;
  }
  return true;
}

function assertCanEdit(req, res, employeeId) {
  if (isReadOnly(req.user)) {
    res.status(403).json({ error: 'Your role has read-only access.' });
    return false;
  }
  if (!canActOnEmployee(req.user, employeeId)) {
    res.status(403).json({ error: "You don't have permission to edit this employee's data." });
    return false;
  }
  return true;
}

/** GET /api/scrum/today — the full picture for one employee's day, driven by due date not creation date */
router.get('/today', (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!assertCanView(req, res, employeeId)) return;
  const date = req.query.date || today();

  // Needs Your Update: due date has passed and it isn't done yet — regardless of when it was created,
  // and regardless of whether it's still Pending or already flagged Support Required (they can act again).
  const overdue = db.prepare(`
    SELECT c.*, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name FROM commitments c
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id = ? AND c.due_date < ? AND c.status != 'completed' AND c.is_active = 1
    ORDER BY c.due_date
  `).all(employeeId, date).map((r) => withDelay(r, date));

  // Today's Work: whatever is due today, however long ago it was created (future-dated tasks land here automatically).
  const todayCommitments = db.prepare(`
    SELECT c.*, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name FROM commitments c
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id = ? AND c.due_date = ? AND c.is_active = 1 ORDER BY c.created_at
  `).all(employeeId, date);

  const openActions = db.prepare(`
    SELECT * FROM actions WHERE employee_id = ? AND status != 'completed' AND is_active = 1 ORDER BY created_at
  `).all(employeeId);

  const session = db.prepare('SELECT * FROM scrum_sessions WHERE employee_id = ? AND scrum_date = ?').get(employeeId, date);
  const employee = db.prepare('SELECT id, full_name, role, team_id, job_title FROM users WHERE id = ?').get(employeeId);

  res.json({
    date,
    employee,
    overdue,
    today_commitments: todayCommitments,
    open_actions: openActions,
    session: session || { status: 'pending' },
  });
});

/** GET /api/scrum/my-tasks — every open task belonging to the logged-in user, for the "My Tasks" page.
 *  Same shape as /api/leader/team-tasks, just scoped to self instead of a team, so both can share the
 *  same TeamTaskList frontend component. */
router.get('/my-tasks', (req, res) => {
  const date = req.query.date || today();
  const rows = db.prepare(`
    SELECT c.*, u.full_name AS employee_name, ra.frequency AS recurring_frequency, tt.name AS task_type_name, cat.name AS category_name
    FROM commitments c
    JOIN users u ON u.id = c.employee_id
    LEFT JOIN recurring_activities ra ON ra.id = c.recurring_activity_id
    LEFT JOIN task_types tt ON tt.id = c.task_type_id
    LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.employee_id = ? AND c.is_active = 1 AND c.status != 'completed'
    ORDER BY c.due_date, c.created_at DESC
  `).all(req.user.id);
  res.json({ date, tasks: rows.map((r) => withDelay(r, date)) });
});

/** POST /api/scrum/commitments — "What will you complete today?" */
router.post('/commitments', (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!assertCanEdit(req, res, employeeId)) return;
  if (!assertEmployeeExists(res, employeeId)) return;
  const b = req.body || {};
  if (!b.description || !b.description.trim()) return res.status(400).json({ error: 'Please describe the activity.' });

  // Type can arrive either as a task_type_id (from the admin-managed Type list) or, for backward
  // compatibility, the raw mechanic directly — either way it resolves to the same 'recurring'/'adhoc' split
  // the rest of the app (delay tracking, the repeat engine, dashboard splits) has always relied on.
  let taskTypeId = b.task_type_id || null;
  let type = b.type;
  if (taskTypeId) {
    const chosenType = db.prepare('SELECT * FROM task_types WHERE id = ? AND is_active = 1').get(taskTypeId);
    if (!chosenType) return res.status(400).json({ error: 'That type is no longer available. Choose another.' });
    type = chosenType.mechanic;
  }
  if (!['recurring', 'adhoc'].includes(type)) return res.status(400).json({ error: 'Type must be Recurring or Ad-hoc.' });
  if (b.priority && !['Low', 'Medium', 'High'].includes(b.priority)) {
    return res.status(400).json({ error: 'Priority must be Low, Medium, or High.' });
  }

  // Category is optional and independent of Type — it answers "what area of the business is this for"
  // (e.g. Finance, Compliance), not whether the task repeats.
  let categoryId = b.category_id || null;
  if (categoryId) {
    const chosenCategory = db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
    if (!chosenCategory) return res.status(400).json({ error: 'That category is no longer available. Choose another.' });
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
  if (type === 'recurring' && !recurringActivityId) {
    const existing = db.prepare('SELECT id FROM recurring_activities WHERE employee_id = ? AND lower(title) = lower(?)').get(employeeId, b.description.trim());
    if (existing) {
      // The recurring activity already exists — its schedule was set when it was first created, so a
      // rule chosen here again is ignored rather than silently changing every past occurrence's cadence.
      recurringActivityId = existing.id;
    } else {
      recurringActivityId = uuid();
      const seriesStart = b.due_date || b.scrum_date || today();
      db.prepare(`
        INSERT INTO recurring_activities (id, employee_id, title, frequency, recurrence_rule, series_start_date, task_type_id, category_id, priority, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(recurringActivityId, employeeId, b.description.trim(), describeRule(rule), JSON.stringify(rule), seriesStart, taskTypeId, categoryId, b.priority || 'Medium', req.user.id);
    }
  }

  const id = uuid();
  const date = b.scrum_date || today();
  const dueDate = b.due_date || date;
  db.prepare(`
    INSERT INTO commitments (
      id, employee_id, scrum_date, description, type, recurring_activity_id, task_type_id, category_id, priority, expected_outcome,
      start_date, due_date, original_due_date, due_time, estimated_effort, dependency, dependency_owner, remarks, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, employeeId, date, b.description.trim(), type, recurringActivityId, taskTypeId, categoryId, b.priority || 'Medium', b.expected_outcome || null,
    b.start_date || date, dueDate, dueDate, b.due_time || null, b.estimated_effort || null, b.dependency || null,
    b.dependency_owner || null, b.remarks || null, req.user.id, req.user.id
  );

  res.status(201).json({ commitment: db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) });
});

/** POST /api/scrum/commitments/:id/carry-forward — push the due date out without losing the original.
 *  The task stays the SAME record; only the current due date moves. original_due_date never changes. */
router.post('/commitments/:id/carry-forward', (req, res) => {
  const before = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Task not found.' });
  if (!assertCanEdit(req, res, before.employee_id)) return;

  const newDueDate = req.body?.new_due_date;
  if (!newDueDate) return res.status(400).json({ error: 'Please choose when you expect to complete this.' });

  // Only reset a Completed/Support Required task back to Pending — an In Progress (or already Pending)
  // task keeps its current status; moving its date shouldn't silently undo real progress.
  db.prepare(`
    UPDATE commitments SET due_date=?, status = CASE WHEN status IN ('completed','support_required') THEN 'pending' ELSE status END,
      updated_at=datetime('now'), updated_by=? WHERE id=?
  `).run(newDueDate, req.user.id, before.id);

  recordAudit({
    tableName: 'commitments', recordId: before.id, fieldName: 'carried_forward',
    oldValue: before.due_date, newValue: newDueDate, changedBy: req.user.id, changedByName: req.user.full_name,
    reason: req.body?.reason || null, ownerId: before.employee_id, ownerName: employeeName(before.employee_id),
  });

  res.json({ commitment: db.prepare('SELECT * FROM commitments WHERE id = ?').get(before.id) });
});

/** POST /api/scrum/commitments/:id/request-due-date-change — employee-initiated, doesn't touch the
 *  actual due_date. A Leader reviews it in the Requests inbox (routes/requests.js) and applies the same
 *  carry-forward logic on approval. Only the task's owner or a Leader can request one. */
router.post('/commitments/:id/request-due-date-change', (req, res) => {
  const before = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Task not found.' });
  if (!assertCanEdit(req, res, before.employee_id)) return;

  const requestedDate = req.body?.requested_due_date;
  if (!requestedDate) return res.status(400).json({ error: "Please choose the date you're requesting." });
  if (requestedDate === before.due_date) {
    return res.status(400).json({ error: "That's already this task's due date — choose a different one." });
  }

  const existingPending = db.prepare(`SELECT * FROM requests WHERE commitment_id = ? AND type = 'due_date_change' AND status = 'pending'`).get(before.id);
  if (existingPending) return res.status(400).json({ error: 'A due-date change request is already pending for this task.' });

  const id = uuid();
  db.prepare(`
    INSERT INTO requests (id, commitment_id, type, requested_by, reason, requested_due_date, status)
    VALUES (?, ?, 'due_date_change', ?, ?, ?, 'pending')
  `).run(id, before.id, req.user.id, req.body?.reason || null, requestedDate);

  res.status(201).json({ request: db.prepare('SELECT * FROM requests WHERE id = ?').get(id) });
});

/** POST /api/scrum/commitments/:id/resolve — mark a task Completed or Support Required.
 *  Support Required automatically creates a task for the employee's Leader asking them to help. */
router.post('/commitments/:id/resolve', (req, res) => {
  const before = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Commitment not found.' });
  if (!assertCanEdit(req, res, before.employee_id)) return;

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

  db.prepare(`
    UPDATE commitments SET status=?, completed_at=?, non_completion_reason=?, non_completion_explanation=?, new_target_date=?,
      updated_at=datetime('now'), updated_by=?
    WHERE id=?
  `).run(
    after.status, after.completed_at, after.non_completion_reason, after.non_completion_explanation, after.new_target_date,
    req.user.id, before.id
  );
  auditDiff({
    tableName: 'commitments', recordId: before.id, before, after: { status: after.status },
    changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: before.employee_id, ownerName: employeeName(before.employee_id),
  });

  // Support Required creates a Request for the task's owner's — not a shadow task assigned to a specific
  // team leader — so ANY leader-tier person can review and act on it from the Requests inbox, matching
  // the org-wide (not team-scoped) leader model. See routes/requests.js for the approve/reject side.
  let request = null;
  if (b.status === 'support_required') {
    const existingPending = db.prepare(`SELECT * FROM requests WHERE commitment_id = ? AND type = 'support' AND status = 'pending'`).get(before.id);
    if (existingPending) {
      request = existingPending;
    } else {
      const requestId = uuid();
      db.prepare(`
        INSERT INTO requests (id, commitment_id, type, requested_by, reason, explanation, status)
        VALUES (?, ?, 'support', ?, ?, ?, 'pending')
      `).run(requestId, before.id, req.user.id, b.non_completion_reason || null, b.non_completion_explanation || null);
      recordAudit({
        tableName: 'commitments', recordId: before.id, fieldName: 'support_requested', newValue: requestId,
        changedBy: req.user.id, changedByName: req.user.full_name, reason: b.non_completion_reason,
        ownerId: before.employee_id, ownerName: employeeName(before.employee_id),
      });
      request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    }
  }

  // Completing a Recurring task lines up its next occurrence automatically, so it shows up on the
  // right future day without anyone having to re-type it. Ad-hoc tasks and any other status don't repeat.
  let nextTask = null;
  let seriesEnded = false;
  if (b.status === 'completed' && before.type === 'recurring' && before.recurring_activity_id) {
    const activity = db.prepare('SELECT * FROM recurring_activities WHERE id = ? AND is_active = 1').get(before.recurring_activity_id);
    if (activity) {
      const nextDate = nextOccurrence(before.due_date || today(), activity);
      if (!nextDate) {
        // The series has run its course (its end date/occurrence count was reached) — stop repeating it.
        db.prepare('UPDATE recurring_activities SET is_active = 0 WHERE id = ?').run(activity.id);
        seriesEnded = true;
      } else {
        const already = db.prepare(`SELECT * FROM commitments WHERE recurring_activity_id = ? AND due_date = ? AND is_active = 1`).get(activity.id, nextDate);
        if (already) {
          nextTask = already;
        } else {
          // Insert-then-increment as one atomic step, so a crash between the two can't leave the next
          // occurrence created but occurrences_created stale, or vice versa.
          const newId = uuid();
          db.transaction(() => {
            db.prepare(`
              INSERT INTO commitments (
                id, employee_id, scrum_date, description, type, recurring_activity_id, task_type_id, category_id, priority, expected_outcome,
                start_date, due_date, original_due_date, estimated_effort, dependency, dependency_owner, created_by, updated_by
              ) VALUES (?, ?, ?, ?, 'recurring', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              newId, before.employee_id, nextDate, before.description, activity.id, before.task_type_id, before.category_id, before.priority, before.expected_outcome || null,
              nextDate, nextDate, nextDate, before.estimated_effort || null, before.dependency || null, before.dependency_owner || null,
              req.user.id, req.user.id
            );
            db.prepare('UPDATE recurring_activities SET occurrences_created = occurrences_created + 1 WHERE id = ?').run(activity.id);
          });
          nextTask = db.prepare('SELECT * FROM commitments WHERE id = ?').get(newId);
        }
      }
    }
  }

  const resolved = db.prepare('SELECT * FROM commitments WHERE id = ?').get(before.id);
  res.json({ commitment: withLateness(resolved), request, next_occurrence: nextTask, series_ended: seriesEnded });
});

/** PATCH /api/scrum/commitments/:id — general edit (due date change etc.), keeps audit trail */
router.patch('/commitments/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Commitment not found.' });
  if (!assertCanEdit(req, res, before.employee_id)) return;
  const fields = ['description', 'priority', 'expected_outcome', 'due_date', 'due_time', 'estimated_effort', 'dependency', 'dependency_owner', 'remarks'];
  const after = { ...before };
  for (const f of fields) if (req.body?.[f] !== undefined) after[f] = req.body[f];
  // A due-date change made through this general-purpose edit must reset a resolved task's status the
  // same way the dedicated carry-forward endpoint does — otherwise a task can end up shown as Completed
  // or Support Required with a due date that's silently moved out from under it.
  if (after.due_date !== before.due_date && ['completed', 'support_required'].includes(before.status)) {
    after.status = 'pending';
  }
  db.prepare(`
    UPDATE commitments SET description=?, priority=?, expected_outcome=?, due_date=?, due_time=?, estimated_effort=?, dependency=?, dependency_owner=?, remarks=?, status=?, updated_at=datetime('now'), updated_by=?
    WHERE id=?
  `).run(after.description, after.priority, after.expected_outcome, after.due_date, after.due_time, after.estimated_effort, after.dependency, after.dependency_owner, after.remarks, after.status, req.user.id, before.id);
  auditDiff({
    tableName: 'commitments', recordId: before.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason,
    ownerId: before.employee_id, ownerName: employeeName(before.employee_id),
  });
  res.json({ commitment: db.prepare('SELECT * FROM commitments WHERE id = ?').get(before.id) });
});

/** DELETE /api/scrum/commitments/:id — a Leader/Admin can remove a task they typed in themselves, by
 *  mistake. Never allowed for a task an employee logged for their own day, or an auto-generated
 *  support task — those stay permanent, matching the rest of the app's no-erase design for real activity. */
router.delete('/commitments/:id', (req, res) => {
  if (!['leader', 'admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only a Leader or Admin can delete a task.' });
  }
  const commitment = db.prepare('SELECT * FROM commitments WHERE id = ?').get(req.params.id);
  if (!commitment) return res.status(404).json({ error: 'Task not found.' });
  if (!assertCanEdit(req, res, commitment.employee_id)) return;
  if (commitment.created_by !== req.user.id) {
    return res.status(403).json({ error: "You can only delete a task you created yourself — not something someone logged for their own day." });
  }
  if (commitment.carried_forward_to_id) {
    return res.status(400).json({ error: 'This task already created a follow-up task for someone else, so it can\'t be deleted. Change its status instead.' });
  }
  // Auto-resolve any request still pending against this task first — otherwise it becomes permanently
  // unreachable (the Requests inbox joins to the commitment it points at) and sits pending forever.
  db.transaction(() => {
    db.prepare(`
      UPDATE requests SET status='rejected', resolved_by=?, resolved_at=datetime('now'), leader_note='Task was deleted.', updated_at=datetime('now')
      WHERE commitment_id = ? AND status = 'pending'
    `).run(req.user.id, commitment.id);
    db.prepare('DELETE FROM commitments WHERE id = ?').run(commitment.id);
  });
  recordAudit({
    tableName: 'commitments', recordId: commitment.id, fieldName: 'deleted', oldValue: commitment.description,
    changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: commitment.employee_id, ownerName: employeeName(commitment.employee_id),
  });
  res.json({ ok: true });
});

/** POST /api/scrum/actions */
router.post('/actions', (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!assertCanEdit(req, res, employeeId)) return;
  if (!assertEmployeeExists(res, employeeId)) return;
  const b = req.body || {};
  if (!b.description || !b.description.trim()) return res.status(400).json({ error: 'Please describe the action needed.' });
  const id = uuid();
  db.prepare(`
    INSERT INTO actions (id, employee_id, scrum_date, description, owner, due_date, priority, source, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, employeeId, b.scrum_date || today(), b.description.trim(), b.owner || null, b.due_date || null,
    b.priority || 'Medium', b.source || null, req.user.id, req.user.id
  );
  res.status(201).json({ action: db.prepare('SELECT * FROM actions WHERE id = ?').get(id) });
});

router.patch('/actions/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM actions WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Action not found.' });
  if (!assertCanEdit(req, res, before.employee_id)) return;
  const status = req.body?.status || before.status;
  const completionDate = status === 'completed' ? new Date().toISOString() : before.completion_date;
  db.prepare(`UPDATE actions SET status=?, completion_date=?, remarks=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(status, completionDate, req.body?.remarks ?? before.remarks, req.user.id, before.id);
  auditDiff({ tableName: 'actions', recordId: before.id, before, after: { status }, changedBy: req.user.id, changedByName: req.user.full_name });
  res.json({ action: db.prepare('SELECT * FROM actions WHERE id = ?').get(before.id) });
});

/** POST /api/scrum/escalations */
router.post('/escalations', (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!assertCanEdit(req, res, employeeId)) return;
  if (!assertEmployeeExists(res, employeeId)) return;
  const b = req.body || {};
  if (!b.issue || !b.issue.trim()) return res.status(400).json({ error: 'Please describe the issue being escalated.' });
  const id = uuid();
  db.prepare(`
    INSERT INTO escalations (id, issue, employee_id, activity_id, escalated_by, escalated_to, required_action, target_resolution_date, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, b.issue.trim(), employeeId, b.activity_id || null, req.user.full_name,
    b.escalated_to || null, b.required_action || null, b.target_resolution_date || null, req.user.id, req.user.id
  );
  res.status(201).json({ escalation: db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) });
});

router.patch('/escalations/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM escalations WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Escalation not found.' });
  if (!assertCanEdit(req, res, before.employee_id)) return;
  const status = req.body?.status || before.status;
  const resolutionDate = status === 'resolved' ? new Date().toISOString() : before.resolution_date;
  db.prepare(`UPDATE escalations SET status=?, resolution_date=?, resolution_remarks=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(status, resolutionDate, req.body?.resolution_remarks ?? before.resolution_remarks, req.user.id, before.id);
  auditDiff({ tableName: 'escalations', recordId: before.id, before, after: { status }, changedBy: req.user.id, changedByName: req.user.full_name });
  res.json({ escalation: db.prepare('SELECT * FROM escalations WHERE id = ?').get(before.id) });
});

/** POST /api/scrum/confirm — Step 5, confirm today's commitments */
router.post('/confirm', (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!assertCanEdit(req, res, employeeId)) return;
  const date = req.body?.date || today();
  const existing = db.prepare('SELECT * FROM scrum_sessions WHERE employee_id = ? AND scrum_date = ?').get(employeeId, date);
  if (existing) {
    db.prepare(`UPDATE scrum_sessions SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(existing.id);
  } else {
    db.prepare(`INSERT INTO scrum_sessions (id, employee_id, scrum_date, status, completed_at) VALUES (?, ?, ?, 'completed', datetime('now'))`)
      .run(uuid(), employeeId, date);
  }
  res.json({ ok: true });
});

/** GET /api/scrum/suggestions — free-text reuse suggestions, never mandatory */
router.get('/suggestions', (req, res) => {
  const employeeId = targetEmployeeId(req);
  if (!assertCanView(req, res, employeeId)) return;
  const q = `%${(req.query.q || '').trim()}%`;
  const rows = db.prepare(`
    SELECT DISTINCT description FROM commitments WHERE employee_id = ? AND description LIKE ? ORDER BY created_at DESC LIMIT 8
  `).all(employeeId, q);
  res.json({ suggestions: rows.map((r) => r.description) });
});

export default router;
