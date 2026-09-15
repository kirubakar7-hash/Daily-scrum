import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('super_admin', 'admin'), (req, res) => {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (req.query.table_name) { sql += ' AND table_name = ?'; params.push(req.query.table_name); }
  if (req.query.record_id) { sql += ' AND record_id = ?'; params.push(req.query.record_id); }
  sql += ' ORDER BY changed_at DESC LIMIT 300';
  res.json({ logs: db.prepare(sql).all(...params) });
});

export default router;
