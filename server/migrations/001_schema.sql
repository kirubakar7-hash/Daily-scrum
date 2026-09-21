-- Daily Scrum Monitoring — PostgreSQL schema
-- Translated from the SQLite schema in server/src/db.js. Dates are kept as TEXT in the exact
-- 'YYYY-MM-DD HH:MM:SS' (UTC) format SQLite's datetime('now') produced, since the app's date-math
-- library (lib/delay.js) does string comparisons on these values — changing the format would silently
-- break lateness/overdue calculations across the whole app.

CREATE OR REPLACE FUNCTION now_utc() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS');
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION today_utc() RETURNS TEXT AS $$
  SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD');
$$ LANGUAGE sql;

-- Reproduces SQLite's datetime('now', '-30 days')-style relative offsets, used by the dashboard's
-- 30-day-scoped "repeated support requests" / "high ad-hoc workload" signals.
CREATE OR REPLACE FUNCTION now_utc_offset(days_offset INTEGER) RETURNS TEXT AS $$
  SELECT to_char((now() AT TIME ZONE 'utc') + (days_offset || ' days')::interval, 'YYYY-MM-DD HH24:MI:SS');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS task_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mechanic TEXT NOT NULL CHECK(mechanic IN ('recurring','adhoc')),
  is_protected INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT
);

-- A grouping layer between Category and individual tasks — e.g. Category "Finance" contains several Main
-- Tasks like "FP&A" or "Accounts Payable", each of which contains several actual assignable tasks
-- (Subtasks). Modeled on categories' own shape; category_id is what "parked under a category" means.
CREATE TABLE IF NOT EXISTS main_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category_id TEXT REFERENCES categories(id),
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  leader_user_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('super_admin','admin','leader','employee','senior_management')),
  team_id TEXT REFERENCES teams(id),
  -- Who this person reports to, for the view/edit hierarchy in lib/scope.js — separate from team_id
  -- (which is just a dashboard grouping) since a manager chain and a team grouping don't always coincide.
  manager_id TEXT REFERENCES users(id),
  job_title TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_super_admin_protected INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT,
  -- Predates token_version (which now does the actual session-revocation work) and no current route
  -- reads or writes it — kept anyway, same as commitments.leader_intervention_note, since it holds real
  -- recorded history and dropping unused-but-populated data isn't this project's call to make silently.
  password_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT now_utc(),
  reason TEXT,
  owner_id TEXT REFERENCES users(id),
  owner_name TEXT
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS recurring_activities (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'Daily',
  recurrence_rule TEXT,
  series_start_date TEXT,
  occurrences_created INTEGER NOT NULL DEFAULT 1,
  task_type_id TEXT REFERENCES task_types(id),
  category_id TEXT REFERENCES categories(id),
  main_task_id TEXT REFERENCES main_tasks(id),
  priority TEXT NOT NULL DEFAULT 'Medium',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  -- SQLite's implicit, always-present rowid had no direct Postgres equivalent (Postgres's own row
  -- identifier, ctid, isn't stable across VACUUM/updates) — this stands in for it. history.js derives
  -- each task's permanent "TSK-000123" display code from this column; it must never be renumbered.
  seq BIGSERIAL,
  employee_id TEXT NOT NULL REFERENCES users(id),
  scrum_date TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('recurring','adhoc')),
  recurring_activity_id TEXT REFERENCES recurring_activities(id),
  priority TEXT NOT NULL DEFAULT 'Medium',
  expected_outcome TEXT,
  start_date TEXT,
  due_date TEXT,
  original_due_date TEXT,
  due_time TEXT,
  estimated_effort TEXT,
  dependency TEXT,
  dependency_owner TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','support_required')),
  completion_pct INTEGER,
  completed_at TEXT,
  carried_forward_from_id TEXT REFERENCES commitments(id),
  carried_forward_to_id TEXT REFERENCES commitments(id),
  non_completion_reason TEXT,
  non_completion_explanation TEXT,
  non_completion_dependency TEXT,
  non_completion_dependency_owner TEXT,
  new_target_date TEXT,
  recovery_action TEXT,
  leader_intervention_note TEXT,
  is_leader_support_task INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT,
  task_type_id TEXT REFERENCES task_types(id),
  category_id TEXT REFERENCES categories(id),
  main_task_id TEXT REFERENCES main_tasks(id)
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  commitment_id TEXT NOT NULL REFERENCES commitments(id),
  type TEXT NOT NULL CHECK(type IN ('support','due_date_change')),
  requested_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT,
  explanation TEXT,
  requested_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT,
  leader_note TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc()
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  scrum_date TEXT NOT NULL,
  description TEXT NOT NULL,
  owner TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium',
  source TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed')),
  completion_date TEXT,
  remarks TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  issue TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES users(id),
  activity_id TEXT REFERENCES commitments(id),
  escalated_by TEXT,
  escalated_to TEXT,
  escalation_date TEXT NOT NULL DEFAULT today_utc(),
  required_action TEXT,
  target_resolution_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution_date TEXT,
  resolution_remarks TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS scrum_sessions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  scrum_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT now_utc(),
  updated_at TEXT NOT NULL DEFAULT now_utc(),
  UNIQUE(employee_id, scrum_date)
);

CREATE INDEX IF NOT EXISTS idx_commitments_emp_date ON commitments(employee_id, scrum_date);
CREATE INDEX IF NOT EXISTS idx_actions_emp_date ON actions(employee_id, scrum_date);
CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_requests_commitment ON requests(commitment_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_commitments_status_due ON commitments(status, due_date);
CREATE INDEX IF NOT EXISTS idx_commitments_category ON commitments(category_id);
CREATE INDEX IF NOT EXISTS idx_commitments_task_type ON commitments(task_type_id);
CREATE INDEX IF NOT EXISTS idx_commitments_recurring_activity ON commitments(recurring_activity_id);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS idx_requests_requested_by ON requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_requests_resolved_by ON requests(resolved_by);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON audit_logs(changed_at);
CREATE INDEX IF NOT EXISTS idx_commitments_main_task ON commitments(main_task_id);
CREATE INDEX IF NOT EXISTS idx_main_tasks_category ON main_tasks(category_id);

-- Seed the two protected task types the app's recurrence engine and dashboard split rely on — every
-- installation needs at least one active type per mechanic, so these can be renamed but not deleted.
INSERT INTO task_types (id, name, mechanic, is_protected) VALUES ('recurring-default', 'Recurring', 'recurring', 1) ON CONFLICT (id) DO NOTHING;
INSERT INTO task_types (id, name, mechanic, is_protected) VALUES ('adhoc-default', 'Ad-hoc', 'adhoc', 1) ON CONFLICT (id) DO NOTHING;
