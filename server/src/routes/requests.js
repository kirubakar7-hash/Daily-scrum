import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

function employeeName(id) {
  return db.prepare('SELECT full_name FROM users WHERE id = ?').get(id)?.full_name || null;
}

/** GET /api/requests — the Requests inbox. Defaults to pending only; ?status= to see others. Read-only
 *  for senior_management too, matching the universal-visibility rule the rest of the app follows —
 *  approve/reject below stay leader-tier only. LEFT JOINs so a request whose commitment was somehow
 *  removed (legacy data from before deletes started auto-resolving pending requests) still shows up
 *  instead of silently vanishing from every listing. */
router.get('/', requireRole('leader', 'admin', 'super_admin', 'senior_management'), (req, res) => {
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT r.*, c.description, c.due_date, c.status AS commitment_status,
      u.full_name AS requested_by_name, e.id AS employee_id, e.full_name AS employee_name
    FROM requests r
    LEFT JOIN commitments c ON c.id = r.commitment_id
    JOIN users u ON u.id = r.requested_by
    LEFT JOIN users e ON e.id = c.employee_id
    WHERE r.status = ?
    ORDER BY r.created_at DESC
  `).all(status);
  res.json({ requests: rows });
});

// Approve/reject stay leader-tier only — this is where the inbox stops being read-only.
router.use(requireRole('leader', 'admin', 'super_admin'));

/** POST /api/requests/:id/approve — apply the requested change and resolve the request. */
router.post('/:id/approve', (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been resolved.' });

  const commitment = db.prepare('SELECT * FROM commitments WHERE id = ?').get(request.commitment_id);
  if (!commitment) return res.status(404).json({ error: 'The task this request belongs to no longer exists.' });
  const leaderNote = req.body?.leader_note || null;
  const ownerId = commitment.employee_id;
  const ownerName = employeeName(ownerId);

  if (request.type === 'due_date_change') {
    // Deliberately leaves status untouched (unlike the Leader's direct carry-forward action) — this task
    // could simultaneously have its own pending Support request, and silently clearing that by resetting
    // status here would resolve something this approval was never about. Approving a date change changes
    // only the date.
    db.prepare(`UPDATE commitments SET due_date=?, updated_at=datetime('now'), updated_by=? WHERE id=?`)
      .run(request.requested_due_date, req.user.id, commitment.id);
    recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'carried_forward',
      oldValue: commitment.due_date, newValue: request.requested_due_date,
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId, ownerName,
    });
  } else {
    db.prepare(`UPDATE commitments SET status='in_progress', updated_at=datetime('now'), updated_by=? WHERE id=?`).run(req.user.id, commitment.id);
    recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'status',
      oldValue: commitment.status, newValue: 'in_progress',
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId, ownerName,
    });
  }

  db.prepare(`UPDATE requests SET status='approved', resolved_by=?, resolved_at=datetime('now'), leader_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, leaderNote, request.id);

  res.json({
    request: db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id),
    commitment: db.prepare('SELECT * FROM commitments WHERE id = ?').get(commitment.id),
  });
});

/** POST /api/requests/:id/reject — resolve without applying the change. A rejected Support request still
 *  returns the task to In Progress (per the state diagram, this is still a "Leader Action"), so the
 *  employee isn't left stuck; a rejected due-date change leaves the due date untouched. */
router.post('/:id/reject', (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'This request has already been resolved.' });

  const commitment = db.prepare('SELECT * FROM commitments WHERE id = ?').get(request.commitment_id);
  const leaderNote = req.body?.leader_note || null;

  if (commitment && request.type === 'support') {
    const ownerId = commitment.employee_id;
    db.prepare(`UPDATE commitments SET status='in_progress', updated_at=datetime('now'), updated_by=? WHERE id=?`).run(req.user.id, commitment.id);
    recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'status',
      oldValue: commitment.status, newValue: 'in_progress',
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId, ownerName: employeeName(ownerId),
    });
  } else if (commitment && request.type === 'due_date_change') {
    // The commitment itself doesn't change on a rejection, but the decision still needs a trace — every
    // other outcome in this flow (both approvals, and support rejections) is audited; this was the one
    // silent exception.
    recordAudit({
      tableName: 'commitments', recordId: commitment.id, fieldName: 'due_date_change_rejected',
      oldValue: commitment.due_date, newValue: request.requested_due_date,
      changedBy: req.user.id, changedByName: req.user.full_name, reason: leaderNote,
      ownerId: commitment.employee_id, ownerName: employeeName(commitment.employee_id),
    });
  }

  db.prepare(`UPDATE requests SET status='rejected', resolved_by=?, resolved_at=datetime('now'), leader_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, leaderNote, request.id);

  res.json({
    request: db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id),
    commitment: commitment ? db.prepare('SELECT * FROM commitments WHERE id = ?').get(commitment.id) : null,
  });
});

export default router;
