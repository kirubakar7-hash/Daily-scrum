import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuid } from 'uuid';
import bcrypt from 'bcryptjs';
import { createTestSchema, dropTestSchema } from './helpers/pgTestSchema.js';

// The real scheduler against a real (disposable) Postgres schema, run at fixed moments via its test-only
// `now` option — so each scenario pins an exact IST business date instead of depending on today. Its own
// file means its own schema: the far-future dates here can't touch api.integration.test.js's data.
process.env.JWT_SECRET = 'test-secret-not-for-production-use';
process.env.NODE_ENV = 'test';

const schema = await createTestSchema();
const { db, closeDb } = await import('../src/db.js');
const { generateDueOccurrences } = await import('../src/lib/recurringOccurrences.js');

let employeeId;

before(async () => {
  employeeId = uuid();
  await db.prepare(`INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?, 'Scheduler Tester', 'sched@test.local', ?, 'employee')`)
    .run(employeeId, bcrypt.hashSync('SchedPass123', 10));
});

after(async () => {
  await closeDb();
  await dropTestSchema(schema);
});

// Vercel's cron fires at 03:00 UTC = 08:30 IST; `at('2026-09-24')` is that run on 24 Sep.
const at = (date) => new Date(`${date}T03:00:00.000Z`);
const run = (date) => generateDueOccurrences({ now: at(date) });

// Every test starts from a clean slate: series from earlier tests are switched off so a run here only
// ever sees this test's own series, and its created/ended counts are exact.
async function isolate() {
  await db.prepare('UPDATE recurring_activities SET is_active = 0').run();
}

async function seed({ rule, start, last, isActive = 1, title = 'Scheduled task' }) {
  const id = uuid();
  await db.prepare(`
    INSERT INTO recurring_activities (id, employee_id, title, recurrence_rule, series_start_date, occurrences_created, priority, is_active, created_by)
    VALUES (?, ?, ?, ?, ?, 1, 'Medium', ?, ?)
  `).run(id, employeeId, title, JSON.stringify({ end: { type: 'never' }, ...rule }), start || last, isActive, employeeId);
  if (last) {
    await db.prepare(`
      INSERT INTO commitments (id, employee_id, scrum_date, description, type, recurring_activity_id, priority, due_date, original_due_date, start_date, created_by, updated_by)
      VALUES (?, ?, ?, ?, 'recurring', ?, 'Medium', ?, ?, ?, ?, ?)
    `).run(uuid(), employeeId, last, title, id, last, last, last, employeeId, employeeId);
  }
  return id;
}

const dues = async (id) => (await db.prepare('SELECT due_date FROM commitments WHERE recurring_activity_id = ? ORDER BY due_date').all(id)).map((r) => r.due_date);

test('Daily — 23 Sep left incomplete, the 24 Sep run still creates 24 Sep, and the 23rd stays overdue', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'day' }, last: '2026-09-23' });
  const first = await run('2026-09-24');
  assert.equal(first.created, 1);
  assert.deepEqual(await dues(id), ['2026-09-23', '2026-09-24']);
  const old = await db.prepare(`SELECT status FROM commitments WHERE recurring_activity_id = ? AND due_date = '2026-09-23'`).get(id);
  assert.equal(old.status, 'pending', 'the incomplete 23 Sep task is left exactly as it was, now overdue');

  const again = await run('2026-09-24');
  assert.equal(again.created, 0, 'a second run the same day creates nothing');
  assert.deepEqual(await dues(id), ['2026-09-23', '2026-09-24']);
});

test('Weekly (Monday) — nothing on other days, then the next Monday', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'week', weekdays: [1] }, last: '2026-09-21' });
  for (const d of ['2026-09-22', '2026-09-25', '2026-09-26', '2026-09-27']) assert.equal((await run(d)).created, 0, d);
  assert.equal((await run('2026-09-28')).created, 1);
  assert.deepEqual(await dues(id), ['2026-09-21', '2026-09-28']);
});

