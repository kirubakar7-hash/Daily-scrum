/** A real calendar date as YYYY-MM-DD, within a sane range for task dates. Dates are stored as text, so
 *  without this a half-typed value from a date box (e.g. "0002-09-25" while the year is still being
 *  typed) or an impossible one ("2026-02-31") would be saved as-is and quietly break every "overdue"
 *  calculation for that task. */
export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const INVALID_DATE_MESSAGE = 'Please choose a real date (for example 30 Sep 2026).';
