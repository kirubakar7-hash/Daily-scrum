import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db } from '../db.js';
import { requireAuth, requireRole, ROLE_LABELS } from '../middleware/auth.js';
import { recordAudit, auditDiff } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { visibleEmployeeIds, subordinateIds } from '../lib/scope.js';

const router = Router();
router.use(requireAuth);

function sanitize(u) {
  if (!u) return u;
  const { password_hash, ...rest } = u;
  return { ...rest, role_label: ROLE_LABELS[rest.role] || rest.role };
}

/** Mirrors teams.js's assertValidLeader — a manager must be Leader/Admin/Super Admin, and can't be the
 *  person themself. */
async function assertValidManager(managerId, targetId, res) {
  if (!managerId) return true;
  if (managerId === targetId) {
    res.status(400).json({ error: "Someone can't be their own manager." });
    return false;
  }
  const manager = await db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(managerId);
  if (!manager || !['leader', 'admin', 'super_admin'].includes(manager.role)) {
    res.status(400).json({ error: 'The manager must be a Leader, Admin, or Super Admin.' });
    return false;
  }
  if (!manager.is_active) {
    res.status(400).json({ error: 'That person is deactivated and can no longer be assigned as a manager.' });
    return false;
  }
  // Reuses subordinateIds (scope.js) rather than a second hierarchy walk — if the proposed manager
  // already reports to the target, directly or indirectly, this assignment would close a reporting loop.
  if (targetId && (await subordinateIds(targetId)).includes(managerId)) {
    res.status(400).json({ error: 'This would create a reporting loop — that person already reports to this one, directly or indirectly.' });
    return false;
  }
  return true;
}

// Super Admin/Admin/Senior Management see everyone here, org-wide, same as always. A Leader only sees
// themself plus their own reporting chain (scope.js) — this feeds My Tasks' assignee picker among other
// things, so an unscoped list here would let a Leader pick someone outside their chain in the UI only to
// have the actual assignment rejected by scrum.js's assertCanEdit.
router.get('/', requireRole('super_admin', 'admin', 'leader', 'senior_management'), asyncHandler(async (req, res) => {
  let rows = await db.prepare(`
    SELECT u.*, m.full_name AS manager_name FROM users u
    LEFT JOIN users m ON m.id = u.manager_id
    ORDER BY u.is_active DESC, u.full_name
  `).all();
  if (req.user.role === 'leader') {
    const visible = new Set(await visibleEmployeeIds(req.user));
    rows = rows.filter((u) => visible.has(u.id));
  }
  res.json({ users: rows.map(sanitize) });
}));

/** GET /api/users/assignable — everyone a task can be assigned to, for every signed-in role: any active
 *  person can be given a task by anyone. Just what the "Assign to" and "Reviewer" boxes need — no team,
 *  job title or account details — since this is open to Employees too. */
