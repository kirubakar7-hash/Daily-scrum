import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { visibleEmployeeIds, canActOnEmployee } from '../lib/scope.js';

const router = Router();
router.use(requireAuth);

async function employeeName(id) {
  return (await db.prepare('SELECT full_name FROM users WHERE id = ?').get(id))?.full_name || null;
}

/** GET /api/requests — the Requests inbox. Defaults to pending only; ?status= to see others. Read-only
 *  for senior_management too. Super Admin/Admin/Senior Management stay org-wide; a Leader only sees
 *  requests belonging to their own reporting chain (scope.js). LEFT JOINs so a request whose commitment
 *  was somehow removed (legacy data from before deletes started auto-resolving pending requests) still
 *  shows up instead of silently vanishing from every listing — those orphaned rows have no owner to scope
 *  against, so they're only visible to the wide-open roles. */
router.get('/', requireRole('leader', 'admin', 'super_admin', 'senior_management'), asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const wideOpen = ['super_admin', 'admin', 'senior_management'].includes(req.user.role);
  const params = [status];
  let scopeClause = '';
  if (!wideOpen) {
    const ids = await visibleEmployeeIds(req.user);
    scopeClause = ` AND e.id IN (${ids.length ? ids.map(() => '?').join(',') : "'__none__'"})`;
    params.push(...ids);
  }
  const rows = await db.prepare(`
    SELECT r.*, c.description, c.due_date, c.status AS commitment_status,
      u.full_name AS requested_by_name, e.id AS employee_id, e.full_name AS employee_name
    FROM requests r
    LEFT JOIN commitments c ON c.id = r.commitment_id
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN users e ON e.id = c.employee_id
    WHERE r.status = ?${scopeClause}
    ORDER BY r.created_at DESC
  `).all(...params);
  res.json({ requests: rows });
}));

// Approve/reject stay leader-tier only — this is where the inbox stops being read-only.
router.use(requireRole('leader', 'admin', 'super_admin'));

/** POST /api/requests/:id/approve — apply the requested change and resolve the request. */
router.post('/:id/approve', asyncHandler(async (req, res) => {
  const request = await db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been resolved.' });

  const commitment = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(request.commitment_id);
  if (!commitment) return res.status(404).json({ error: 'The task this request belongs to no longer exists.' });
  if (req.user.role === 'leader' && !(await canActOnEmployee(req.user, commitment.employee_id))) {
    return res.status(403).json({ error: 'You can only act on requests for people who report to you.' });
  }
  const leaderNote = req.body?.leader_note || null;
  const ownerId = commitment.employee_id;
  const ownerName = await employeeName(ownerId);

  if (request.type === 'due_date_change') {
    // Deliberately leaves status untouched (unlike the Leader's direct carry-forward action) — this task
    // could simultaneously have its own pending Support request, and silently clearing that by resetting
    // status here would resolve something this approval was never about. Approving a date change changes
    // only the date.
    await db.prepare(`UPDATE commitments SET due_date=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
      .run(request.requested_due_date, req.user.id, commitment.id);
    await recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'carried_forward',
      oldValue: commitment.due_date, newValue: request.requested_due_date,
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId, ownerName,
    });
  } else {
    await db.prepare(`UPDATE commitments SET status='in_progress', updated_at=datetime('now'), updated_by=? WHERE id=?`).run(req.user.id, commitment.id);
    // A distinct fieldName from reject's below — both used to write the identical {fieldName:'status',
    // oldValue: status, newValue:'in_progress'} entry, making an approved Support request indistinguishable
    // from a rejected one in the task's own History drawer. The original ask (what they actually needed
    // help with) is folded into newValue here too, since it's still on the commitment at this point but
    // isn't guaranteed to stay there — this keeps the record self-contained either way.
    await recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'support_request_approved',
      oldValue: commitment.non_completion_reason || null,
      newValue: leaderNote || commitment.non_completion_explanation || 'Approved',
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId, ownerName,
    });
  }

  await db.prepare(`UPDATE requests SET status='approved', resolved_by=?, resolved_at=datetime('now'), leader_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, leaderNote, request.id);

  res.json({
    request: await db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id),
    commitment: await db.prepare('SELECT * FROM commitments WHERE id = ?').get(commitment.id),
  });
}));

/** POST /api/requests/:id/reject — resolve without applying the change. A rejected Support request still
 *  returns the task to In Progress (per the state diagram, this is still a "Leader Action"), so the
 *  employee isn't left stuck; a rejected due-date change leaves the due date untouched. */
router.post('/:id/reject', asyncHandler(async (req, res) => {
  const request = await db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been resolved.' });

  const commitment = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(request.commitment_id);
  if (req.user.role === 'leader') {
    // No commitment (orphaned legacy request) means no owner to check a Leader's scope against — only
    // Admin/Super Admin can resolve those.
    if (!commitment) return res.status(403).json({ error: 'You can only act on requests for people who report to you.' });
    if (!(await canActOnEmployee(req.user, commitment.employee_id))) {
      return res.status(403).json({ error: 'You can only act on requests for people who report to you.' });
    }
  }
  const leaderNote = req.body?.leader_note || null;

  if (commitment && request.type === 'support') {
    const ownerId = commitment.employee_id;
    await db.prepare(`UPDATE commitments SET status='in_progress', updated_at=datetime('now'), updated_by=? WHERE id=?`).run(req.user.id, commitment.id);
    // See the matching comment on the approve handler above — 'support_request_rejected' keeps this
    // outcome distinguishable from an approval in the task's History drawer, instead of both writing the
    // same {fieldName:'status', ..., newValue:'in_progress'} entry.
    await recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'support_request_rejected',
      oldValue: commitment.non_completion_reason || null,
      newValue: leaderNote || 'Rejected — returned to In Progress',
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId, ownerName: await employeeName(ownerId),
    });
  } else if (commitment && request.type === 'due_date_change') {
    // The commitment itself doesn't change on a rejection, but the decision still needs a trace — every
    // other outcome in this flow (both approvals, and support rejections) is audited; this was the one
    // silent exception.
    await recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'due_date_change_rejected',
      oldValue: commitment.due_date, newValue: request.requested_due_date,
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId: commitment.employee_id, ownerName: await employeeName(commitment.employee_id),
    });
  } else if (!commitment) {
    // Orphaned request — its task was deleted after the request was raised, so there's nothing left to
    // apply or return to In Progress. Only Admin/Super Admin ever reach this branch (a Leader already got
    // a 403 above), but the resolution itself still needs a trace, same as every other outcome here —
    // this was previously the one silent exception.
    await recordAudit({
      tableName: 'requests', recordId: request.id, fieldName: 'resolved',
      oldValue: null, newValue: `Dismissed — the task this ${request.type === 'support' ? 'support' : 'due-date-change'} request was about no longer exists`,
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
    });
  }

  await db.prepare(`UPDATE requests SET status='rejected', resolved_by=?, resolved_at=datetime('now'), leader_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, leaderNote, request.id);

  res.json({
    request: await db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id),
    commitment: commitment ? await db.prepare('SELECT * FROM commitments WHERE id = ?').get(commitment.id) : null,
  });
}));

export default router;
