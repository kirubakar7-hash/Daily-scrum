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
