// Dropdown choices for each import template (see lib/excelTemplate.js and components/ImportButton.jsx),
// fetched fresh when the template is downloaded. Each list loads on its own: if one can't be fetched
// the template still downloads, just without that dropdown — or, for people, with only the current user.
import { api } from './api';

const PRIORITIES = ['Low', 'Medium', 'High'];
// The frequency names the Recurring Tasks import understands (server lib/recurrence.js legacyFrequencyToRule).
const FREQUENCIES = ['Daily', 'Business Week', 'Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'];
const ROLES = ['employee', 'leader', 'admin', 'senior_management', 'super_admin'];
const LEADER_ROLES = ['leader', 'admin', 'super_admin'];

const safe = (promise, fallback) => promise.catch(() => fallback);

async function catalogue() {
  const [users, taskTypes, mainTasks, activities] = await Promise.all([
    safe(api.get('/users/assignable').then((d) => d.users), null), // active people only, any role can read it
    safe(api.get('/task-types').then((d) => d.task_types), []),
    safe(api.get('/main-tasks').then((d) => d.main_tasks), []),
    safe(api.get('/task-activities').then((d) => d.task_activities), []),
  ]);
  const activeProcesses = mainTasks.filter((m) => m.is_active);
  const processName = new Map(activeProcesses.map((m) => [m.id, m.name]));
  return {
    users,
    taskTypes: taskTypes.filter((t) => t.is_active),
    processes: activeProcesses.map((m) => m.name),
    // [Process, Activity] — for the Activity dropdown that only shows the chosen Process's activities.
    activityPairs: activities.filter((a) => a.is_active && processName.has(a.main_task_id)).map((a) => [processName.get(a.main_task_id), a.name]),
  };
}

const byName = (list) => [...list].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

/** Team Tasks → Import (ad-hoc tasks, one person per row). */
export async function taskImportFields(currentUser) {
  const c = await catalogue();
  const people = c.users ? byName(c.users).map((u) => u.email) : [currentUser?.email].filter(Boolean);
  const reviewers = c.users ? byName(c.users.filter((u) => LEADER_ROLES.includes(u.role))).map((u) => u.email) : [];
  return {
    employee_email: { options: people, hint: 'Who the task is for.' },
    task_type_name: { options: c.taskTypes.filter((t) => t.mechanic === 'adhoc').map((t) => t.name), hint: 'Optional.' },
    main_task_name: { options: c.processes, hint: 'Pick the Process first — Activity then lists only its activities.' },
    activity_name: { dependsOn: 'main_task_name', pairs: c.activityPairs },
    reviewer_email: { options: reviewers, hint: "Optional — defaults to the person's manager." },
    priority: { options: PRIORITIES },
    due_date: { date: true, hint: 'Optional — today if left blank.' },
  };
}

/** Admin → Recurring Tasks → Import. */
export async function recurringImportFields() {
  const c = await catalogue();
  const people = c.users ? byName(c.users.filter((u) => ['employee', 'leader'].includes(u.role))).map((u) => u.email) : [];
  const reviewers = c.users ? byName(c.users.filter((u) => LEADER_ROLES.includes(u.role))).map((u) => u.email) : [];
  return {
    employee_emails: { options: people, multiple: true, hint: 'Pick one person, or type several emails separated by ;' },
    task_type_name: { options: c.taskTypes.filter((t) => t.mechanic === 'recurring').map((t) => t.name), hint: 'Optional.' },
    main_task_name: { options: c.processes, hint: 'Pick the Process first — Activity then lists only its activities.' },
    activity_name: { dependsOn: 'main_task_name', pairs: c.activityPairs },
    reviewer_email: { options: reviewers, hint: "Optional — defaults to each person's manager." },
    priority: { options: PRIORITIES },
    start_date: { date: true, hint: 'Optional — today if left blank.' },
    frequency: { options: FREQUENCIES },
  };
}

/** Admin → Users → Import. */
export async function userImportFields() {
  const teams = await safe(api.get('/teams').then((d) => d.teams), []);
  return {
    role: { options: ROLES },
    team_name: { options: teams.filter((t) => t.is_active !== 0).map((t) => t.name), hint: 'Optional.' },
  };
}

/** Admin → Activities → Import. */
export async function activityImportFields() {
  const c = await catalogue();
  return { main_task_name: { options: c.processes, hint: 'The Process this Activity belongs to.' } };
}

/** Admin → Task Types → Import. */
export async function taskTypeImportFields() {
  return { mechanic: { options: ['adhoc', 'recurring'], hint: 'adhoc = one-off; recurring = repeats on a schedule.' } };
}
