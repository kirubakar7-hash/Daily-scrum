import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

/** GET /api/task-activities — anyone signed in can read the list, to populate the Activity dropdown when
 *  logging work. Sits one level under Main Task: a Main Task (e.g. FP&A) contains several Activities
 *  (e.g. "Rolling forecast updates"), each of which is a standard, recurring piece of work someone can
 *  pick instead of retyping the same description every time. */
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT ta.*, mt.name AS main_task_name
    FROM task_activities ta
    LEFT JOIN main_tasks mt ON mt.id = ta.main_task_id
    ORDER BY ta.is_active DESC, ta.name
  `).all();
  res.json({ task_activities: rows });
}));

/** POST /api/task-activities — Admin defines a new Activity, parked under a Main Task (Process).
 *  main_task_id is required — an Activity must always belong to a Process, so History/reporting can
 *  never show an Activity floating without one. */
router.post('/', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const { name, main_task_id, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Activity name is required.' });
  if (!main_task_id) return res.status(400).json({ error: 'Choose the Process this Activity belongs to.' });
  const mainTask = await db.prepare('SELECT id FROM main_tasks WHERE id = ? AND is_active = 1').get(main_task_id);
  if (!mainTask) return res.status(400).json({ error: 'That Main Task is no longer available. Choose another.' });
  const id = uuid();
  try {
    await db.prepare(`INSERT INTO task_activities (id, name, main_task_id, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name.trim(), main_task_id || null, description || null, req.user.id, req.user.id);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An Activity with this name already exists.' });
    throw e;
  }
  await recordAudit({ tableName: 'task_activities', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ task_activity: await db.prepare('SELECT * FROM task_activities WHERE id = ?').get(id) });
}));

/** POST /api/task-activities/import — bulk import from the Admin page's CSV template, same validation as
 *  the single POST / above, per-row so one bad row doesn't stop the rest. main_task_name is resolved to
 *  main_task_id the same way the other import endpoints resolve names to IDs. */
router.post('/import', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  // Active only — matching the single-create route's own check (below) so a CSV import can't park a new
  // Activity under a Process that's been deactivated, something the single-create form already refuses.
  const mainTasks = await db.prepare('SELECT id, name FROM main_tasks WHERE is_active = 1').all();
  const mainTaskByName = new Map(mainTasks.map((m) => [m.name.trim().toLowerCase(), m.id]));
  const seenNames = new Set();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const name = (r.name || '').trim();
      const description = (r.description || '').trim() || null;
      const mainTaskName = (r.main_task_name || '').trim();
      if (!name) throw new Error('Activity name is required.');
      if (seenNames.has(name.toLowerCase())) throw new Error('Duplicate Activity name within this file.');
      if (!mainTaskName) throw new Error('main_task_name is required — every Activity must belong to a Process.');
      const main_task_id = mainTaskByName.get(mainTaskName.toLowerCase());
      if (!main_task_id) throw new Error(`Main Task "${mainTaskName}" was not found or is no longer available.`);

      const id = uuid();
      try {
        await db.prepare(`INSERT INTO task_activities (id, name, main_task_id, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, name, main_task_id, description, req.user.id, req.user.id);
      } catch (e) {
        if (e.code === '23505') throw new Error('An Activity with this name already exists.');
        throw e;
      }
      seenNames.add(name.toLowerCase());
      await recordAudit({ tableName: 'task_activities', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Bulk import' });
      results.push({ row: i + 1, success: true });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

/** PATCH /api/task-activities/:id — rename, re-parent under a different Main Task, edit description, or
 *  deactivate. */
router.patch('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM task_activities WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Activity not found.' });
  const { name, main_task_id, description, is_active, reason } = req.body || {};
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Activity name is required.' });
  if (main_task_id !== undefined) {
    if (!main_task_id) return res.status(400).json({ error: 'An Activity must always belong to a Process — choose one instead of clearing it.' });
    const mainTask = await db.prepare('SELECT id FROM main_tasks WHERE id = ? AND is_active = 1').get(main_task_id);
    if (!mainTask) return res.status(400).json({ error: 'That Main Task is no longer available. Choose another.' });
  }
  const after = {
    name: name !== undefined ? name.trim() : before.name,
    main_task_id: main_task_id !== undefined ? (main_task_id || null) : before.main_task_id,
    description: description !== undefined ? description : before.description,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };
  await db.prepare(`UPDATE task_activities SET name=?, main_task_id=?, description=?, is_active=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(after.name, after.main_task_id, after.description, after.is_active, req.user.id, req.params.id);
  await auditDiff({ tableName: 'task_activities', recordId: req.params.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason });
  res.json({ task_activity: await db.prepare('SELECT * FROM task_activities WHERE id = ?').get(req.params.id) });
}));

/** DELETE /api/task-activities/:id — blocked for any Activity already used by a task (deactivate instead,
 *  matching Main Tasks/Categories/Task Types) so History never points at an Activity that no longer exists. */
router.delete('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const activity = await db.prepare('SELECT * FROM task_activities WHERE id = ?').get(req.params.id);
  if (!activity) return res.status(404).json({ error: 'Activity not found.' });

  const usedCount = (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE task_activity_id = ?').get(req.params.id)).c;
  const templateCount = (await db.prepare('SELECT COUNT(*) c FROM recurring_activities WHERE task_activity_id = ?').get(req.params.id)).c;
  if (usedCount > 0 || templateCount > 0) {
    const parts = [usedCount > 0 && `${usedCount} task(s)`, templateCount > 0 && `${templateCount} recurring template(s)`].filter(Boolean);
    return res.status(409).json({ error: `${parts.join(' and ')} already use this Activity. Deactivate it instead of deleting it.` });
  }

  await recordAudit({ tableName: 'task_activities', recordId: req.params.id, fieldName: 'deleted', oldValue: activity.name, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason || req.query?.reason });
  await db.prepare('DELETE FROM task_activities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

export default router;
