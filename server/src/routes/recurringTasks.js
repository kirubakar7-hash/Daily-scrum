import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, today } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { describeRule, validateRule, legacyFrequencyToRule, firstDueDate } from '../lib/recurrence.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { resolveDefaultCategoryId } from '../lib/masterData.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('super_admin', 'admin'));

/** GET /api/recurring-tasks — the master checklist: every recurring activity across the org, one row
 *  per employee it's assigned to (the data model ties each recurring activity to one employee). */
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT ra.*, u.full_name AS employee_name, tt.name AS task_type_name, cat.name AS category_name, mt.name AS main_task_name, ta.name AS task_activity_name
    FROM recurring_activities ra
    JOIN users u ON u.id = ra.employee_id
    LEFT JOIN task_types tt ON tt.id = ra.task_type_id
    LEFT JOIN categories cat ON cat.id = ra.category_id
    LEFT JOIN main_tasks mt ON mt.id = ra.main_task_id
    LEFT JOIN task_activities ta ON ta.id = ra.task_activity_id
    ORDER BY ra.is_active DESC, ra.title, u.full_name
  `).all();
  res.json({ recurring_tasks: rows });
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

/** PATCH /api/recurring-tasks/:id — pause or resume one person's assignment. Pausing only stops future
 *  occurrences from being generated; nothing already created is touched. */
router.patch('/:id', asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Recurring task not found.' });
  const isActive = req.body?.is_active ? 1 : 0;
  await db.prepare('UPDATE recurring_activities SET is_active = ? WHERE id = ?').run(isActive, req.params.id);
  await recordAudit({
    tableName: 'recurring_activities', recordId: req.params.id, fieldName: 'is_active',
    oldValue: before.is_active, newValue: isActive, changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: before.employee_id, ownerName: (await db.prepare('SELECT full_name FROM users WHERE id = ?').get(before.employee_id))?.full_name || null,
  });
  res.json({ recurring_task: await db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(req.params.id) });
}));

export default router;
