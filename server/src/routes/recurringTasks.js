import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, today } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { describeRule, validateRule, legacyFrequencyToRule, firstDueDate, parseRule } from '../lib/recurrence.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { resolveDefaultCategoryId } from '../lib/masterData.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('super_admin', 'admin'));

/** GET /api/recurring-tasks — the master checklist: every recurring activity across the org, one row
 *  per employee it's assigned to (the data model ties each recurring activity to one employee). */
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT ra.*, u.full_name AS employee_name,
      (SELECT COUNT(*) FROM commitments c WHERE c.recurring_activity_id = ra.id)::int AS task_count, tt.name AS task_type_name, cat.name AS category_name, mt.name AS main_task_name, ta.name AS task_activity_name
    FROM recurring_activities ra
    JOIN users u ON u.id = ra.employee_id
    LEFT JOIN task_types tt ON tt.id = ra.task_type_id
    LEFT JOIN categories cat ON cat.id = ra.category_id
    LEFT JOIN main_tasks mt ON mt.id = ra.main_task_id
    LEFT JOIN task_activities ta ON ta.id = ra.task_activity_id
    ORDER BY ra.is_active DESC, ra.title, u.full_name
  `).all();
  // `rule` is the parsed schedule (older series only have a frequency label) so the Edit form can show the
  // current schedule without re-implementing the legacy mapping in the browser.
  res.json({ recurring_tasks: rows.map((r) => ({ ...r, rule: parseRule(r) })) });
}));

/** Shared by the single-create route and the bulk CSV import below — builds one recurring task and
 *  assigns it to one or more employees at once. For each employee this creates their own
 *  recurring_activities row plus an initial commitment due on start_date, reusing the exact same
 *  repeat-on-completion engine as a manually-typed recurring task. Throws a plain Error with a
 *  user-facing message on any validation failure, so both callers can turn that into the right response. */
async function createRecurringTask(b, req) {
  if (!b.title || !b.title.trim()) throw new Error('Please describe the recurring task.');
  if (!Array.isArray(b.employee_ids) || b.employee_ids.length === 0) {
    throw new Error('Choose at least one person to assign this to.');
  }
  const rule = b.recurrence_rule || legacyFrequencyToRule(b.frequency || 'Daily');
  const ruleError = validateRule(rule);
  if (ruleError) throw new Error(ruleError);
  const startDate = b.start_date || today();
  const priority = b.priority || 'Medium';

  let taskTypeId = b.task_type_id || null;
  let mechanic = 'recurring';
  if (taskTypeId) {
    const type = await db.prepare('SELECT * FROM task_types WHERE id = ? AND is_active = 1').get(taskTypeId);
    if (!type) throw new Error('That type is no longer available. Choose another.');
    // A recurring template built against an Ad-hoc-mechanic type would silently die after its first
    // occurrence, since the completion engine only regenerates a next occurrence for type='recurring'.
    if (type.mechanic !== 'recurring') throw new Error('Choose a Recurring-type category for a recurring task.');
    mechanic = type.mechanic;
  }

  // Process → Activity is required on every actual task, recurring templates included — same reasoning
  // as the ad-hoc Create Task form in scrum.js. Function is auto-resolved rather than asked for — see
  // resolveDefaultCategoryId's own comment.
  let categoryId = b.category_id || null;
  if (!categoryId) categoryId = await resolveDefaultCategoryId();
  if (!categoryId) throw new Error('Choose the Function this task belongs to.');
  const category = await db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
  if (!category) throw new Error('That Function is no longer available. Choose another.');

  const mainTaskId = b.main_task_id || null;
  if (!mainTaskId) throw new Error('Choose the Process this task belongs to.');
  const mainTask = await db.prepare('SELECT id FROM main_tasks WHERE id = ? AND is_active = 1').get(mainTaskId);
  if (!mainTask) throw new Error('That Process is no longer available. Choose another.');

  const taskActivityId = b.task_activity_id || null;
  if (!taskActivityId) throw new Error('Choose the Activity this task belongs to.');
  const activity = await db.prepare('SELECT id FROM task_activities WHERE id = ? AND is_active = 1').get(taskActivityId);
  if (!activity) throw new Error('That Activity is no longer available. Choose another.');

  // Reviewer defaults per-employee to their manager (see scope.js's org hierarchy) unless the caller
  // names one explicitly — every assignee in a multi-person recurring task can have a different manager.
  let explicitReviewerId;
  if (b.reviewer_id !== undefined) {
    if (b.reviewer_id) {
      const reviewer = await db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(b.reviewer_id);
      if (!reviewer) throw new Error('That reviewer is no longer available. Choose another.');
    }
    explicitReviewerId = b.reviewer_id || null;
  }

  // The seed occurrence's due date snaps forward to the rule's own weekday selection, so a series
  // started on a day outside that selection doesn't have an out-of-pattern first due date.
  const dueDate = firstDueDate(startDate, rule);

  const created = await db.transaction(async () => {
    const rows = [];
    for (const employeeId of b.employee_ids) {
      const employee = await db.prepare("SELECT id, full_name, manager_id FROM users WHERE id = ? AND is_active = 1 AND role = 'employee'").get(employeeId);
      if (!employee) continue; // skip silently — a deactivated/removed/non-employee person shouldn't block the rest of the assignment
      const reviewerId = explicitReviewerId !== undefined ? explicitReviewerId : (employee.manager_id || null);

      const activityId = uuid();
      await db.prepare(`
        INSERT INTO recurring_activities (id, employee_id, title, frequency, recurrence_rule, series_start_date, task_type_id, category_id, main_task_id, task_activity_id, reviewer_id, priority, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(activityId, employeeId, b.title.trim(), describeRule(rule), JSON.stringify(rule), startDate, taskTypeId, categoryId, mainTaskId, taskActivityId, reviewerId, priority, req.user.id);

      const commitmentId = uuid();
      await db.prepare(`
        INSERT INTO commitments (
          id, employee_id, scrum_date, description, type, recurring_activity_id, task_type_id, category_id, main_task_id, task_activity_id, reviewer_id, priority,
          start_date, due_date, original_due_date, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        commitmentId, employeeId, startDate, b.title.trim(), mechanic, activityId, taskTypeId, categoryId, mainTaskId, taskActivityId, reviewerId, priority,
        startDate, dueDate, dueDate, req.user.id, req.user.id
      );

      await recordAudit({
        tableName: 'recurring_activities', recordId: activityId, fieldName: 'assigned', newValue: b.title.trim(),
        changedBy: req.user.id, changedByName: req.user.full_name,
        ownerId: employeeId, ownerName: employee.full_name,
      });
      await recordAudit({
        tableName: 'commitments', recordId: commitmentId, fieldName: 'created', newValue: b.title.trim(),
        changedBy: req.user.id, changedByName: req.user.full_name, reason: 'First occurrence of a new recurring series',
        ownerId: employeeId, ownerName: employee.full_name,
      });
      rows.push(await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(activityId));
    }
    return rows;
  });

  if (created.length === 0) throw new Error('None of the chosen people could be assigned this task.');
  return created;
}

/** POST /api/recurring-tasks — build one recurring task and assign it to one or more employees at once. */
router.post('/', asyncHandler(async (req, res) => {
  try {
    const created = await createRecurringTask(req.body || {}, req);
    res.status(201).json({ recurring_tasks: created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

/** POST /api/recurring-tasks/import — bulk import from the Admin page's CSV template. One row can
 *  assign to several people at once via a semicolon-separated employee_emails cell, reusing the exact
 *  same createRecurringTask() fan-out the single-create form uses — only the name→ID resolution (email,
 *  task type name, category name) is specific to this endpoint, since a CSV names things, not IDs. */
router.post('/import', asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const users = await db.prepare('SELECT id, email FROM users').all();
  const userByEmail = new Map(users.map((u) => [u.email.trim().toLowerCase(), u.id]));
  const taskTypes = await db.prepare('SELECT id, name FROM task_types').all();
  const taskTypeByName = new Map(taskTypes.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const categories = await db.prepare('SELECT id, name FROM categories').all();
  const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const mainTasks = await db.prepare('SELECT id, name FROM main_tasks').all();
  const mainTaskByName = new Map(mainTasks.map((m) => [m.name.trim().toLowerCase(), m.id]));
  const activities = await db.prepare('SELECT id, name FROM task_activities').all();
  const activityByName = new Map(activities.map((a) => [a.name.trim().toLowerCase(), a.id]));
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const emails = (r.employee_emails || '').split(';').map((e) => e.trim()).filter(Boolean);
      if (emails.length === 0) throw new Error('employee_emails is required (semicolon-separated if more than one).');
      const employee_ids = emails.map((e) => userByEmail.get(e.toLowerCase())).filter(Boolean);
      if (employee_ids.length === 0) throw new Error('None of the listed emails matched an existing user.');

      let task_type_id = null;
      const taskTypeName = (r.task_type_name || '').trim();
      if (taskTypeName) {
        task_type_id = taskTypeByName.get(taskTypeName.toLowerCase());
        if (!task_type_id) throw new Error(`Task type "${taskTypeName}" was not found.`);
      }
      const categoryName = (r.category_name || '').trim();
      let category_id;
      if (categoryName) {
        category_id = categoryByName.get(categoryName.toLowerCase());
        if (!category_id) throw new Error(`Function "${categoryName}" was not found.`);
      } else {
        category_id = await resolveDefaultCategoryId();
        if (!category_id) throw new Error('category_name is required — more than one Function exists, so it can\'t be auto-picked.');
      }

      const mainTaskName = (r.main_task_name || '').trim();
      if (!mainTaskName) throw new Error('main_task_name is required — every task must belong to a Process.');
      const main_task_id = mainTaskByName.get(mainTaskName.toLowerCase());
      if (!main_task_id) throw new Error(`Process "${mainTaskName}" was not found.`);

      const activityName = (r.activity_name || '').trim();
      if (!activityName) throw new Error('activity_name is required — every task must belong to an Activity.');
      const task_activity_id = activityByName.get(activityName.toLowerCase());
      if (!task_activity_id) throw new Error(`Activity "${activityName}" was not found.`);

      let reviewer_id;
      const reviewerEmail = (r.reviewer_email || '').trim();
      if (reviewerEmail) {
        reviewer_id = userByEmail.get(reviewerEmail.toLowerCase());
        if (!reviewer_id) throw new Error(`No user found with reviewer email "${reviewerEmail}".`);
      }

      const created = await createRecurringTask({
        title: r.title,
        employee_ids,
        task_type_id,
        category_id,
        main_task_id,
        task_activity_id,
        reviewer_id,
        priority: (r.priority || '').trim() || undefined,
        start_date: (r.start_date || '').trim() || undefined,
        frequency: (r.frequency || '').trim() || undefined,
      }, req);
      const note = created.length < emails.length ? `Assigned to ${created.length} of ${emails.length} listed people — the rest didn't match an active employee.` : undefined;
      results.push({ row: i + 1, success: true, note });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

/** PATCH /api/recurring-tasks/:id — edit one person's recurring task (Admin → Recurring Tasks → Edit), or
 *  pause/resume it. Only the fields sent are changed. An edit shapes every task generated from now on —
 *  the series row is what the scheduler copies from (see insertOccurrence) — while tasks already on
 *  someone's list keep their details, exactly like pausing leaves already-created tasks alone. A changed
 *  schedule takes over from the most recent task: its next date is worked out with the new rule. */
router.patch('/:id', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Recurring task not found.' });
  const b = req.body || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(b, key);
  const bad = (error) => res.status(400).json({ error });
  const updates = {};

  if (has('title')) {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) return bad('Please describe the recurring task.');
    updates.title = title;
  }
  if (has('employee_id')) {
    const employee = await db.prepare(`SELECT id FROM users WHERE id = ? AND is_active = 1 AND role IN ('employee', 'leader')`).get(b.employee_id);
    if (!employee) return bad('That person is no longer available. Choose someone else.');
    updates.employee_id = employee.id;
  }
  if (has('priority')) {
    if (!['Low', 'Medium', 'High'].includes(b.priority)) return bad('Priority must be Low, Medium, or High.');
    updates.priority = b.priority;
  }
  if (has('task_type_id')) {
    const type = await db.prepare('SELECT mechanic FROM task_types WHERE id = ? AND is_active = 1').get(b.task_type_id);
    if (!type) return bad('That type is no longer available. Choose another.');
    if (type.mechanic !== 'recurring') return bad('Choose a Recurring-type category for a recurring task.');
    updates.task_type_id = b.task_type_id;
  }
  if (has('main_task_id')) {
    if (!(await db.prepare('SELECT id FROM main_tasks WHERE id = ? AND is_active = 1').get(b.main_task_id))) return bad('Choose the Process this task belongs to.');
    updates.main_task_id = b.main_task_id;
  }
  if (has('task_activity_id')) {
    if (!(await db.prepare('SELECT id FROM task_activities WHERE id = ? AND is_active = 1').get(b.task_activity_id))) return bad('Choose the Activity this task belongs to.');
    updates.task_activity_id = b.task_activity_id;
  }
  if (has('reviewer_id')) {
    if (b.reviewer_id && !(await db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(b.reviewer_id))) {
      return bad('That reviewer is no longer available. Choose another.');
    }
    updates.reviewer_id = b.reviewer_id || null;
  }
  if (has('recurrence_rule')) {
    const ruleError = validateRule(b.recurrence_rule);
    if (ruleError) return bad(ruleError);
    updates.recurrence_rule = JSON.stringify(b.recurrence_rule);
    updates.frequency = describeRule(b.recurrence_rule);
  }
  if (has('is_active')) updates.is_active = b.is_active ? 1 : 0;

  // Team Tasks finds an existing series by (person, name) when a recurring task is typed in again, so two
  // series for the same person must never share a name.
  const finalTitle = updates.title ?? before.title;
  const finalEmployee = updates.employee_id ?? before.employee_id;
  if (updates.title !== undefined || updates.employee_id !== undefined) {
    const clash = await db.prepare('SELECT id FROM recurring_activities WHERE employee_id = ? AND lower(title) = lower(?) AND id != ?').get(finalEmployee, finalTitle, before.id);
    if (clash) return bad('This person already has a recurring task with that name.');
  }

  // Only what actually changed is written and audited.
  const changed = Object.keys(updates).filter((k) => String(updates[k] ?? '') !== String(before[k] ?? ''));
  if (changed.length > 0) {
    await db.prepare(`UPDATE recurring_activities SET ${changed.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...changed.map((k) => updates[k]), before.id);
    const ownerId = finalEmployee;
    const ownerName = (await db.prepare('SELECT full_name FROM users WHERE id = ?').get(ownerId))?.full_name || null;
    // The audit trail shows names, never raw IDs.
    const NAME_OF = {
      employee_id: 'SELECT full_name AS n FROM users WHERE id = ?', reviewer_id: 'SELECT full_name AS n FROM users WHERE id = ?',
      task_type_id: 'SELECT name AS n FROM task_types WHERE id = ?', main_task_id: 'SELECT name AS n FROM main_tasks WHERE id = ?',
      task_activity_id: 'SELECT name AS n FROM task_activities WHERE id = ?',
    };
    const readable = async (k, v) => (NAME_OF[k] && v ? (await db.prepare(NAME_OF[k]).get(v))?.n || null : v);
    for (const k of changed) {
      if (k === 'recurrence_rule') continue; // recorded through its readable label, `frequency`, instead
      await recordAudit({
        tableName: 'recurring_activities', recordId: before.id, fieldName: k,
        oldValue: await readable(k, before[k]), newValue: await readable(k, updates[k]), changedBy: req.user.id, changedByName: req.user.full_name,
        ownerId, ownerName,
      });
    }
  }
  const after = await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(before.id);
  res.json({ recurring_task: { ...after, rule: parseRule(after) } });
}));

/** DELETE /api/recurring-tasks/:id — remove one person's recurring task for good, so nothing more is ever
 *  generated from it. Every task it already created is kept — they're real work records that Team Tasks,
 *  History, the dashboards and the audit trail still point at — and just unlinked from the deleted series
 *  (recurring_activity_id → NULL), keeping their Recurring type. An open one can still be deleted on its
 *  own from Team Tasks. One transaction, so the audit entry, the unlinking and the delete land together. */
router.delete('/:id', asyncHandler(async (req, res) => {
  const series = await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(req.params.id);
  if (!series) return res.status(404).json({ error: 'Recurring task not found.' });
  const owner = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(series.employee_id);
  const kept = (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE recurring_activity_id = ?').get(series.id)).c;

  await db.transaction(async () => {
    await recordAudit({
      tableName: 'recurring_activities', recordId: series.id, fieldName: 'deleted',
      oldValue: `${series.title} (${series.frequency || 'recurring'})`,
      changedBy: req.user.id, changedByName: req.user.full_name,
      reason: kept ? `${kept} task${kept === 1 ? '' : 's'} it already created ${kept === 1 ? 'was' : 'were'} kept` : null,
      ownerId: series.employee_id, ownerName: owner?.full_name || null,
    });
    await db.prepare('UPDATE commitments SET recurring_activity_id = NULL WHERE recurring_activity_id = ?').run(series.id);
    await db.prepare('DELETE FROM recurring_activities WHERE id = ?').run(series.id);
  });
  res.json({ ok: true, tasks_kept: kept });
}));

export default router;
