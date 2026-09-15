import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

/** GET /api/task-types — anyone signed in can read the list, to populate the Type dropdown when logging work. */
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM task_types ORDER BY is_active DESC, mechanic, name').all();
  res.json({ task_types: rows });
});

/** POST /api/task-types — Admin defines a new named type, tagged as either Recurring or Ad-hoc underneath. */
router.post('/', requireRole('super_admin', 'admin'), (req, res) => {
  const { name, mechanic } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Type name is required.' });
  if (!['recurring', 'adhoc'].includes(mechanic)) {
    return res.status(400).json({ error: 'Choose whether this type repeats (Recurring) or happens once (Ad-hoc).' });
  }
  const id = uuid();
  try {
    db.prepare(`INSERT INTO task_types (id, name, mechanic, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`)
      .run(id, name.trim(), mechanic, req.user.id, req.user.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'A type with this name already exists.' });
    throw e;
  }
  recordAudit({ tableName: 'task_types', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ task_type: db.prepare('SELECT * FROM task_types WHERE id = ?').get(id) });
});

/** PATCH /api/task-types/:id — rename or deactivate. Mechanic can't change once set — that would silently
 *  reclassify every past task logged under this type, which is a bigger call than a rename. */
router.patch('/:id', requireRole('super_admin', 'admin'), (req, res) => {
  const before = db.prepare('SELECT * FROM task_types WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Type not found.' });
  const { name, is_active } = req.body || {};
  if (before.is_protected && is_active === false) {
    return res.status(403).json({ error: `"${before.name}" is a built-in type the app relies on and can't be deactivated.` });
  }
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: 'Type name is required.' });
  const after = {
    name: name !== undefined ? name.trim() : before.name,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };
  db.prepare(`UPDATE task_types SET name=?, is_active=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(after.name, after.is_active, req.user.id, req.params.id);
  auditDiff({ tableName: 'task_types', recordId: req.params.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name });
  res.json({ task_type: db.prepare('SELECT * FROM task_types WHERE id = ?').get(req.params.id) });
});

/** DELETE /api/task-types/:id — blocked for the two built-in types, and for any type already used by a task
 *  (deactivate instead, matching Users/Teams) so history never points at a type that no longer exists. */
router.delete('/:id', requireRole('super_admin', 'admin'), (req, res) => {
  const type = db.prepare('SELECT * FROM task_types WHERE id = ?').get(req.params.id);
  if (!type) return res.status(404).json({ error: 'Type not found.' });
  if (type.is_protected) return res.status(403).json({ error: `"${type.name}" is a built-in type the app relies on and can't be deleted.` });

  const usedCount = db.prepare('SELECT COUNT(*) c FROM commitments WHERE task_type_id = ?').get(req.params.id).c;
  const templateCount = db.prepare('SELECT COUNT(*) c FROM recurring_activities WHERE task_type_id = ?').get(req.params.id).c;
  if (usedCount > 0 || templateCount > 0) {
    const parts = [usedCount > 0 && `${usedCount} task(s)`, templateCount > 0 && `${templateCount} recurring template(s)`].filter(Boolean);
    return res.status(409).json({ error: `${parts.join(' and ')} already use this type. Deactivate it instead of deleting it.` });
  }

  recordAudit({ tableName: 'task_types', recordId: req.params.id, fieldName: 'deleted', oldValue: type.name, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason || req.query?.reason });
  db.prepare('DELETE FROM task_types WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
