import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

async function assertValidLeader(leaderUserId, res) {
  if (!leaderUserId) return true;
  const leader = await db.prepare('SELECT role FROM users WHERE id = ?').get(leaderUserId);
  if (!leader || !['leader', 'admin', 'super_admin'].includes(leader.role)) {
    res.status(400).json({ error: 'The team leader must be a Leader, Admin, or Super Admin.' });
    return false;
  }
  return true;
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT t.*, u.full_name AS leader_name
    FROM teams t
    LEFT JOIN users u ON u.id = t.leader_user_id
    ORDER BY t.is_active DESC, t.name
  `).all();
  res.json({ teams: rows });
}));

router.post('/', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const { name, leader_user_id } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name is required.' });
  if (await db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?)').get(name.trim())) {
    return res.status(400).json({ error: 'A team with that name already exists.' });
  }
  if (!(await assertValidLeader(leader_user_id, res))) return;
  const id = uuid();
  await db.prepare(`INSERT INTO teams (id, name, leader_user_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name.trim(), leader_user_id || null, req.user.id, req.user.id);
  await recordAudit({ tableName: 'teams', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ team: await db.prepare('SELECT * FROM teams WHERE id = ?').get(id) });
}));

router.patch('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Team not found.' });
  const { name, leader_user_id, is_active } = req.body || {};
  if (name !== undefined && name.trim()) {
    const dupe = await db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?) AND id != ?').get(name.trim(), req.params.id);
    if (dupe) return res.status(400).json({ error: 'A team with that name already exists.' });
  }
  if (leader_user_id !== undefined && !(await assertValidLeader(leader_user_id, res))) return;
  const after = {
    name: name !== undefined ? name.trim() : before.name,
    leader_user_id: leader_user_id !== undefined ? leader_user_id : before.leader_user_id,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };
  await db.prepare(`UPDATE teams SET name=?, leader_user_id=?, is_active=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(after.name, after.leader_user_id, after.is_active, req.user.id, req.params.id);
  await auditDiff({ tableName: 'teams', recordId: req.params.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason });
  res.json({ team: await db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id) });
}));

router.delete('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const team = await db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });

  const memberCount = (await db.prepare('SELECT COUNT(*) c FROM users WHERE team_id = ?').get(req.params.id)).c;
  if (memberCount > 0) {
    return res.status(409).json({
      error: `This team still has ${memberCount} member(s) assigned. Move them to another team first, or deactivate this team instead of deleting it.`,
    });
  }

  await recordAudit({ tableName: 'teams', recordId: req.params.id, fieldName: 'deleted', oldValue: team.name, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason || req.query?.reason });
  await db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

export default router;
