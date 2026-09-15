import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db, today } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { describeRule, validateRule, legacyFrequencyToRule, firstDueDate } from '../lib/recurrence.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('super_admin', 'admin'));

/** GET /api/recurring-tasks — the master checklist: every recurring activity across the org, one row
 *  per employee it's assigned to (the data model ties each recurring activity to one employee). */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT ra.*, u.full_name AS employee_name, tt.name AS task_type_name, cat.name AS category_name
    FROM recurring_activities ra
    JOIN users u ON u.id = ra.employee_id
    LEFT JOIN task_types tt ON tt.id = ra.task_type_id
    LEFT JOIN categories cat ON cat.id = ra.category_id
    ORDER BY ra.is_active DESC, ra.title, u.full_name
  `).all();
  res.json({ recurring_tasks: rows });
});

/** POST /api/recurring-tasks — build one recurring task and assign it to one or more employees at once.
 *  For each employee this creates their own recurring_activities row plus an initial commitment due on
 *  start_date, reusing the exact same repeat-on-completion engine as a manually-typed recurring task. */
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.title.trim()) return res.status(400).json({ error: 'Please describe the recurring task.' });
  if (!Array.isArray(b.employee_ids) || b.employee_ids.length === 0) {
    return res.status(400).json({ error: 'Choose at least one person to assign this to.' });
  }
  const rule = b.recurrence_rule || legacyFrequencyToRule(b.frequency || 'Daily');
  const ruleError = validateRule(rule);
  if (ruleError) return res.status(400).json({ error: ruleError });
  const startDate = b.start_date || today();
  const priority = b.priority || 'Medium';

  let taskTypeId = b.task_type_id || null;
  let mechanic = 'recurring';
  if (taskTypeId) {
    const type = db.prepare('SELECT * FROM task_types WHERE id = ? AND is_active = 1').get(taskTypeId);
    if (!type) return res.status(400).json({ error: 'That type is no longer available. Choose another.' });
    // A recurring template built against an Ad-hoc-mechanic type would silently die after its first
    // occurrence, since the completion engine only regenerates a next occurrence for type='recurring'.
    if (type.mechanic !== 'recurring') return res.status(400).json({ error: 'Choose a Recurring-type category for a recurring task.' });
    mechanic = type.mechanic;
  }

  let categoryId = b.category_id || null;
  if (categoryId) {
    const category = db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
    if (!category) return res.status(400).json({ error: 'That category is no longer available. Choose another.' });
  }

  // The seed occurrence's due date snaps forward to the rule's own weekday selection, so a series
  // started on a day outside that selection doesn't have an out-of-pattern first due date.
  const dueDate = firstDueDate(startDate, rule);

  const created = db.transaction(() => {
    const rows = [];
    for (const employeeId of b.employee_ids) {
      const employee = db.prepare("SELECT id, full_name FROM users WHERE id = ? AND is_active = 1 AND role = 'employee'").get(employeeId);
      if (!employee) continue; // skip silently — a deactivated/removed/non-employee person shouldn't block the rest of the assignment

      const activityId = uuid();
      db.prepare(`
        INSERT INTO recurring_activities (id, employee_id, title, frequency, recurrence_rule, series_start_date, task_type_id, category_id, priority, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(activityId, employeeId, b.title.trim(), describeRule(rule), JSON.stringify(rule), startDate, taskTypeId, categoryId, priority, req.user.id);

      const commitmentId = uuid();
      db.prepare(`
        INSERT INTO commitments (
          id, employee_id, scrum_date, description, type, recurring_activity_id, task_type_id, category_id, priority,
          start_date, due_date, original_due_date, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        commitmentId, employeeId, startDate, b.title.trim(), mechanic, activityId, taskTypeId, categoryId, priority,
        startDate, dueDate, dueDate, req.user.id, req.user.id
      );

      recordAudit({
        tableName: 'recurring_activities', recordId: activityId, fieldName: 'assigned', newValue: b.title.trim(),
        changedBy: req.user.id, changedByName: req.user.full_name,
        ownerId: employeeId, ownerName: employee.full_name,
      });
      rows.push(db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(activityId));
    }
    return rows;
  });

  if (created.length === 0) return res.status(400).json({ error: 'None of the chosen people could be assigned this task.' });
  res.status(201).json({ recurring_tasks: created });
});

/** PATCH /api/recurring-tasks/:id — pause or resume one person's assignment. Pausing only stops future
 *  occurrences from being generated; nothing already created is touched. */
router.patch('/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Recurring task not found.' });
  const isActive = req.body?.is_active ? 1 : 0;
  db.prepare('UPDATE recurring_activities SET is_active = ? WHERE id = ?').run(isActive, req.params.id);
  recordAudit({
    tableName: 'recurring_activities', recordId: req.params.id, fieldName: 'is_active',
    oldValue: before.is_active, newValue: isActive, changedBy: req.user.id, changedByName: req.user.full_name,
    ownerId: before.employee_id, ownerName: db.prepare('SELECT full_name FROM users WHERE id = ?').get(before.employee_id)?.full_name || null,
  });
  res.json({ recurring_task: db.prepare('SELECT * FROM recurring_activities WHERE id = ?').get(req.params.id) });
});

export default router;
