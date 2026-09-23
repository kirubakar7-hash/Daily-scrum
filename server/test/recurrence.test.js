import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyFrequencyToRule, validateRule, describeRule, nextOccurrence, firstDueDate } from '../src/lib/recurrence.js';

// Reference dates used throughout: 2026-09-10 is a Thursday (isoWeekday 4).
// 2026-09-07 Mon(1), 09-08 Tue(2), 09-09 Wed(3), 09-10 Thu(4), 09-14 Mon(1, next week).

test('legacyFrequencyToRule — maps every known label, defaults unknown to daily', () => {
  assert.deepEqual(legacyFrequencyToRule('Daily'), { interval: 1, unit: 'day', end: { type: 'never' } });
  assert.deepEqual(legacyFrequencyToRule('Weekly'), { interval: 1, unit: 'week', weekdays: [], end: { type: 'never' } });
  assert.deepEqual(legacyFrequencyToRule('Weekdays'), { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5], end: { type: 'never' } });
  assert.deepEqual(legacyFrequencyToRule('Monthly'), { interval: 1, unit: 'month', end: { type: 'never' } });
  assert.deepEqual(legacyFrequencyToRule('something-unrecognized'), { interval: 1, unit: 'day', end: { type: 'never' } });
});

test('validateRule — rejects malformed rules with a specific reason', () => {
  assert.ok(validateRule(null));
  assert.ok(validateRule({ unit: 'fortnight', interval: 1 }));
  assert.ok(validateRule({ unit: 'day', interval: 0 }));
  assert.ok(validateRule({ unit: 'day', interval: 400 }));
  assert.ok(validateRule({ unit: 'week', interval: 1, weekdays: [0, 8] }));
  assert.ok(validateRule({ unit: 'day', interval: 1, end: { type: 'on_date' } }));
  assert.ok(validateRule({ unit: 'day', interval: 1, end: { type: 'after_count', count: 0 } }));
});

test('validateRule — accepts a well-formed rule', () => {
  assert.equal(validateRule({ interval: 2, unit: 'week', weekdays: [1, 3], end: { type: 'never' } }), null);
});

test('nextOccurrence — daily advances by the interval', () => {
  const activity = { recurrence_rule: JSON.stringify({ interval: 1, unit: 'day', end: { type: 'never' } }), occurrences_created: 1 };
  assert.equal(nextOccurrence('2026-09-10', activity), '2026-09-11');
});

test('nextOccurrence — weekly with no specific weekdays jumps a full interval', () => {
  const activity = { recurrence_rule: JSON.stringify({ interval: 1, unit: 'week', weekdays: [], end: { type: 'never' } }), occurrences_created: 1 };
  assert.equal(nextOccurrence('2026-09-10', activity), '2026-09-17');
});

test('nextOccurrence — weekly with weekdays jumps to the next selected day THIS week when one remains', () => {
  const activity = {
    recurrence_rule: JSON.stringify({ interval: 1, unit: 'week', weekdays: [1, 3], end: { type: 'never' } }),
    series_start_date: '2026-09-07', occurrences_created: 1,
  };
  // From Monday (the series' own anchor weekday), Wednesday is still ahead in the same week.
  assert.equal(nextOccurrence('2026-09-07', activity), '2026-09-09');
});

test('nextOccurrence — weekly with weekdays jumps `interval` weeks once this week is exhausted', () => {
  const activity = {
    recurrence_rule: JSON.stringify({ interval: 1, unit: 'week', weekdays: [1, 3], end: { type: 'never' } }),
    series_start_date: '2026-09-07', occurrences_created: 1,
  };
  // From Wednesday, no later selected weekday remains this week — lands on next week's first pick (Monday).
  assert.equal(nextOccurrence('2026-09-09', activity), '2026-09-14');
});

test('nextOccurrence — monthly clamps to the last day of the month when the original day does not exist there', () => {
  const activity = { recurrence_rule: JSON.stringify({ interval: 1, unit: 'month', end: { type: 'never' } }), occurrences_created: 1 };
  // Jan 31 + 1 month must not silently become "Mar 3" — it clamps to Feb 28 (2026 is not a leap year).
  assert.equal(nextOccurrence('2026-01-31', activity), '2026-02-28');
});

