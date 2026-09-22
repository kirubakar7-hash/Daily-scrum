import { getBusinessDate } from './businessDate.js';

/** How many days past due a task is right now, based on its current (possibly carried-forward) due date. Never negative.
 *  asOfDate is always a "YYYY-MM-DD" business-date string (today(), IST) — no timezone conversion needed here. */
export function withDelay(row, asOfDate) {
  if (!row.due_date) return { ...row, delay_days: 0 };
  const dueMs = new Date(row.due_date).getTime();
  const asOfMs = new Date(asOfDate).getTime();
  const days = Math.round((asOfMs - dueMs) / 86400000);
  return { ...row, delay_days: days > 0 ? days : 0 };
}

/** For a completed task, how many days late it was finished — 0 if it wasn't late. Compares calendar
 *  days only: due_date is a date-only string, but completed_at is a full UTC timestamp, so this derives a
 *  date-only day from it first — otherwise a task finished later in the day on its own due date gets
 *  rounded up to "1 day late" even though it was completed on time. That derived day must be the IST
 *  calendar day (getBusinessDate), not completed_at's raw UTC date: someone completing a task at, say,
 *  1am IST has a completed_at whose UTC calendar date is still the PREVIOUS day, which used to make an
 *  on-time-in-India completion look a day earlier (or a genuinely late one look on-time) than it really was. */
export function withLateness(row) {
  if (!row.due_date || !row.completed_at) return { ...row, days_late: 0 };
  const dueMs = new Date(row.due_date).getTime();
  const doneMs = new Date(getBusinessDate(new Date(row.completed_at))).getTime();
  const days = Math.round((doneMs - dueMs) / 86400000);
  return { ...row, days_late: days > 0 ? days : 0 };
}
