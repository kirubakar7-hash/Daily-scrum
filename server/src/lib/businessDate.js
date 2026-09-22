const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

// Asia/Kolkata is a fixed UTC+5:30 offset with no DST, so letting Intl's own timezone database do the
// conversion is both correct and simpler than hand-rolled offset math.
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** The current business calendar day ("YYYY-MM-DD") in India Standard Time — this is what "today" means
 *  everywhere in this app: Daily Scrum, due dates, delayed-task checks, recurring-task generation. A
 *  server process's own wall clock (UTC, on Vercel) is NOT the business day — for roughly 5.5 hours of
 *  every day (after 6:30pm UTC / before 12:00am IST rollover is really after 6:30pm UTC), the UTC calendar
 *  date already lags a day behind the real IST one, which silently made "today" wrong for that whole
 *  window before this existed. Distinct from a stored timestamp (always UTC, an instant — see db.js's
 *  now_utc()) and from display formatting (a UI concern) — this is specifically "which calendar day is it,
 *  right now, for the business." Accepts any instant so a caller can also ask "what business day did THIS
 *  timestamp fall on" (e.g. was a task completed on time in IST terms), not just "what day is it right now". */
export function getBusinessDate(instant = new Date()) {
  return dateFormatter.format(instant);
}

/** getBusinessDate() plus the IST wall-clock time-of-day, for the rare caller that needs more than the
 *  calendar day. Never used for date ARITHMETIC — recurrence.js's UTC-anchored calendar-day-string math
 *  (adding days/weeks/months to a "YYYY-MM-DD" string) is unrelated to and unaffected by this; that stays
 *  exactly as it is, since once a correct business date exists as a string, arithmetic on it is timezone-
 *  agnostic by construction. */
export function getBusinessDateTime(instant = new Date()) {
  return { date: getBusinessDate(instant), time: timeFormatter.format(instant) };
}
