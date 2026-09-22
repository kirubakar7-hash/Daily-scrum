const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

// Asia/Kolkata is a fixed UTC+5:30 offset with no DST, so letting Intl's own timezone database do the
// conversion is both correct and simpler than hand-rolled offset math.
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** "What calendar day is it right now, for the business" — India Standard Time, not the viewer's own
 *  browser/OS timezone and not `new Date().toISOString()`'s UTC (that's wrong for ~5.5 hours of every IST
 *  day). Mirrors server/src/lib/businessDate.js's getBusinessDate() exactly; duplicated rather than
 *  imported because client and server are separate bundles in this repo, same as every other client/lib
 *  file. Accepts any instant so it also works on a specific timestamp, not just "right now". */
export function getBusinessDate(instant = new Date()) {
  return dateFormatter.format(instant);
}

// The API sends timestamps in two different shapes depending which code path produced them: a proper ISO
// string like "2026-09-22T18:35:00.000Z" (from JS's own .toISOString()), or Postgres's now_utc()-produced
// "2026-09-22 18:35:00" — a space instead of 'T', no trailing 'Z'. Both are always UTC; only the second
// form is ambiguous to hand to `new Date(...)` directly (browsers can parse a bare "YYYY-MM-DD HH:MM:SS"
// as LOCAL time instead), so it's normalized to ISO+Z here before parsing.
function parseServerTimestamp(value) {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return new Date(iso);
}

/** Formats a server timestamp (either shape above) as its IST calendar day, "YYYY-MM-DD" — for displaying
 *  e.g. "completed on" dates without the UTC-vs-IST off-by-one a raw `.slice(0, 10)` has for anything that
 *  happened between 6:30pm and midnight UTC (12am–5:30am IST). */
export function formatBusinessDate(serverTimestamp) {
  const d = parseServerTimestamp(serverTimestamp);
  return d ? getBusinessDate(d) : null;
}

/** Formats a server timestamp as its IST time-of-day, "HH:MM" — for displaying e.g. scrum confirmation
 *  times to a team that works in IST, instead of the raw UTC time-of-day the API stores. */
export function formatBusinessTime(serverTimestamp) {
  const d = parseServerTimestamp(serverTimestamp);
  return d ? timeFormatter.format(d) : null;
}

/** Formats a server timestamp as a combined IST date + time, "YYYY-MM-DD HH:MM" — for full audit-trail
 *  entries (e.g. Audit Log), where showing the raw stored UTC string as-is would misstate both the day
 *  and the hour for anything that happened in the ~5.5-hour IST-vs-UTC gap. */
export function formatBusinessDateTime(serverTimestamp) {
  const d = parseServerTimestamp(serverTimestamp);
  return d ? `${getBusinessDate(d)} ${timeFormatter.format(d)}` : null;
}
