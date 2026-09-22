import { v4 as uuid } from 'uuid';
import { db, today } from '../db.js';
import { nextOccurrence } from './recurrence.js';
import { recordAudit } from './audit.js';

/** Inserts one new commitment as the next occurrence of a recurring series, bumps the series' occurrence
 *  count, and records it — shared by both the completion-triggered path (scrum.js, the moment someone
 *  finishes today's occurrence) and the schedule-triggered sweep below (generateDueOccurrences), so the
 *  two triggers can never drift into inserting slightly different rows for the same kind of event.
 *
 *  Both triggers independently check "does this occurrence already exist?" before calling this — but that
 *  check and this insert aren't atomic across two separate connections, so two overlapping calls (a
 *  retried/double-fired cron invocation, or the sweep racing an employee's completion at the same moment)
 *  can both pass their check and both land here for the same (activity, dueDate). idx_commitments_recurring_
 *  due_unique (001_schema.sql) is the real guarantee against a duplicate row, not the pre-checks — a
 *  unique-violation here means someone else just won that race, so this returns their row instead of
 *  erroring or silently creating a second one. */
export async function insertOccurrence({ activity, dueDate, template, changedBy, changedByName, reason }) {
  const newId = uuid();
  try {
    await db.transaction(async () => {
      await db.prepare(`
        INSERT INTO commitments (
          id, employee_id, scrum_date, description, type, recurring_activity_id, task_type_id, category_id, main_task_id, priority, expected_outcome,
          start_date, due_date, original_due_date, estimated_effort, dependency, dependency_owner, created_by, updated_by
        ) VALUES (?, ?, ?, ?, 'recurring', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId, template.employee_id, dueDate, template.description, activity.id, template.task_type_id, template.category_id, template.main_task_id, template.priority, template.expected_outcome || null,
        dueDate, dueDate, dueDate, template.estimated_effort || null, template.dependency || null, template.dependency_owner || null,
        changedBy, changedBy
      );
      await db.prepare('UPDATE recurring_activities SET occurrences_created = occurrences_created + 1 WHERE id = ?').run(activity.id);
    });
  } catch (e) {
    if (e.code === '23505') {
      const existing = await db.prepare('SELECT * FROM commitments WHERE recurring_activity_id = ? AND due_date = ? AND is_active = 1').get(activity.id, dueDate);
      if (existing) return existing;
    }
    throw e;
  }
  const inserted = await db.prepare('SELECT * FROM commitments WHERE id = ?').get(newId);
  await recordAudit({
    tableName: 'commitments', recordId: newId, fieldName: 'created', newValue: template.description,
    changedBy, changedByName, reason,
    ownerId: template.employee_id, ownerName: (await db.prepare('SELECT full_name FROM users WHERE id = ?').get(template.employee_id))?.full_name || null,
  });
  return inserted;
}

/** Walks a series forward from its last known due date to the single most recent occurrence date that
 *  is due by `asOf`, collapsing any dates skipped in between into that one date rather than materializing
 *  a separate row per missed date — a long-dormant Daily series gets one current, correctly-overdue task
 *  back, not a pile of backlog. Returns null if nothing is due yet, or if the walk lands past the series'
 *  own end condition (in which case `ended` is set on the returned marker instead).
 *
 *  nextOccurrence() checks an after_count end condition against activity.occurrences_created — the real
 *  row count in the database, which only changes once this walk actually inserts something. Passing the
 *  same frozen `activity` at every step of a multi-hop walk would leave that count stale for the whole
 *  walk, so a dormant count-limited series could overshoot its configured limit before the stale count
 *  ever caught up. Each step below simulates the count as it would stand immediately before that step's
 *  candidate — one higher than the last — so the end condition is checked as if each hop had really
 *  happened, exactly matching what the completion-triggered path sees one real hop at a time. */
function latestDueOccurrence(fromDate, activity, asOf) {
  let occurrencesSoFar = activity.occurrences_created || 1;
  const activityAt = (count) => ({ ...activity, occurrences_created: count });

  let candidate = nextOccurrence(fromDate, activityAt(occurrencesSoFar));
  if (candidate === null) return { ended: true };
  if (candidate > asOf) return null; // nothing due yet
  occurrencesSoFar++;

  for (;;) {
    const next = nextOccurrence(candidate, activityAt(occurrencesSoFar));
    if (next === null) return { date: candidate, ended: true }; // this occurrence is due, but it's also the series' last
    if (next > asOf) return { date: candidate, ended: false };
    candidate = next;
    occurrencesSoFar++;
  }
}

/** The schedule-triggered half of recurring generation, meant to run once a day regardless of what any
 *  employee does — see server/src/routes/cron.js. Previously the ONLY way a series advanced was an
 *  employee marking the current occurrence complete; a series nobody touched just stalled forever. This
 *  scans every active series and, for any whose last-known occurrence has fallen behind the recurrence
 *  rule, materializes the one current occurrence it's now due for — independent of whether the previous
 *  occurrence was ever completed. A series with nothing overdue (already caught up, or pre-generated
 *  ahead by the completion path) is left alone, so running this twice in one day is a no-op the second time. */
export async function generateDueOccurrences() {
  const date = today();
  const activities = await db.prepare('SELECT * FROM recurring_activities WHERE is_active = 1').all();
  let created = 0;
  let ended = 0;

  for (const activity of activities) {
    const last = await db.prepare(
      'SELECT * FROM commitments WHERE recurring_activity_id = ? AND is_active = 1 ORDER BY due_date DESC, created_at DESC LIMIT 1'
    ).get(activity.id);
    if (!last) continue; // every series is seeded with a commitment at creation — defensive skip if that's somehow missing
    if (last.due_date >= date) continue; // already current or pre-generated ahead — nothing to do

    const result = latestDueOccurrence(last.due_date, activity, date);
    if (!result) continue; // next scheduled date hasn't arrived yet

    if (result.date) {
      await insertOccurrence({
        activity, dueDate: result.date, template: last,
        changedBy: null, changedByName: 'System (scheduled recurrence)',
        reason: 'Automatic — generated on schedule, independent of the previous occurrence',
      });
      created++;
    }
    if (result.ended) {
      await db.prepare('UPDATE recurring_activities SET is_active = 0 WHERE id = ?').run(activity.id);
      ended++;
    }
  }

  return { checked: activities.length, created, ended };
}
