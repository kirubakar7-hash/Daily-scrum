import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

/** GET /api/categories — anyone signed in can read the list, to populate the Category dropdown when logging work. */
router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM categories ORDER BY is_active DESC, name').all();
  res.json({ categories: rows });
}));

/** POST /api/categories — Admin defines a new business category (e.g. Finance, Compliance). */
router.post('/', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Subtask name is required.' });
  const id = uuid();
  try {
    await db.prepare(`INSERT INTO categories (id, name, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name.trim(), description || null, req.user.id, req.user.id);
  } catch (e) {
    // Postgres's unique_violation code (23505) — see the identical comment in taskTypes.js's POST / for
    // why this can't check e.message for 'UNIQUE' anymore (that was SQLite's error text).
    if (e.code === '23505') return res.status(409).json({ error: 'A subtask with this name already exists.' });
    throw e;
  }
  await recordAudit({ tableName: 'categories', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ category: await db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
}));

/** POST /api/categories/import — bulk import from the Admin page's CSV template, same validation as
 *  the single POST / above, per-row so one bad row doesn't stop the rest. */
router.post('/import', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const seenNames = new Set();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const name = (r.name || '').trim();
      const description = (r.description || '').trim() || null;
      if (!name) throw new Error('Subtask name is required.');
      if (seenNames.has(name.toLowerCase())) throw new Error('Duplicate subtask name within this file.');

      const id = uuid();
      try {
        await db.prepare(`INSERT INTO categories (id, name, description, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`)
          .run(id, name, description, req.user.id, req.user.id);
      } catch (e) {
        if (e.code === '23505') throw new Error('A subtask with this name already exists.');
        throw e;
      }
      seenNames.add(name.toLowerCase());
      await recordAudit({ tableName: 'categories', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Bulk import' });
      results.push({ row: i + 1, success: true });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

/** PATCH /api/categories/:id — rename, edit description, or deactivate. */
router.patch('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Subtask not found.' });
  const { name, description, is_active, reason } = req.body || {};
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Subtask name is required.' });
  const after = {
    name: name !== undefined ? name.trim() : before.name,
    description: description !== undefined ? description : before.description,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };
  await db.prepare(`UPDATE categories SET name=?, description=?, is_active=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(after.name, after.description, after.is_active, req.user.id, req.params.id);
  await auditDiff({ tableName: 'categories', recordId: req.params.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason });
  res.json({ category: await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id) });
}));

/** DELETE /api/categories/:id — blocked for any category already used by a task (deactivate instead, matching
 *  Users/Teams/Task Types) so History never points at a category that no longer exists. */
router.delete('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const category = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).json({ error: 'Subtask not found.' });

  const usedCount = (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE category_id = ?').get(req.params.id)).c;
  const templateCount = (await db.prepare('SELECT COUNT(*) c FROM recurring_activities WHERE category_id = ?').get(req.params.id)).c;
  if (usedCount > 0 || templateCount > 0) {
    const parts = [usedCount > 0 && `${usedCount} task(s)`, templateCount > 0 && `${templateCount} recurring template(s)`].filter(Boolean);
    return res.status(409).json({ error: `${parts.join(' and ')} already use this subtask. Deactivate it instead of deleting it.` });
  }

  await recordAudit({ tableName: 'categories', recordId: req.params.id, fieldName: 'deleted', oldValue: category.name, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason || req.query?.reason });
  await db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

export default router;
