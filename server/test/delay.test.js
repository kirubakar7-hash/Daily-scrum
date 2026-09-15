import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDelay, withLateness } from '../src/lib/delay.js';

test('withDelay — no due_date reports 0', () => {
  assert.equal(withDelay({ due_date: null }, '2026-09-10').delay_days, 0);
});

test('withDelay — overdue task reports the correct whole-day gap', () => {
  const row = { due_date: '2026-09-05' };
  assert.equal(withDelay(row, '2026-09-10').delay_days, 5);
});

test('withDelay — a task not yet due reports 0, never negative', () => {
  const row = { due_date: '2026-09-15' };
  assert.equal(withDelay(row, '2026-09-10').delay_days, 0);
});

test('withDelay — due today reports 0', () => {
  const row = { due_date: '2026-09-10' };
  assert.equal(withDelay(row, '2026-09-10').delay_days, 0);
});

test('withLateness — no completed_at reports 0', () => {
  assert.equal(withLateness({ due_date: '2026-09-10', completed_at: null }).days_late, 0);
});

// This is the exact bug fixed this session: due_date is a calendar-day string, completed_at is a full
// timestamp — comparing them at millisecond precision (instead of calendar-day precision) rounds a
// same-day-but-later-clock-time completion up to "1 day late" even though it was completed on time.
test('withLateness — completed later in the day, on the due date itself, is NOT late', () => {
  const row = { due_date: '2026-09-10', completed_at: '2026-09-10T22:45:00.000Z' };
  assert.equal(withLateness(row).days_late, 0);
});

test('withLateness — completed the next calendar day IS 1 day late', () => {
  const row = { due_date: '2026-09-10', completed_at: '2026-09-11T00:05:00.000Z' };
  assert.equal(withLateness(row).days_late, 1);
});

test('withLateness — completed before the due date is not late', () => {
  const row = { due_date: '2026-09-10', completed_at: '2026-09-08T10:00:00.000Z' };
  assert.equal(withLateness(row).days_late, 0);
});

test('withLateness — completed several days late reports the correct count', () => {
  const row = { due_date: '2026-09-01', completed_at: '2026-09-06T09:00:00.000Z' };
  assert.equal(withLateness(row).days_late, 5);
});
