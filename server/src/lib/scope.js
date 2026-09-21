import { db } from '../db.js';

// Super Admin, Admin, and Senior Management stay org-wide — only Leader and Employee are boxed into
// their own branch of the manager_id hierarchy below.
const WIDE_OPEN_ROLES = ['super_admin', 'admin', 'senior_management'];

/** Everyone recursively reporting to `managerId` (direct and indirect), excluding `managerId` itself.
 *  UNION (not UNION ALL) so a bad manager_id cycle can't loop forever — it just stops producing new rows
 *  once every reachable id has already been seen. */
export async function subordinateIds(managerId) {
  const rows = await db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM users WHERE manager_id = ?
      UNION
      SELECT u.id FROM users u JOIN sub s ON u.manager_id = s.id
    )
    SELECT id FROM sub
  `).all(managerId);
  return rows.map((r) => r.id);
}

/** Returns the list of user ids `user` is allowed to VIEW scrum data for. Wide-open roles see everyone,
 *  same as always. A Leader sees themself plus everyone reporting to them, at any depth. An Employee
 *  sees only themself. */
export async function visibleEmployeeIds(user) {
  if (WIDE_OPEN_ROLES.includes(user.role)) {
    return (await db.prepare('SELECT id FROM users').all()).map((r) => r.id);
  }
  if (user.role === 'leader') {
    return [user.id, ...(await subordinateIds(user.id))];
  }
  return [user.id]; // employee
}

export async function canViewEmployee(user, employeeId) {
  if (user.id === employeeId) return true;
  return (await visibleEmployeeIds(user)).includes(employeeId);
}

/** Returns whether `user` may CREATE/EDIT/change-status-on a task belonging to `employeeId` — the
 *  narrow counterpart to the view check above. Anyone can act on their own task. Super Admin and Admin
 *  can act on anyone's, org-wide. A Leader can only act on their own reporting chain (any depth) — not
 *  org-wide anymore. An Employee (and Senior Management, via isReadOnly below) can never act on someone
 *  else's task. */
export async function canActOnEmployee(user, employeeId) {
  if (user.id === employeeId) return true;
  // A deactivated target is off-limits to everyone but themself — the frontend picker already hides
  // deactivated people, but that's cosmetic; this is the actual backend guarantee.
  const target = await db.prepare('SELECT is_active FROM users WHERE id = ?').get(employeeId);
  if (!target || !target.is_active) return false;
  if (['super_admin', 'admin'].includes(user.role)) return true;
  if (user.role === 'leader') return (await subordinateIds(user.id)).includes(employeeId);
  return false;
}

export function isReadOnly(user) {
  return user.role === 'senior_management';
}
