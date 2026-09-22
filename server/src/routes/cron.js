import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { asyncHandler } from '../lib/asyncHandler.js';
import { generateDueOccurrences } from '../lib/recurringOccurrences.js';

const router = Router();

/** Vercel Cron's request never carries a user session — there's no employee/leader logged in to check
 *  a role against — so this checks a standing shared secret instead of the usual requireAuth/requireRole
 *  pair. Vercel sends this exact "Authorization: Bearer <CRON_SECRET>" header automatically on every
 *  cron-triggered request once CRON_SECRET is set as a real environment variable (see .env.example) —
 *  fails closed (401) when it's unset or doesn't match, rather than leaving this route wide open to
 *  anyone who guesses the URL. timingSafeEqual (not `!==`) so a byte-by-byte remote guess can't use
 *  response timing to narrow down the secret. */
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.authorization || '';
  const expected = secret ? `Bearer ${secret}` : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const matches = secret && a.length === b.length && timingSafeEqual(a, b);
  if (!matches) return res.status(401).json({ error: 'Not authorized.' });
  next();
}

/** GET /api/cron/generate-recurring — runs once a day (see the "crons" entry in vercel.json). Catches up
 *  any recurring series that fell behind because nobody completed its last occurrence, so a series
 *  advances on its own schedule instead of stalling until someone happens to act on it. */
router.get('/generate-recurring', requireCronSecret, asyncHandler(async (req, res) => {
  const result = await generateDueOccurrences();
  res.json({ ok: true, ...result });
}));

export default router;
