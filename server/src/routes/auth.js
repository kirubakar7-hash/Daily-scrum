import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { signToken, requireAuth, ROLE_LABELS } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

// A simple in-memory sliding-window lockout — no external dependency needed at this app's scale (a
// handful of real accounts, one process). Keyed by email so a lockout can't be used to deny a real
// account service just by guessing its address from a different IP; resets on server restart, which is
// an acceptable trade-off for a small internal tool.
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function tooManyAttempts(email) {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry) return false;
  const recent = entry.filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(email, recent);
  return recent.length >= LOGIN_MAX_ATTEMPTS;
}
function recordFailedAttempt(email) {
  const entry = loginAttempts.get(email) || [];
  entry.push(Date.now());
  loginAttempts.set(email, entry);
}

// A fixed, valid bcrypt hash (same cost factor as every real password hash below) with no real password
// behind it — comparing against this when no active user was found costs roughly the same CPU time as
// comparing against a real hash. Without this, "no such account" returns fast (a lookup only) while
// "wrong password on a real account" returns measurably slower (lookup + bcrypt), even though both return
// the identical error message — a timing side-channel an attacker could use to enumerate valid emails.
const DUMMY_HASH = bcrypt.hashSync('no-real-password-is-ever-compared-against-this-hash', 10);

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const normalizedEmail = email.trim().toLowerCase();

  if (tooManyAttempts(normalizedEmail)) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email.trim());
  const validUser = user && user.is_active;
  // Always run exactly one bcrypt compare, win or lose, so a non-existent/inactive email and a wrong
  // password on a real account take the same amount of time to respond (see DUMMY_HASH above).
  const ok = bcrypt.compareSync(password, validUser ? user.password_hash : DUMMY_HASH);
  if (!validUser || !ok) {
    recordFailedAttempt(normalizedEmail);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  loginAttempts.delete(normalizedEmail);

  const token = signToken(user);
  res.json({ token, user: sanitize(user) });
}));

router.get('/me', requireAuth, asyncHandler((req, res) => {
  res.json({ user: sanitize(req.user) });
}));

// Self-service — every role can change their own password (unlike /users/:id/reset-password, which is
// an admin forcing a reset on someone else and never asks for the old password). Requires the current
// password so a session left open on a shared device can't be used to silently take over the account.
router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  if (!bcrypt.compareSync(current_password, req.user.password_hash)) {
    // 400, not 401 — this app's frontend treats ANY 401 as "your session is invalid" and force-logs-out
    // globally (api.js). A wrong current password is a validation failure on an otherwise-valid,
    // already-authenticated session, not an auth failure — it must not nuke a valid session.
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await db.prepare(`UPDATE users SET password_hash=?, token_version=token_version+1, updated_at=datetime('now'), updated_by=? WHERE id=?`)
    .run(hash, req.user.id, req.user.id);
  await recordAudit({ tableName: 'users', recordId: req.user.id, fieldName: 'password', oldValue: '(hidden)', newValue: '(changed by self)', changedBy: req.user.id, changedByName: req.user.full_name });
  res.json({ ok: true });
}));

function sanitize(user) {
  const { password_hash, ...rest } = user;
  return { ...rest, role_label: ROLE_LABELS[rest.role] || rest.role };
}

export default router;