test('nextOccurrence — monthly clamps to Feb 29 in a leap year, not Feb 28', () => {
  const activity = { recurrence_rule: JSON.stringify({ interval: 1, unit: 'month', end: { type: 'never' } }), occurrences_created: 1 };
  // 2028 is a leap year — Jan 31 + 1 month must clamp to the real last day of February, Feb 29.
  assert.equal(nextOccurrence('2028-01-31', activity), '2028-02-29');
});

test('nextOccurrence — monthly clamps back down from Feb 29 once the following year is not a leap year', () => {
  const activity = { recurrence_rule: JSON.stringify({ interval: 12, unit: 'month', end: { type: 'never' } }), occurrences_created: 1 };
  // A series anchored on Feb 29 (a leap day) jumping 12 months lands in a non-leap February, which has
  // no 29th — must clamp to Feb 28, not overflow into March.
  assert.equal(nextOccurrence('2028-02-29', activity), '2029-02-28');
});

test('nextOccurrence — weekly with an interval greater than 1 jumps whole OFF weeks, not just to the next selected weekday', () => {
  const activity = {
    recurrence_rule: JSON.stringify({ interval: 2, unit: 'week', weekdays: [1, 3], end: { type: 'never' } }),
    series_start_date: '2026-09-07', occurrences_created: 1,
  };
  // Anchor week (containing 09-07, a Monday): Mon 09-07 -> Wed 09-09 stays in the anchor week, same as
  // interval=1 would. The real interval>1 behavior only shows up on the NEXT jump: from Wed 09-09, the
  // following selected weekday (Monday) must skip an entire off-week and land 2 weeks after the anchor
  // week (09-21), not just 1 week out — proving the anchor-based math (not naive "+7 days") is what runs.
  assert.equal(nextOccurrence('2026-09-07', activity), '2026-09-09');
  assert.equal(nextOccurrence('2026-09-09', activity), '2026-09-21');
  // And it keeps that same 2-week cadence going forward, without drifting.
  assert.equal(nextOccurrence('2026-09-21', activity), '2026-09-23');
  assert.equal(nextOccurrence('2026-09-23', activity), '2026-10-05');
});

test('nextOccurrence — returns null once an on_date end condition has passed, so the series stops', () => {
  const activity = {
    recurrence_rule: JSON.stringify({ interval: 1, unit: 'day', end: { type: 'on_date', date: '2026-09-10' } }),
    occurrences_created: 1,
  };
  assert.equal(nextOccurrence('2026-09-10', activity), null);
});

test('nextOccurrence — returns null once an after_count end condition has been reached', () => {
  const activity = {
    recurrence_rule: JSON.stringify({ interval: 1, unit: 'day', end: { type: 'after_count', count: 3 } }),
    occurrences_created: 3,
  };
  assert.equal(nextOccurrence('2026-09-10', activity), null);
});

// firstDueDate is the fix for: a series started on a day the weekday rule doesn't include used to get an
// out-of-pattern first due date (e.g. starting Monday, selecting only Wed/Fri).
test('firstDueDate — non-weekly rules always start on the given date, unchanged', () => {
  assert.equal(firstDueDate('2026-09-10', { unit: 'day', interval: 1 }), '2026-09-10');
  assert.equal(firstDueDate('2026-09-10', { unit: 'month', interval: 1 }), '2026-09-10');
});

test('firstDueDate — weekly with no weekdays selected starts on the given date, unchanged', () => {
  assert.equal(firstDueDate('2026-09-10', { unit: 'week', interval: 1, weekdays: [] }), '2026-09-10');
});

test('firstDueDate — starting on a day the rule already includes stays put', () => {
  assert.equal(firstDueDate('2026-09-09', { unit: 'week', interval: 1, weekdays: [1, 3] }), '2026-09-09');
});

test('firstDueDate — snaps forward within the same week when a later selected day remains', () => {
  // Starting Monday, only Wed/Fri selected — the first occurrence must be Wednesday, not Monday.
  assert.equal(firstDueDate('2026-09-07', { unit: 'week', interval: 1, weekdays: [3, 5] }), '2026-09-09');
});

test('firstDueDate — snaps to next week\'s first selected day when none remain this week', () => {
  // Starting Thursday, only Mon/Wed selected — nothing left this week, so it jumps to next Monday.
  assert.equal(firstDueDate('2026-09-10', { unit: 'week', interval: 1, weekdays: [1, 3] }), '2026-09-14');
});