test('Business Week — Friday → nothing Saturday or Sunday → Monday → Tuesday', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }, last: '2026-09-25' });
  assert.equal((await run('2026-09-26')).created, 0, 'Saturday');
  assert.equal((await run('2026-09-27')).created, 0, 'Sunday');
  assert.equal((await run('2026-09-28')).created, 1, 'Monday');
  assert.equal((await run('2026-09-29')).created, 1, 'Tuesday');
  assert.deepEqual(await dues(id), ['2026-09-25', '2026-09-28', '2026-09-29']);
});

test('Business Week — a run after a missed weekend-plus-Monday lands on the latest business day, never a weekend', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }, last: '2026-09-24' });
  await run('2026-09-27'); // Sunday: latest due business day is Fri 25th
  assert.deepEqual(await dues(id), ['2026-09-24', '2026-09-25']);
});

test('Monthly (15th) — nothing on the 14th, created on 15 Oct', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'month', day_of_month: 15 }, last: '2026-09-15' });
  assert.equal((await run('2026-10-14')).created, 0);
  assert.equal((await run('2026-10-15')).created, 1);
  assert.deepEqual(await dues(id), ['2026-09-15', '2026-10-15']);
});

test('Monthly (31st) — 28 Feb in February, then back to 31 Mar (no drift)', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'month', day_of_month: 31 }, last: '2027-01-31' });
  assert.equal((await run('2027-02-27')).created, 0);
  assert.equal((await run('2027-02-28')).created, 1);
  assert.equal((await run('2027-03-30')).created, 0);
  assert.equal((await run('2027-03-31')).created, 1);
  assert.deepEqual(await dues(id), ['2027-01-31', '2027-02-28', '2027-03-31']);
});

test('Quarterly — 1 Oct → 1 Jan across the year boundary', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 3, unit: 'month', day_of_month: 1 }, last: '2026-10-01' });
  assert.equal((await run('2026-12-31')).created, 0);
  assert.equal((await run('2027-01-01')).created, 1);
  assert.deepEqual(await dues(id), ['2026-10-01', '2027-01-01']);
});

test('Half-Yearly — 1 Jan → 1 Jul', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 6, unit: 'month', day_of_month: 1 }, last: '2027-01-01' });
  assert.equal((await run('2027-04-01')).created, 0);
  assert.equal((await run('2027-07-01')).created, 1);
  assert.deepEqual(await dues(id), ['2027-01-01', '2027-07-01']);
});

test('Yearly — 1 Jan 2027 → 1 Jan 2028; 29 Feb 2028 → 28 Feb 2029 (leap year)', async () => {
  await isolate();
  const jan = await seed({ rule: { interval: 12, unit: 'month', month: 1, day_of_month: 1 }, last: '2027-01-01' });
  const leap = await seed({ rule: { interval: 12, unit: 'month', month: 2, day_of_month: 29 }, last: '2028-02-29' });
  assert.equal((await run('2027-12-31')).created, 0);
  assert.equal((await run('2028-01-01')).created, 1);
  assert.deepEqual(await dues(jan), ['2027-01-01', '2028-01-01']);
  assert.equal((await run('2029-02-28')).created, 2, 'the Jan series is also a year behind by now; the leap one is due');
  assert.deepEqual(await dues(leap), ['2028-02-29', '2029-02-28']);
});

test('A new series with no occurrence yet starts on its chosen day, not its start date', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'month', day_of_month: 15 }, start: '2026-09-23' });
  assert.equal((await run('2026-10-14')).created, 0, 'the first 15th after 23 Sep is 15 Oct');
  assert.equal((await run('2026-10-15')).created, 1);
  assert.deepEqual(await dues(id), ['2026-10-15']);
});

