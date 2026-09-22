import { db } from '../db.js';

/** Resolves category_id (Function) when the caller doesn't specify one. The UI no longer asks anyone to
 *  pick a Function on every Process/task — the org has exactly one ("Finance") today, so making everyone
 *  choose it every time was pure friction. Auto-picks it when there's unambiguously one active Function;
 *  returns null otherwise so the caller's own required-field check still fires if a second Function is
 *  ever added and picking one becomes a real decision again. */
export async function resolveDefaultCategoryId() {
  const rows = await db.prepare('SELECT id FROM categories WHERE is_active = 1').all();
  return rows.length === 1 ? rows[0].id : null;
}