router.get('/assignable', asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT id, full_name, email, role, manager_id FROM users WHERE is_active = 1 ORDER BY full_name
  `).all();
  res.json({ users: rows });
}));

router.post('/', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const { full_name, email, password, role, team_id, manager_id, job_title } = req.body || {};
  if (!full_name || !email || !password || !role) {
    return res.status(400).json({ error: 'Name, email, password, and role are required.' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!ROLE_LABELS[role]) return res.status(400).json({ error: 'Invalid role.' });
  // requireRole above lets both Admin and Super Admin reach this route — without this, an Admin could
  // mint a brand-new, unprotected Super Admin account for themselves (is_super_admin_protected only
  // guards the one designated account, not the role itself), a full privilege escalation.
  if (role === 'super_admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only a Super Admin can create another Super Admin account.' });
  }
  const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email.trim());
  if (existing) return res.status(400).json({ error: 'A user with that email already exists.' });

  const id = uuid();
  if (!(await assertValidManager(manager_id || null, id, res))) return;
  const hash = bcrypt.hashSync(password, 10);
  await db.prepare(`
    INSERT INTO users (id, full_name, email, password_hash, role, team_id, manager_id, job_title, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, full_name.trim(), email.trim(), hash, role, team_id || null, manager_id || null, job_title || null, req.user.id, req.user.id);

  await recordAudit({ tableName: 'users', recordId: id, fieldName: 'created', newValue: `${full_name} (${role})`, changedBy: req.user.id, changedByName: req.user.full_name });
  res.status(201).json({ user: sanitize(await db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
}));

// Bulk import from the Admin page's CSV template. Each row gets the exact same validation as a single
// POST / above (email format is stricter here, since a bad address in a one-off manual create is caught
// immediately by the person typing it, but a CSV row has no such feedback loop) — one bad row doesn't
// stop the rest; each row's outcome is reported back so the person can fix and re-import just the failures.
router.post('/import', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const teams = await db.prepare('SELECT id, name FROM teams').all();
  const teamByName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t.id]));
  const seenEmails = new Set();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    try {
      const full_name = (r.full_name || '').trim();
      const email = (r.email || '').trim();
      const password = r.password || '';
      const role = (r.role || '').trim();
      const teamName = (r.team_name || '').trim();
      const job_title = (r.job_title || '').trim();

      if (!full_name || !email || !password || !role) throw new Error('full_name, email, password, and role are required.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email is not a valid address.');
      if (seenEmails.has(email.toLowerCase())) throw new Error('Duplicate email within this file.');
      if (password.length < 8) throw new Error('Password must be at least 8 characters.');
      if (!ROLE_LABELS[role]) throw new Error(`Invalid role "${role}". Must be one of: ${Object.keys(ROLE_LABELS).join(', ')}.`);
      // Same privilege-escalation guard as the single-create route above — a bulk CSV import is otherwise
      // an unguarded second path for an Admin to mint themselves a Super Admin account.
      if (role === 'super_admin' && req.user.role !== 'super_admin') throw new Error('Only a Super Admin can create another Super Admin account.');
      const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
      if (existing) throw new Error('A user with that email already exists.');
      let team_id = null;
      if (teamName) {
        team_id = teamByName.get(teamName.toLowerCase());
        if (!team_id) throw new Error(`Team "${teamName}" was not found.`);
      }

      seenEmails.add(email.toLowerCase());
      const id = uuid();
      const hash = bcrypt.hashSync(password, 10);
      await db.prepare(`
        INSERT INTO users (id, full_name, email, password_hash, role, team_id, job_title, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, full_name, email, hash, role, team_id, job_title || null, req.user.id, req.user.id);
      await recordAudit({ tableName: 'users', recordId: id, fieldName: 'created', newValue: `${full_name} (${role})`, changedBy: req.user.id, changedByName: req.user.full_name, reason: 'Bulk import' });
      results.push({ row: i + 1, success: true });
    } catch (e) {
      results.push({ row: i + 1, success: false, error: e.message });
    }
  }
  res.json({ results });
}));

router.patch('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const before = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'User not found.' });

  const { full_name, email, role, team_id, manager_id, job_title, is_active, reason } = req.body || {};

  const roleChanging = role !== undefined && role !== before.role;
  const deactivating = is_active !== undefined && !is_active && before.is_active;

  if (before.is_super_admin_protected && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only a Super Admin can modify the Super Admin account.' });
  }
  if (before.is_super_admin_protected && (roleChanging || deactivating)) {
    return res.status(403).json({ error: 'The designated Super Admin account cannot be downgraded or deactivated.' });
  }
  if (req.params.id === req.user.id && (roleChanging || deactivating)) {
    return res.status(400).json({ error: "You can't deactivate or change the role of the account you're currently logged in as." });
  }
  if (roleChanging && !ROLE_LABELS[role]) return res.status(400).json({ error: 'Invalid role.' });
  // Closes the same privilege-escalation gap as POST / and POST /import: without this, an Admin could
  // PATCH any ordinary (non-protected) user's role to super_admin — the is_super_admin_protected guard
  // above only protects the one designated account, not the super_admin role in general.
  if (roleChanging && role === 'super_admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only a Super Admin can promote someone to Super Admin.' });
  }

  // Deactivating, or demoting away from a manager-capable role, someone who still has active direct
  // reports would silently orphan their accountability line — those reports' manager_id keeps pointing
  // at someone who can no longer act on their tasks or approve their requests. Mirrors the same
  // "people reporting to them" guard DELETE already has below, for this far more common offboarding path.
  const losingManagerCapability = roleChanging && !['leader', 'admin', 'super_admin'].includes(role);
  if (deactivating || losingManagerCapability) {
    const reportCount = (await db.prepare('SELECT COUNT(*) c FROM users WHERE manager_id = ? AND is_active = 1').get(req.params.id)).c;
    if (reportCount > 0) {
      return res.status(409).json({
        error: `This person still has ${reportCount} active report${reportCount === 1 ? '' : 's'}. Reassign them to another manager first.`,
      });
    }
  }
  if (manager_id !== undefined && !(await assertValidManager(manager_id, req.params.id, res))) return;

  let normalizedEmail = before.email;
  if (email !== undefined) {
    normalizedEmail = email.trim();
    if (!normalizedEmail) return res.status(400).json({ error: 'Email is required.' });
    const existing = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?').get(normalizedEmail, req.params.id);
    if (existing) return res.status(400).json({ error: 'A user with that email already exists.' });
  }

  const after = {
    full_name: full_name !== undefined ? full_name.trim() : before.full_name,
    email: normalizedEmail,
    role: role !== undefined ? role : before.role,
    team_id: team_id !== undefined ? team_id : before.team_id,
    manager_id: manager_id !== undefined ? (manager_id || null) : before.manager_id,
    job_title: job_title !== undefined ? job_title : before.job_title,
    is_active: is_active !== undefined ? (is_active ? 1 : 0) : before.is_active,
  };

  await db.prepare(`
    UPDATE users SET full_name=?, email=?, role=?, team_id=?, manager_id=?, job_title=?, is_active=?, updated_at=datetime('now'), updated_by=?
    WHERE id=?
  `).run(after.full_name, after.email, after.role, after.team_id, after.manager_id, after.job_title, after.is_active, req.user.id, req.params.id);

  await auditDiff({ tableName: 'users', recordId: req.params.id, before, after, changedBy: req.user.id, changedByName: req.user.full_name, reason });
  res.json({ user: sanitize(await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
}));

router.post('/:id/reset-password', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.is_super_admin_protected && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only a Super Admin can modify the Super Admin account.' });
  }
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const hash = bcrypt.hashSync(password, 10);
  await db.prepare(`UPDATE users SET password_hash=?, token_version=token_version+1, updated_at=datetime('now'), updated_by=? WHERE id=?`).run(hash, req.user.id, req.params.id);
  await recordAudit({ tableName: 'users', recordId: req.params.id, fieldName: 'password', oldValue: '(hidden)', newValue: '(reset)', changedBy: req.user.id, changedByName: req.user.full_name });
  res.json({ ok: true });
}));

router.delete('/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
  const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.is_super_admin_protected) {
    return res.status(403).json({ error: 'The designated Super Admin account can never be deleted.' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete the account you're currently logged in as." });
  }

  // Anything with real Scrum history must be kept — deactivate instead of deleting. Team leadership is
  // no longer a stored field (it's computed live from manager_id), so "people reporting to them" below is
  // the real, current guard — a team's computed leader is just whoever that already protects.
  const linkedCounts = {
    'people reporting to them': (await db.prepare('SELECT COUNT(*) c FROM users WHERE manager_id = ?').get(target.id)).c,
    commitments: (await db.prepare('SELECT COUNT(*) c FROM commitments WHERE employee_id = ?').get(target.id)).c,
    actions: (await db.prepare('SELECT COUNT(*) c FROM actions WHERE employee_id = ?').get(target.id)).c,
    escalations: (await db.prepare('SELECT COUNT(*) c FROM escalations WHERE employee_id = ?').get(target.id)).c,
    requests: (await db.prepare('SELECT COUNT(*) c FROM requests WHERE requested_by = ? OR resolved_by = ?').get(target.id, target.id)).c,
    'audit history': (await db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE owner_id = ?').get(target.id)).c,
    'recurring task assignments': (await db.prepare('SELECT COUNT(*) c FROM recurring_activities WHERE employee_id = ?').get(target.id)).c,
    'scrum sessions': (await db.prepare('SELECT COUNT(*) c FROM scrum_sessions WHERE employee_id = ?').get(target.id)).c,
  };
  const reasons = Object.entries(linkedCounts).filter(([, c]) => c > 0).map(([label, c]) => `${c} ${label}`);
  if (reasons.length > 0) {
    return res.status(409).json({
      error: `This person has history attached (${reasons.join(', ')}) that must be preserved. Deactivate the account instead of deleting it.`,
    });
  }

  // Same reasoning as scrum.js's commitment-delete route: these are three separate round trips to a
  // remote Postgres connection, not one local write — without a transaction, a dropped connection or
  // timeout partway through could leave the audit log saying "deleted" while the user row (or a child
  // row) still exists.
  await db.transaction(async () => {
    await recordAudit({ tableName: 'users', recordId: target.id, fieldName: 'deleted', oldValue: `${target.full_name} (${target.email})`, changedBy: req.user.id, changedByName: req.user.full_name, reason: req.body?.reason || req.query?.reason });
    await db.prepare('DELETE FROM recurring_activities WHERE employee_id = ?').run(target.id);
    await db.prepare('DELETE FROM scrum_sessions WHERE employee_id = ?').run(target.id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  });
  res.json({ ok: true });
}));

export const ROLES = ROLE_LABELS;
export default router;
