import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBusinessDate, getBusinessDateTime } from '../src/lib/businessDate.js';

// IST is UTC+5:30 with no DST — the "danger zone" where the UTC calendar day and the IST calendar day
// disagree is exactly 18:30 UTC through 23:59:59 UTC (00:00 IST through 05:29:59 IST the next day). Every
// instant below is chosen to land in or just outside that window, since that's exactly where the old
// `new Date().toISOString().slice(0, 10)` bug silently returned yesterday's UTC date instead of today's IST one.

test('getBusinessDate — 11:59pm IST stays on the current business date', () => {
  // 11:59pm IST = 18:29 UTC (5:30 short of the IST/UTC day boundary).
  assert.equal(getBusinessDate(new Date('2026-09-22T18:29:00.000Z')), '2026-09-22');
});

test('getBusinessDate — 12:01am IST rolls over to the next business date', () => {
  // 12:01am IST the next day = 18:31 UTC the previous day.
  assert.equal(getBusinessDate(new Date('2026-09-22T18:31:00.000Z')), '2026-09-23');
});

test('getBusinessDate — exactly midnight IST is the new day, not the old one', () => {
  assert.equal(getBusinessDate(new Date('2026-09-22T18:30:00.000Z')), '2026-09-23');
});

test('getBusinessDate — early UTC morning is safely mid-morning IST, same calendar day', () => {
  // 3:00am UTC = 8:30am IST — same date in both, just to confirm the common case isn't disturbed.
  assert.equal(getBusinessDate(new Date('2026-09-22T03:00:00.000Z')), '2026-09-22');
});

test('getBusinessDate — late UTC evening is already the next IST calendar day', () => {
  // This is the exact bug this fixes: 10:45pm UTC looks like "still today" in UTC terms, but it's
  // 4:15am IST the next morning — an Indian business day that has already rolled over.
  assert.equal(getBusinessDate(new Date('2026-09-10T22:45:00.000Z')), '2026-09-11');
});

test('getBusinessDate — defaults to "right now" when no instant is given', () => {
  const result = getBusinessDate();
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('getBusinessDateTime — returns the IST calendar day and time-of-day together', () => {
  const result = getBusinessDateTime(new Date('2026-09-22T09:15:00.000Z')); // 09:15 UTC = 14:45 IST
  assert.deepEqual(result, { date: '2026-09-22', time: '14:45:00' });
});

test('getBusinessDateTime — a time-of-day that crosses the IST day boundary carries the date with it', () => {
  const result = getBusinessDateTime(new Date('2026-09-22T20:00:00.000Z')); // 20:00 UTC = 01:30 IST next day
  assert.deepEqual(result, { date: '2026-09-23', time: '01:30:00' });
});
