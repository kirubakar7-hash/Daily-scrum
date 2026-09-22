import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { resolveDefaultCategoryId } from '../lib/masterData.js';

const router = Router();
router.use(requireAuth);

/** GET /api/main-tasks — anyone signed in can read the list, to populate the Main Task dropdown when
 *  logging work. Sits between Category and individual tasks: a Category (e.g. Finance) contains several
 *  Main Tasks (e.g. FP&A, Accounts Payable), each of which contains several actual assignable tasks. */
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT mt.*, c.name AS category_name
    FROM main_tasks mt
    LEFT JOIN categories c ON c.id = mt.category_id
    ORDER BY mt.is_active DESC, mt.name
  `).all();
  res.json({ main_tasks: rows });
}));

/** POST /api/main-tasks — Admin defines a new Main Task (Process), parked under a Category (Function).
 *  category_id is required — a Process must always belong to a Function, so History/reporting can never
 *  show a Process floating without one. Auto-resolved when not given rather than asked for, since the
 *  Admin UI no longer surfaces a Function picker when creating a Process — see resolveDefaultCategoryId. */
router.post('/', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  let { category_id } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Main Task name is required.' });
  if (!category_id) category_id = await resolveDefaultCategoryId();
  if (!category_id) return res.status(400).json({ error: 'Choose the Function this Process belongs to.' });
  const category = await db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(category_id);
  if (!category) return res.status(400).json({ error: 'That Function is no longer available. Choose another.' });
  const id = uuid();
  try {
    await db.prepare(`INSERT INTO main_tasks (id, name, category_id, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name.trim(), category_id, description || null, req.user.id, req.user.id);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A Main Task with this name already exists.' });
    throw e;
  }
  await recordAudit({ tableName: 'main_tasks', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ main_task: await db.prepare('SELECT * FROM main_tasks WHERE id = ?').get(id) });
}));

/** POST /api/main-tasks/import — bulk import from the Admin page's CSV template, same validation as
 *  the single POST / above, per-row so one bad row doesn't stop the rest. category_name is resolved to
 *  category_id the same way the other import endpoints resolve names to IDs. */
router.post('/import', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const categories = await db.prepare('SELECT id, name FROM categories').all();
  const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const seenNames = new Set();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const name = (r.name || '').trim();
      const description = (r.description || '').trim() || null;
      const categoryName = (r.category_name || '').trim();
      if (!name) throw new Error('Main Task name is required.');
      if (seenNames.has(name.toLowerCase())) throw new Error('Duplicate Main Task name within this file.');
      let category_id;
      if (categoryName) {
        category_id = categoryByName.get(categoryName.toLowerCase());
        if (!category_id) throw new Error(`Function "${categoryName}" was not found.`);
      } else {
        category_id = await resolveDefaultCategoryId();
        if (!category_id) throw new Error('category_name is required — more than one Function exists, so it can\'t be auto-picked.');
      }

      const id = uuid();
      try {
        await db.prepare(`INSERT INTO main_tasks (id, name, category_id, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, name, category_id, description, req.user.id, req.user.id);
      } catch (e) {
        if (e.code === '23505') throw new Error('A Main Task with this name already exists.');
        throw e;
      }
      seenNames.add(name.toLowerCase());
      await recordAudit({ tableName: 'main_tasks', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Bulk import' });
      results.push({ row: i + 1, success: true });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

/** PATCH /api/main-tasks/:id — rename, re-categorize, edit description, or deactivate. */
router.patch('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM main_tasks WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Main Task not found.' });
  const { name, category_id, description, is_active, reason } = req.body || {};
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Main Task name is required.' });
  if (category_id !== undefined) {
    if (!category_id) return res.status(400).json({ error: 'A Process must always belong to a Function — choose one instead of clearing it.' });
    const category = await db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(category_id);
    if (!category) return res.status(400).json({ error: 'That Function is no longer available. Choose another.' });
  }
  const after = {
    name: name !== undefined ? name.trim() : before.name,
    category_id: category_id !== undefined ? (category_id || null) : before.category_id,
    description: description !== undefined ? description : before.description,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };
  await db.prepare(`UPDATE main_tasks SET name=?, category_id=?, description=?, is_active=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(after.name, after.category_id, after.description, after.is_active, req.user.id, req.params.id);
  await auditDiff({ tableName: 'main_tasks', recordId: req.params.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason });
  res.json({ main_task: await db.prepare('SELECT * FROM main_tasks WHERE id = ?').get(req.params.id) });
}));

/** DELETE /api/main-tasks/:id — blocked for any Main Task already used by a task (deactivate instead,
 *  matching Categories/Task Types) so History never points at a Main Task that no longer exists. */
router.delete('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const mainTask = await db.prepare('SELECT * FROM main_tasks WHERE id = ?').get(req.params.id);
  if (!mainTask) return res.status(404).json({ error: 'Main Task not found.' });

  const usedCount = (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE main_task_id = ?').get(req.params.id)).c;
  const templateCount = (await db.prepare('SELECT COUNT(*) c FROM recurring_activities WHERE main_task_id = ?').get(req.params.id)).c;
  // A Process with Activities still parked under it can't be deleted either — those Activities must
  // always belong to a Process (same rule as a Process must always belong to a Function), so removing
  // the parent here would either orphan them or hit a raw foreign-key error instead of this friendly one.
  const activityCount = (await db.prepare('SELECT COUNT(*) c FROM task_activities WHERE main_task_id = ?').get(req.params.id)).c;
  if (usedCount > 0 || templateCount > 0 || activityCount > 0) {
    const parts = [
      usedCount > 0 && `${usedCount} task(s)`,
      templateCount > 0 && `${templateCount} recurring template(s)`,
      activityCount > 0 && `${activityCount} Activit${activityCount === 1 ? 'y' : 'ies'}`,
    ].filter(Boolean);
    return res.status(409).json({ error: `${parts.join(' and ')} already use this Main Task. Deactivate it instead of deleting it.` });
  }

  await recordAudit({ tableName: 'main_tasks', recordId: req.params.id, fieldName: 'deleted', oldValue: mainTask.name, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason || req.query?.reason });
  await db.prepare('DELETE FROM main_tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

export default router;
