import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const DEV_DEFAULT_SECRET = 'dev-secret-change-me-daily-scrum-monitoring';
const JWT_SECRET = process.env.JWT_SECRET || DEV_DEFAULT_SECRET;

// Anyone who knows this placeholder could forge a login for any account — refuse to start a real
// deployment without a real secret configured, rather than silently running insecurely.
if (process.env.NODE_ENV === 'production' && JWT_SECRET === DEV_DEFAULT_SECRET) {
  console.error('Refusing to start: set a real JWT_SECRET environment variable before running in production.');
  process.exit(1);
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, tokenVersion: user.token_version }, JWT_SECRET, { expiresIn: '12h' });
}

export const requireAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Account not found or deactivated.' });
    // A password reset bumps token_version, so a token signed against an older version is rejected here
    // immediately — even though it's still cryptographically valid for the rest of its 12h life —
    // otherwise "reset the password" doesn't actually close a suspected-compromised session.
    if (payload.tokenVersion !== user.token_version) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
});

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this.' });
    }
    next();
  };
}

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  leader: 'Leader',
  employee: 'Employee',
  senior_management: 'Senior Management',
};
