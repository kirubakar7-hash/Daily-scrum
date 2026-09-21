import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

/** A team's "leader" is no longer a separately hand-picked field — it's figured out live from the real
 *  reporting hierarchy (users.manager_id): whichever active member of the team is the manager of the
 *  most OTHER members of that same team. A team with no internal reporting structure (e.g. a single
 *  person, or members who don't manage each other) simply has no computed leader. This intentionally
 *  ignores a member's manager outside the team — a team's leader must be someone the team can see leading
 *  it, not just whoever happens to be someone's boss elsewhere in the org. */
async function attachComputedLeaders(teams) {
  const users = await db.prepare('SELECT id, full_name, team_id, manager_id FROM users WHERE is_active = 1').all();
  const byTeam = new Map();
  for (const u of users) {
    if (!u.team_id) continue;
    if (!byTeam.has(u.team_id)) byTeam.set(u.team_id, []);
    byTeam.get(u.team_id).push(u);
  }
  return teams.map((t) => {
    const members = byTeam.get(t.id) || [];
    const memberIds = new Set(members.map((m) => m.id));
    const reportCounts = new Map();
    for (const m of members) {
      if (m.manager_id && memberIds.has(m.manager_id)) {
        reportCounts.set(m.manager_id, (reportCounts.get(m.manager_id) || 0) + 1);
      }
    }
    let leaderId = null, best = 0;
    for (const [id, count] of reportCounts) {
      if (count > best) { best = count; leaderId = id; }
    }
    const leader = leaderId ? members.find((m) => m.id === leaderId) : null;
    // leader_user_id is dropped from the response, not just left unused — the column still exists in the
    // database (no migration here), but nothing should read it as meaningful now that it's superseded by
    // this computed value, and leaving it in the API response would invite exactly that.
    const { leader_user_id, ...rest } = t;
    return { ...rest, leader_name: leader ? leader.full_name : null };
  });
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM teams ORDER BY is_active DESC, name`).all();
  res.json({ teams: await attachComputedLeaders(rows) });
}));

router.post('/', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Team name is required.' });
  if (await db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?)').get(name.trim())) {
    return res.status(400).json({ error: 'A team with that name already exists.' });
  }
  const id = uuid();
  await db.prepare(`INSERT INTO teams (id, name, created_by, updated_by) VALUES (?, ?, ?, ?)`)
    .run(id, name.trim(), req.user.id, req.user.id);
  await recordAudit({ tableName: 'teams', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ team: await db.prepare('SELECT * FROM teams WHERE id = ?').get(id) });
}));

// Bulk import from the Admin page's CSV template.
router.post('/import', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const seenNames = new Set();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const name = (r.name || '').trim();

      if (!name) throw new Error('Team name is required.');
      if (seenNames.has(name.toLowerCase())) throw new Error('Duplicate team name within this file.');
      if (await db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?)').get(name)) {
        throw new Error('A team with that name already exists.');
      }

      seenNames.add(name.toLowerCase());
      const id = uuid();
      await db.prepare(`INSERT INTO teams (id, name, created_by, updated_by) VALUES (?, ?, ?, ?)`)
        .run(id, name, req.user.id, req.user.id);
      await recordAudit({ tableName: 'teams', recordId: id, fieldName: 'created', newValue: name, changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Bulk import' });
      results.push({ row: i + 1, success: true });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

router.patch('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Team not found.' });
  const { name, is_active } = req.body || {};
  if (name !== undefined && name.trim()) {
    const dupe = await db.prepare('SELECT id FROM teams WHERE lower(name) = lower(?) AND id != ?').get(name.trim(), req.params.id);
    if (dupe) return res.status(400).json({ error: 'A team with that name already exists.' });
  }
  const after = {
    name: name !== undefined ? name.trim() : before.name,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };
  await db.prepare(`UPDATE teams SET name=?, is_active=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(after.name, after.is_active, req.user.id, req.params.id);
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