test('IST boundary — 23:45 IST (18:15 UTC) is still the 23rd; 00:15 IST (18:45 UTC, UTC still the 23rd) is the 24th', async () => {
  await isolate();
  const id = await seed({ rule: { interval: 1, unit: 'day' }, last: '2026-09-23' });
  const late = await generateDueOccurrences({ now: new Date('2026-09-23T18:15:00.000Z') });
  assert.equal(late.created, 0, 'still 23 Sep in India — nothing new is due');
  const early = await generateDueOccurrences({ now: new Date('2026-09-23T18:45:00.000Z') });
  assert.equal(early.created, 1, 'already 24 Sep in India even though the server clock (UTC) says 23 Sep');
  assert.deepEqual(await dues(id), ['2026-09-23', '2026-09-24']);
});

test('Paused and ended series create nothing; a series reaching its end date ends in that run', async () => {
  await isolate();
  const paused = await seed({ rule: { interval: 1, unit: 'day' }, last: '2026-09-20', isActive: 0 });
  const endedEarlier = await seed({ rule: { interval: 1, unit: 'day', end: { type: 'on_date', date: '2026-09-21' } }, last: '2026-09-21', isActive: 0 });
  const endsNow = await seed({ rule: { interval: 1, unit: 'day', end: { type: 'on_date', date: '2026-09-24' } }, last: '2026-09-23' });

  const result = await run('2026-09-26');
  assert.equal(result.checked, 1, 'only the one active series is looked at');
  assert.deepEqual(await dues(paused), ['2026-09-20']);
  assert.deepEqual(await dues(endedEarlier), ['2026-09-21']);
  assert.deepEqual(await dues(endsNow), ['2026-09-23', '2026-09-24'], 'its final date (24th) is created, nothing after');
  assert.equal(result.ended, 1);
  assert.equal((await db.prepare('SELECT is_active FROM recurring_activities WHERE id = ?').get(endsNow)).is_active, 0);

  const later = await run('2026-09-27');
  assert.equal(later.checked, 0);
  assert.equal(later.created, 0);
});

test('Seven active series of every type due on 1 Jan 2027 — first run creates 7, second run creates 0', async () => {
  await isolate();
  // 1 Jan 2027 is a Friday.
  const series = await Promise.all([
    seed({ title: 'Daily', rule: { interval: 1, unit: 'day' }, last: '2026-12-31' }),
    seed({ title: 'Weekly Fri', rule: { interval: 1, unit: 'week', weekdays: [5] }, last: '2026-12-25' }),
    seed({ title: 'Business', rule: { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }, last: '2026-12-31' }),
    seed({ title: 'Monthly', rule: { interval: 1, unit: 'month', day_of_month: 1 }, last: '2026-12-01' }),
    seed({ title: 'Quarterly', rule: { interval: 3, unit: 'month', day_of_month: 1 }, last: '2026-10-01' }),
    seed({ title: 'Half-yearly', rule: { interval: 6, unit: 'month', day_of_month: 1 }, last: '2026-07-01' }),
    seed({ title: 'Yearly', rule: { interval: 12, unit: 'month', month: 1, day_of_month: 1 }, last: '2026-01-01' }),
  ]);
  const first = await run('2027-01-01');
  assert.equal(first.checked, 7);
  assert.equal(first.created, 7);
  const second = await run('2027-01-01');
  assert.equal(second.created, 0, 'no duplicates on a repeat run');
  for (const id of series) {
    const d = await dues(id);
    assert.equal(d.filter((x) => x === '2027-01-01').length, 1, 'exactly one 1 Jan task per series');
  }
  // The same run fired concurrently (a double-triggered cron) still leaves one row per series and date —
  // the unique index, not the in-code check, is what guarantees it.
  await isolate();
  await db.prepare(`UPDATE recurring_activities SET is_active = 1 WHERE id IN (${series.map(() => '?').join(',')})`).run(...series);
  const [a, b] = await Promise.all([run('2027-01-02'), run('2027-01-02')]);
  const total = await db.prepare(`SELECT COUNT(*) c FROM commitments WHERE due_date = '2027-01-02'`).get();
  assert.equal(total.c, 1, 'only the Daily series is due on Sat 2 Jan, and only once despite two simultaneous runs');
  assert.equal(a.failed + b.failed, 0);
});