test('describeRule — produces a readable label for weekday and plain-interval rules', () => {
  assert.equal(describeRule({ interval: 1, unit: 'week', weekdays: [1, 3], end: { type: 'never' } }), 'Weekly on Mon, Wed');
  assert.equal(describeRule({ interval: 2, unit: 'month', end: { type: 'never' } }), 'Every 2 months');
  assert.equal(describeRule({ interval: 1, unit: 'day', end: { type: 'after_count', count: 5 } }), 'Every day, 5×');
});

// ---- Named frequencies (Daily / Weekly / Business Week / Monthly / Quarterly / Half-Yearly / Yearly) ----
// 2026-09-21 Mon, 09-23 Wed, 09-25 Fri, 09-26 Sat, 09-27 Sun, 09-28 Mon.
const seriesOf = (rule, start) => ({ recurrence_rule: JSON.stringify({ end: { type: 'never' }, ...rule }), series_start_date: start, occurrences_created: 1 });
const chain = (activity, from, n) => {
  const out = [from];
  for (let i = 0; i < n; i++) out.push(nextOccurrence(out[out.length - 1], activity));
  return out;
};

test('Daily — 23 Sep → 24 Sep → 25 Sep → 26 Sep, and across month and year ends', () => {
  const a = seriesOf({ interval: 1, unit: 'day' }, '2026-09-23');
  assert.deepEqual(chain(a, '2026-09-23', 3), ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
  assert.equal(nextOccurrence('2026-09-30', a), '2026-10-01');
  assert.equal(nextOccurrence('2026-12-31', a), '2027-01-01');
  assert.equal(nextOccurrence('2028-02-28', a), '2028-02-29', 'leap day');
});

test('Weekly — keeps the chosen weekday: Monday → next Monday, Friday → next Friday', () => {
  const monday = seriesOf({ interval: 1, unit: 'week', weekdays: [1] }, '2026-09-23');
  assert.equal(firstDueDate('2026-09-23', { unit: 'week', weekdays: [1] }), '2026-09-28', 'started on a Wednesday, first one is the next Monday');
  assert.deepEqual(chain(monday, '2026-09-28', 2), ['2026-09-28', '2026-10-05', '2026-10-12']);
  const friday = seriesOf({ interval: 1, unit: 'week', weekdays: [5] }, '2026-09-23');
  assert.equal(firstDueDate('2026-09-23', { unit: 'week', weekdays: [5] }), '2026-09-25');
  assert.deepEqual(chain(friday, '2026-09-25', 2), ['2026-09-25', '2026-10-02', '2026-10-09']);
  assert.equal(nextOccurrence('2026-12-28', monday), '2027-01-04', 'across a year end');
});

test('Business Week — Friday → Monday, Monday → Tuesday, Thursday → Friday, never a weekend', () => {
  const rule = { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] };
  const a = seriesOf(rule, '2026-09-21');
  assert.equal(nextOccurrence('2026-09-25', a), '2026-09-28', 'Friday → Monday');
  assert.equal(nextOccurrence('2026-09-21', a), '2026-09-22', 'Monday → Tuesday');
  assert.equal(nextOccurrence('2026-09-24', a), '2026-09-25', 'Thursday → Friday');
  assert.equal(firstDueDate('2026-09-26', rule), '2026-09-28', 'a series started on a Saturday begins Monday');
  const dates = chain(a, '2026-09-21', 300); // well over a year, through month and year ends
  const weekend = dates.filter((d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
  assert.deepEqual(weekend, [], 'no Saturday or Sunday, ever');
  assert.equal(new Set(dates).size, dates.length, 'no date twice');
});

test('Monthly — 15 Sep → 15 Oct → 15 Nov; 1st of every month', () => {
  const a = seriesOf({ interval: 1, unit: 'month', day_of_month: 15 }, '2026-09-15');
  assert.deepEqual(chain(a, '2026-09-15', 4), ['2026-09-15', '2026-10-15', '2026-11-15', '2026-12-15', '2027-01-15']);
  const first = seriesOf({ interval: 1, unit: 'month', day_of_month: 1 }, '2026-09-01');
  assert.deepEqual(chain(first, '2026-09-01', 2), ['2026-09-01', '2026-10-01', '2026-11-01']);
  assert.equal(firstDueDate('2026-09-23', { unit: 'month', day_of_month: 15 }), '2026-10-15', 'the 15th has passed this month, so next month');
  assert.equal(firstDueDate('2026-09-10', { unit: 'month', day_of_month: 15 }), '2026-09-15');
});

test('Monthly on the 31st — a short month uses its last day, and the next month goes back to the 31st', () => {
  const a = seriesOf({ interval: 1, unit: 'month', day_of_month: 31 }, '2027-01-31');
  assert.equal(nextOccurrence('2027-01-31', a), '2027-02-28', '31 Jan → February');
  assert.equal(nextOccurrence('2027-03-31', a), '2027-04-30', '31 Mar → April');
  assert.equal(nextOccurrence('2027-05-31', a), '2027-06-30', '31 May → June');
  assert.equal(nextOccurrence('2027-08-31', a), '2027-09-30', '31 Aug → September');
  assert.equal(nextOccurrence('2027-10-31', a), '2027-11-30', '31 Oct → November');
  assert.equal(nextOccurrence('2027-02-28', a), '2027-03-31', 'no drift: after February it is the 31st again, not the 28th');
  assert.equal(nextOccurrence('2028-01-31', a), '2028-02-29', 'leap year February');
});

test('Monthly — a rule saved before day_of_month existed keeps its start day instead of drifting', () => {
  // Existing monthly series (no day_of_month) anchor on their own start day — previously 31 Jan → 28 Feb
  // → 28 Mar forever; now it recovers to 31 Mar.
  const a = seriesOf({ interval: 1, unit: 'month' }, '2027-01-31');
  assert.deepEqual(chain(a, '2027-01-31', 3), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
});

test('Monthly on the last day — 31 Jan → 28 Feb → 31 Mar → 30 Apr, and 29 Feb in a leap year', () => {
  const rule = { interval: 1, unit: 'month', last_day: true };
  const a = seriesOf(rule, '2027-01-31');
  assert.deepEqual(chain(a, '2027-01-31', 3), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.equal(nextOccurrence('2028-01-31', a), '2028-02-29');
  assert.equal(firstDueDate('2026-09-23', rule), '2026-09-30');
});

test('Quarterly — 1 Jan → 1 Apr → 1 Jul → 1 Oct → 1 Jan; 15 Feb → 15 May → 15 Aug → 15 Nov', () => {
  const a = seriesOf({ interval: 3, unit: 'month', day_of_month: 1 }, '2027-01-01');
  assert.deepEqual(chain(a, '2027-01-01', 4), ['2027-01-01', '2027-04-01', '2027-07-01', '2027-10-01', '2028-01-01']);
  const b = seriesOf({ interval: 3, unit: 'month', day_of_month: 15 }, '2027-02-15');
  assert.deepEqual(chain(b, '2027-02-15', 3), ['2027-02-15', '2027-05-15', '2027-08-15', '2027-11-15']);
  const c = seriesOf({ interval: 3, unit: 'month', day_of_month: 31 }, '2027-01-31');
  assert.deepEqual(chain(c, '2027-01-31', 4), ['2027-01-31', '2027-04-30', '2027-07-31', '2027-10-31', '2028-01-31'], 'short months follow the Monthly rule, then recover');
  assert.equal(firstDueDate('2026-09-23', { unit: 'month', interval: 3, day_of_month: 1 }), '2026-10-01');
});

test('Half-Yearly — 1 Jan → 1 Jul → 1 Jan; 15 Mar → 15 Sep → 15 Mar', () => {
  const a = seriesOf({ interval: 6, unit: 'month', day_of_month: 1 }, '2027-01-01');
  assert.deepEqual(chain(a, '2027-01-01', 2), ['2027-01-01', '2027-07-01', '2028-01-01']);
  const b = seriesOf({ interval: 6, unit: 'month', day_of_month: 15 }, '2027-03-15');
  assert.deepEqual(chain(b, '2027-03-15', 2), ['2027-03-15', '2027-09-15', '2028-03-15']);
  const c = seriesOf({ interval: 6, unit: 'month', day_of_month: 31 }, '2027-08-31');
  assert.deepEqual(chain(c, '2027-08-31', 2), ['2027-08-31', '2028-02-29', '2028-08-31']);
});

test('Yearly — 1 Jan 2027 → 1 Jan 2028; 15 Sep → 15 Sep; 29 Feb falls on 28 Feb in non-leap years', () => {
  const jan = { interval: 12, unit: 'month', month: 1, day_of_month: 1 };
  assert.equal(firstDueDate('2026-09-23', jan), '2027-01-01');
  assert.deepEqual(chain(seriesOf(jan, '2027-01-01'), '2027-01-01', 1), ['2027-01-01', '2028-01-01']);
  const sep = { interval: 12, unit: 'month', month: 9, day_of_month: 15 };
  assert.equal(firstDueDate('2026-09-10', sep), '2026-09-15');
  assert.equal(firstDueDate('2026-09-23', sep), '2027-09-15', 'this year\'s date has passed');
  assert.equal(nextOccurrence('2026-09-15', seriesOf(sep, '2026-09-15')), '2027-09-15');
  const leap = { interval: 12, unit: 'month', month: 2, day_of_month: 29 };
  assert.equal(firstDueDate('2026-09-23', leap), '2027-02-28');
  assert.deepEqual(chain(seriesOf(leap, '2028-02-29'), '2028-02-29', 4), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  const febLast = { interval: 12, unit: 'month', month: 2, last_day: true };
  assert.deepEqual(chain(seriesOf(febLast, '2027-02-28'), '2027-02-28', 1), ['2027-02-28', '2028-02-29']);
});

test('validateRule — the new day/month fields reject impossible or contradictory choices', () => {
  assert.ok(validateRule({ interval: 1, unit: 'month', day_of_month: 32 }));
  assert.ok(validateRule({ interval: 1, unit: 'month', day_of_month: 0 }));
  assert.ok(validateRule({ interval: 1, unit: 'day', day_of_month: 5 }), 'day of month on a daily rule');
  assert.ok(validateRule({ interval: 1, unit: 'month', day_of_month: 5, last_day: true }), 'both a day and last day');
  assert.ok(validateRule({ interval: 1, unit: 'month', month: 3, day_of_month: 5 }), 'a month on a monthly rule');
  assert.ok(validateRule({ interval: 12, unit: 'month', month: 13, day_of_month: 1 }));
  assert.ok(validateRule({ interval: 12, unit: 'month', month: 4, day_of_month: 31 }), '31 April does not exist');
  assert.ok(validateRule({ interval: 12, unit: 'month', month: 2, day_of_month: 30 }));
  assert.ok(validateRule({ interval: 12, unit: 'month', month: 6 }), 'yearly needs a day');
  for (const ok of [
    { interval: 1, unit: 'day' },
    { interval: 1, unit: 'week', weekdays: [1] },
    { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] },
    { interval: 1, unit: 'month', day_of_month: 31 },
    { interval: 1, unit: 'month', last_day: true },
    { interval: 3, unit: 'month', day_of_month: 1 },
    { interval: 6, unit: 'month', day_of_month: 15 },
    { interval: 12, unit: 'month', month: 2, day_of_month: 29 },
    { interval: 12, unit: 'month', month: 12, last_day: true },
  ]) assert.equal(validateRule(ok), null, JSON.stringify(ok));
});

test('describeRule — a plain label for each named frequency', () => {
  const d = (r) => describeRule({ end: { type: 'never' }, ...r });
  assert.equal(d({ interval: 1, unit: 'day' }), 'Every day');
  assert.equal(d({ interval: 1, unit: 'week', weekdays: [5] }), 'Weekly on Fri');
  assert.equal(d({ interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }), 'Every business day (Mon–Fri)');
  assert.equal(d({ interval: 1, unit: 'month', day_of_month: 15 }), 'Monthly on day 15');
  assert.equal(d({ interval: 1, unit: 'month', last_day: true }), 'Monthly on the last day');
  assert.equal(d({ interval: 3, unit: 'month', day_of_month: 1 }), 'Quarterly on day 1');
  assert.equal(d({ interval: 6, unit: 'month', day_of_month: 15 }), 'Half-yearly on day 15');
  assert.equal(d({ interval: 12, unit: 'month', month: 9, day_of_month: 15 }), 'Yearly on 15 Sep');
  assert.equal(d({ interval: 12, unit: 'month', month: 2, last_day: true }), 'Yearly on the last day of Feb');
});

test('legacyFrequencyToRule — the CSV import accepts the new frequency names', () => {
  assert.deepEqual(legacyFrequencyToRule('Business Week').weekdays, [1, 2, 3, 4, 5]);
  assert.equal(legacyFrequencyToRule('Quarterly').interval, 3);
  assert.equal(legacyFrequencyToRule('Half-Yearly').interval, 6);
  assert.equal(legacyFrequencyToRule('Yearly').interval, 12);
});
