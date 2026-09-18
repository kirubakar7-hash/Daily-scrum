import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { visibleEmployeeIds } from '../lib/scope.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ commitments: [], actions: [] });
  const ids = await visibleEmployeeIds(req.user);
  if (ids.length === 0) return res.json({ commitments: [], actions: [] });
  const clause = ids.map(() => '?').join(',');
  const like = `%${q}%`;

  const commitmentMatches = `
    c.description LIKE ? OR c.dependency LIKE ? OR c.non_completion_reason LIKE ?
    OR c.remarks LIKE ? OR c.non_completion_explanation LIKE ? OR c.expected_outcome LIKE ?
  `;
  const commitmentLikes = [like, like, like, like, like, like];
  const commitmentTotal = (await db.prepare(`
    SELECT COUNT(*) c FROM commitments c WHERE c.employee_id IN (${clause}) AND (${commitmentMatches})
  `).get(...ids, ...commitmentLikes)).c;
  const commitments = await db.prepare(`
    SELECT c.*, u.full_name FROM commitments c JOIN users u ON u.id = c.employee_id
    WHERE c.employee_id IN (${clause}) AND (${commitmentMatches})
    ORDER BY c.scrum_date DESC LIMIT 50
  `).all(...ids, ...commitmentLikes);

  const actionTotal = (await db.prepare(`
    SELECT COUNT(*) c FROM actions a WHERE a.employee_id IN (${clause}) AND (a.description LIKE ? OR a.owner LIKE ?)
  `).get(...ids, like, like)).c;
  const actions = await db.prepare(`
    SELECT a.*, u.full_name FROM actions a JOIN users u ON u.id = a.employee_id
    WHERE a.employee_id IN (${clause}) AND (a.description LIKE ? OR a.owner LIKE ?)
    ORDER BY a.scrum_date DESC LIMIT 50
  `).all(...ids, like, like);

  res.json({
    commitments, actions,
    commitments_truncated: commitmentTotal > commitments.length,
    actions_truncated: actionTotal > actions.length,
  });
}));

export default router;
