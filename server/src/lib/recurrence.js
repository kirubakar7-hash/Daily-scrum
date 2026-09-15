// Calendar-style recurrence, similar to a Teams/Outlook meeting series:
//   { interval: 2, unit: 'week', weekdays: [1,3], end: { type: 'on_date', date: '2026-12-31' } }
//   = "repeat every 2 weeks on Mon & Wed, until 2026-12-31"
//
// unit: 'day' | 'week' | 'month'. weekdays (unit='week' only): ISO weekday numbers, 1=Mon..7=Sun —
// omit/empty to repeat on the same weekday as the series start, every `interval` weeks.
// end.type: 'never' | 'on_date' (end.date) | 'after_count' (end.count, total occurrences in the series).

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// All date math here works in UTC calendar days, matching db.js's today() (new Date().toISOString().slice(0,10)).
// Parsing/formatting through local time (e.g. `new Date(str).toISOString()`) would silently shift the date
// by a day in any timezone with a non-zero UTC offset — so every step below stays on the UTC clock.
function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

function addMonthsClamped(dateStr, months) {
  const d = parseDate(dateStr);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // rolled into the month after — clamp back to the last day of the intended month
  return formatDate(d);
}

/** ISO weekday: 1=Mon..7=Sun (JS's own getUTCDay() is 0=Sun..6=Sat, which is awkward to sort/compare). */
function isoWeekday(dateStr) {
  const dow = parseDate(dateStr).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function startOfWeek(dateStr) {
  return addDays(dateStr, -(isoWeekday(dateStr) - 1));
}

/** Old fixed-choice frequency strings, for recurring_activities rows created before the recurrence picker existed. */
export function legacyFrequencyToRule(frequency) {
  if (frequency === 'Weekdays') return { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5], end: { type: 'never' } };
  if (frequency === 'Weekly') return { interval: 1, unit: 'week', weekdays: [], end: { type: 'never' } };
  if (frequency === 'Monthly') return { interval: 1, unit: 'month', end: { type: 'never' } };
  return { interval: 1, unit: 'day', end: { type: 'never' } }; // 'Daily' and any unrecognized value
}

export function parseRule(activity) {
  if (activity.recurrence_rule) {
    try {
      return JSON.parse(activity.recurrence_rule);
    } catch {
      // fall through to the legacy mapping if the stored JSON is somehow malformed
    }
  }
  return legacyFrequencyToRule(activity.frequency);
}

/** The raw next calendar date the rule produces, ignoring any end condition. */
function nextDateForRule(dateStr, rule, seriesStartDate) {
  const interval = Math.max(1, rule.interval || 1);

  if (rule.unit === 'month') return addMonthsClamped(dateStr, interval);

  if (rule.unit === 'week') {
    const weekdays = rule.weekdays && rule.weekdays.length > 0 ? [...rule.weekdays].sort((a, b) => a - b) : null;
    if (!weekdays) return addDays(dateStr, interval * 7);

    const curWeekday = isoWeekday(dateStr);
    const laterThisWeek = weekdays.find((w) => w > curWeekday);
    if (laterThisWeek) return addDays(dateStr, laterThisWeek - curWeekday);

    // No more selected weekdays this week — jump `interval` active weeks forward from the series' anchor week.
    const anchorMonday = startOfWeek(seriesStartDate || dateStr);
    const curMonday = startOfWeek(dateStr);
    const weeksSinceAnchor = Math.round((parseDate(curMonday) - parseDate(anchorMonday)) / 86400000 / 7);
    const nextMonday = addDays(anchorMonday, (weeksSinceAnchor + interval) * 7);
    return addDays(nextMonday, weekdays[0] - 1);
  }

  return addDays(dateStr, interval); // 'day'
}

function seriesHasEnded(rule, candidateDate, occurrencesCreated) {
  if (!rule.end || rule.end.type === 'never') return false;
  if (rule.end.type === 'on_date') return !rule.end.date || candidateDate > rule.end.date;
  if (rule.end.type === 'after_count') return occurrencesCreated >= (rule.end.count || 1);
  return false;
}

/** The due date for a brand-new series' very first occurrence. For a weekly rule with specific weekdays
 *  chosen, this snaps forward to the first selected weekday on or after the series' start date — without
 *  this, a series started on a day outside its own weekday selection would have an out-of-pattern first
 *  due date (e.g. starting on a Monday but only Wed/Fri selected). Every other rule shape just starts on
 *  the given date, unchanged. */
export function firstDueDate(startDate, rule) {
  if (rule.unit !== 'week' || !rule.weekdays || rule.weekdays.length === 0) return startDate;
  const weekdays = [...rule.weekdays].sort((a, b) => a - b);
  const curWeekday = isoWeekday(startDate);
  const sameOrLater = weekdays.find((w) => w >= curWeekday);
  if (sameOrLater) return addDays(startDate, sameOrLater - curWeekday);
  const nextMonday = addDays(startOfWeek(startDate), 7);
  return addDays(nextMonday, weekdays[0] - 1);
}

/** Given the date a recurring task was due and its recurring_activities row, what's the next due date? Null
 *  once the series has run its course (an end date/count was reached) — the caller should stop repeating it. */
export function nextOccurrence(dateStr, activity) {
  const rule = parseRule(activity);
  const candidate = nextDateForRule(dateStr, rule, activity.series_start_date || dateStr);
  if (seriesHasEnded(rule, candidate, activity.occurrences_created || 1)) return null;
  return candidate;
}

/** Rejects a malformed rule rather than letting bad data silently corrupt the schedule — returns an error
 *  string, or null when the rule is valid. */
export function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return 'A recurrence rule is required.';
  if (!['day', 'week', 'month'].includes(rule.unit)) return 'Choose Day, Week, or Month.';
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 365) return 'The repeat interval must be a whole number of 1 or more.';
  if (rule.weekdays !== undefined) {
    if (!Array.isArray(rule.weekdays) || rule.weekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7)) {
      return 'Weekdays must be a list of days from 1 (Monday) to 7 (Sunday).';
    }
  }
  const end = rule.end || { type: 'never' };
  if (!['never', 'on_date', 'after_count'].includes(end.type)) return 'Choose how the series should end.';
  if (end.type === 'on_date' && !end.date) return 'Choose an end date.';
  if (end.type === 'after_count' && (!Number.isInteger(end.count) || end.count < 1 || end.count > 999)) return 'Choose how many times it should repeat.';
  return null;
}

/** A plain-language label for the frequency column — "Weekly on Mon, Wed", "Every 2 months", etc. */
export function describeRule(rule) {
  const interval = Math.max(1, rule.interval || 1);
  const unitWord = { day: 'day', week: 'week', month: 'month' }[rule.unit] || 'day';

  let base;
  if (rule.unit === 'week' && rule.weekdays && rule.weekdays.length > 0) {
    const names = [...rule.weekdays].sort((a, b) => a - b).map((w) => WEEKDAY_LABELS[w - 1]).join(', ');
    base = interval === 1 ? `Weekly on ${names}` : `Every ${interval} weeks on ${names}`;
  } else {
    base = interval === 1 ? `Every ${unitWord}` : `Every ${interval} ${unitWord}s`;
  }

  if (rule.end?.type === 'on_date' && rule.end.date) return `${base}, until ${rule.end.date}`;
  if (rule.end?.type === 'after_count' && rule.end.count) return `${base}, ${rule.end.count}×`;
  return base;
}
