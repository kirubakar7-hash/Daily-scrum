// Calendar-style recurrence, similar to a Teams/Outlook meeting series:
//   { interval: 2, unit: 'week', weekdays: [1,3], end: { type: 'on_date', date: '2026-12-31' } }
//   = "repeat every 2 weeks on Mon & Wed, until 2026-12-31"
//
// unit: 'day' | 'week' | 'month'. weekdays (unit='week' only): ISO weekday numbers, 1=Mon..7=Sun —
// omit/empty to repeat on the same weekday as the series start, every `interval` weeks.
// end.type: 'never' | 'on_date' (end.date) | 'after_count' (end.count, total occurrences in the series).
//
// unit='month' also carries the day it lands on (optional — a rule without either uses the series' start day):
//   day_of_month: 1..31, or last_day: true. A month without that day uses its last day (31st → 30 Apr, 28/29 Feb).
//   month: 1..12 — Yearly only (interval a multiple of 12): which month of the year.
// The named frequencies are just shapes of this one rule, stored as-is in recurring_activities.recurrence_rule:
//   Daily         { unit: 'day',   interval: 1 }
//   Weekly        { unit: 'week',  interval: 1, weekdays: [5] }            (e.g. every Friday)
//   Business Week { unit: 'week',  interval: 1, weekdays: [1,2,3,4,5] }    (Mon–Fri, never Sat/Sun)
//   Monthly       { unit: 'month', interval: 1, day_of_month: 15 }         (or last_day: true)
//   Quarterly     { unit: 'month', interval: 3, day_of_month: 1 }
//   Half-Yearly   { unit: 'month', interval: 6, day_of_month: 15 }
//   Yearly        { unit: 'month', interval: 12, month: 9, day_of_month: 15 }

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_CYCLE_NAMES = { 1: 'Monthly', 3: 'Quarterly', 6: 'Half-yearly', 12: 'Yearly' };

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

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of the next month = last day of this one
}

/** The rule's day inside one specific month (month index = year*12 + zero-based month). A day the month
 *  doesn't have (the 31st in April, the 29th–31st in February) lands on that month's last day — the same
 *  rule Outlook uses — and never rolls over into the next month. `last_day` always means the last day. */
function dayInMonth(monthIndex, rule, anchorDay) {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const last = daysInMonth(year, month);
  const day = rule.last_day ? last : Math.min(rule.day_of_month || anchorDay, last);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `months` calendar months after dateStr, on the rule's configured day. The day always comes from the
 *  rule (day_of_month / last_day) or, for a rule that predates those fields, the series' own start day —
 *  never from the previous occurrence, so a short month can't drag every later date down with it
 *  (31 Jan → 28 Feb → 31 Mar, not → 28 Mar forever). */
function addMonthsOnDay(dateStr, months, rule, anchorDay) {
  const [y, m] = dateStr.split('-').map(Number);
  return dayInMonth(y * 12 + (m - 1) + months, rule, anchorDay);
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
  if (frequency === 'Business Week') return { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5], end: { type: 'never' } };
  if (frequency === 'Monthly') return { interval: 1, unit: 'month', end: { type: 'never' } };
  if (frequency === 'Quarterly') return { interval: 3, unit: 'month', end: { type: 'never' } };
  if (frequency === 'Half-Yearly') return { interval: 6, unit: 'month', end: { type: 'never' } };
  if (frequency === 'Yearly') return { interval: 12, unit: 'month', end: { type: 'never' } };
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

  if (rule.unit === 'month') return addMonthsOnDay(dateStr, interval, rule, Number((seriesStartDate || dateStr).slice(8, 10)));

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
  // Monthly/Quarterly/Half-Yearly/Yearly with a chosen day: the first matching date on or after the start
  // (Yearly also snaps to its chosen month). The cycle then counts from that first occurrence.
  if (rule.unit === 'month' && (rule.day_of_month || rule.last_day)) {
    const [y, m] = startDate.split('-').map(Number);
    let index = y * 12 + (m - 1);
    if (rule.month) index += (rule.month - 1 - (index % 12) + 12) % 12;
    let candidate = dayInMonth(index, rule);
    if (candidate < startDate) candidate = dayInMonth(index + (rule.month ? 12 : 1), rule);
    return candidate;
  }
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
  if (rule.day_of_month != null) {
    if (rule.unit !== 'month') return 'A day of the month only applies to a monthly-style repeat.';
    if (!Number.isInteger(rule.day_of_month) || rule.day_of_month < 1 || rule.day_of_month > 31) return 'The day of the month must be from 1 to 31.';
  }
  if (rule.last_day != null) {
    if (typeof rule.last_day !== 'boolean') return 'Last day of the month must be yes or no.';
    if (rule.last_day && rule.unit !== 'month') return 'Last day of the month only applies to a monthly-style repeat.';
    if (rule.last_day && rule.day_of_month != null) return 'Choose either a day of the month or the last day, not both.';
  }
  if (rule.month != null) {
    if (rule.unit !== 'month' || rule.interval % 12 !== 0) return 'A month only applies to a yearly repeat.';
    if (!Number.isInteger(rule.month) || rule.month < 1 || rule.month > 12) return 'Choose a month from January to December.';
    if (rule.day_of_month == null && !rule.last_day) return 'Choose which day of that month.';
    // Feb 29 is allowed (it falls on Feb 28 in non-leap years); a day no year has, like 31 April, is not.
    if (rule.day_of_month > daysInMonth(2024, rule.month)) return `${MONTH_LABELS[rule.month - 1]} has only ${daysInMonth(2024, rule.month)} days.`;
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
  const weekdayKey = [...(rule.weekdays || [])].sort((a, b) => a - b).join(',');
  if (rule.unit === 'week' && interval === 1 && weekdayKey === '1,2,3,4,5') {
    base = 'Every business day (Mon–Fri)';
  } else if (rule.unit === 'month' && (rule.day_of_month || rule.last_day)) {
    const cycle = MONTH_CYCLE_NAMES[interval] || `Every ${interval} months`;
    if (rule.month) base = `${cycle} on ${rule.last_day ? 'the last day of' : rule.day_of_month} ${MONTH_LABELS[rule.month - 1]}`;
    else base = `${cycle} on ${rule.last_day ? 'the last day' : `day ${rule.day_of_month}`}`;
  } else if (rule.unit === 'week' && rule.weekdays && rule.weekdays.length > 0) {
    const names = [...rule.weekdays].sort((a, b) => a - b).map((w) => WEEKDAY_LABELS[w - 1]).join(', ');
    base = interval === 1 ? `Weekly on ${names}` : `Every ${interval} weeks on ${names}`;
  } else {
    base = interval === 1 ? `Every ${unitWord}` : `Every ${interval} ${unitWord}s`;
  }

  if (rule.end?.type === 'on_date' && rule.end.date) return `${base}, until ${rule.end.date}`;
  if (rule.end?.type === 'after_count' && rule.end.count) return `${base}, ${rule.end.count}×`;
  return base;
}
