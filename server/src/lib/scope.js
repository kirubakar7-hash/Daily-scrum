import { db } from '../db.js';

/** Returns the list of user ids `user` is allowed to VIEW scrum data for — everyone, for every role.
 *  This is deliberately universal (see canActOnEmployee below for the separate, narrower EDIT check) —
 *  the org's rule is "everyone sees everyone's tasks and history; only a Leader can act on someone
 *  else's task." */
export function visibleEmployeeIds(_user) {
  return db.prepare('SELECT id FROM users').all().map((r) => r.id);
}

export function canViewEmployee(user, employeeId) {
  if (user.id === employeeId) return true;
  return visibleEmployeeIds(user).includes(employeeId);
}

/** Returns whether `user` may CREATE/EDIT/change-status-on a task belonging to `employeeId` — the
 *  narrow counterpart to the universal view above. Anyone can act on their own task; only a Leader-tier
 *  role can act on someone else's, and (per the org's flat structure) that power is org-wide, not
 *  limited to a Leader's own team. */
export function canActOnEmployee(user, employeeId) {
  if (user.id === employeeId) return true;
  return ['leader', 'admin', 'super_admin'].includes(user.role);
}

export function isReadOnly(user) {
  return user.role === 'senior_management';
}
