import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH lets a production deploy point this at a mounted persistent volume (e.g. Fly.io's /data) —
// without it, the database would live on the container's disposable filesystem and vanish on every
// restart/redeploy. Left unset, this falls back to the same local path used in dev.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'scrum.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const rawDb = new DatabaseSync(DB_PATH);
rawDb.exec('PRAGMA journal_mode = WAL');
rawDb.exec('PRAGMA foreign_keys = ON');

// Thin wrapper so route code (written against better-sqlite3's API) works unchanged.
const stmtCache = new Map();
export const db = {
  exec: (sql) => rawDb.exec(sql),
  prepare: (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = rawDb.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
    };
  },
  // Wraps a multi-statement write sequence so a thrown error rolls everything back instead of leaving
  // some statements committed and others not — SQLite auto-commits each statement individually otherwise.
  transaction: (fn) => {
    rawDb.exec('BEGIN');
    try {
      const result = fn();
      rawDb.exec('COMMIT');
      return result;
    } catch (e) {
      rawDb.exec('ROLLBACK');
      throw e;
    }
  },
};

// Only needed by tests, which open a throwaway temp-file database per run and need the underlying file
// handle released before they can clean that temp directory up — the running app itself never closes
// this, it stays open for the process's whole life.
export function closeDb() {
  rawDb.close();
}

// Migration: re-add 'in_progress' to commitments.status — this app used to have it, removed it, and now
// needs it back for the Pending -> In Progress -> Completed workflow. SQLite can't ALTER a CHECK
// constraint, and unlike the migration above this must preserve real rows (not just drop-when-empty), so
// this does a proper FK-safe table rebuild: copy every row in rowid order (history.js's "TSK-000123" codes
// are derived from rowid, so preserving row order keeps every existing code stable), then swap the table in.
// Columns are listed explicitly (not SELECT *) because the live table's physical column order doesn't match
// the base CREATE TABLE text below — task_type_id/category_id/original_due_date were added later via ALTER
// TABLE and physically sit at the end of the real table regardless of where they're written here.
{
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='commitments'`).get();
  if (row && !row.sql.includes(`'in_progress'`)) {
    const cols = [
      'id', 'employee_id', 'scrum_date', 'description', 'type', 'recurring_activity_id', 'priority',
      'expected_outcome', 'start_date', 'due_date', 'original_due_date', 'due_time', 'estimated_effort',
      'dependency', 'dependency_owner', 'remarks', 'status', 'completion_pct', 'completed_at',
      'carried_forward_from_id', 'carried_forward_to_id', 'non_completion_reason', 'non_completion_explanation',
      'non_completion_dependency', 'non_completion_dependency_owner', 'new_target_date', 'recovery_action',
      'leader_intervention_note', 'is_leader_support_task', 'is_active', 'created_at', 'updated_at',
      'created_by', 'updated_by', 'task_type_id', 'category_id',
    ].join(', ');
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS commitments_new;
      CREATE TABLE commitments_new (
        id TEXT PRIMARY KEY,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_by TEXT,
        updated_by TEXT,
        task_type_id TEXT REFERENCES task_types(id),
        category_id TEXT REFERENCES categories(id)
      );
      INSERT INTO commitments_new (${cols}) SELECT ${cols} FROM commitments ORDER BY rowid;
      DROP TABLE commitments;
      ALTER TABLE commitments_new RENAME TO commitments;
      CREATE INDEX IF NOT EXISTS idx_commitments_emp_date ON commitments(employee_id, scrum_date);
      PRAGMA foreign_keys = ON;
    `);
    const problems = db.prepare('PRAGMA foreign_key_check').all();
    if (problems.length) console.error('[migration] commitments rebuild left dangling FKs:', problems);
  }
}

db.exec('DROP TABLE IF EXISTS leader_assessments');

// Migration: add original_due_date if this is an existing commitments table from before Carry Forward existed.
// The current `due_date` moves when a task is carried forward; `original_due_date` never changes after creation.
{
  const tableExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='commitments'`).get();
  if (tableExists) {
    const cols = db.prepare(`PRAGMA table_info(commitments)`).all();
    if (!cols.some((c) => c.name === 'original_due_date')) {
      db.exec(`ALTER TABLE commitments ADD COLUMN original_due_date TEXT`);
      db.exec(`UPDATE commitments SET original_due_date = due_date WHERE original_due_date IS NULL`);
    }
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS task_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  mechanic TEXT NOT NULL CHECK(mechanic IN ('recurring','adhoc')),
  is_protected INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  leader_user_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  job_title TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_super_admin_protected INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_by TEXT
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
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  priority TEXT NOT NULL DEFAULT 'Medium',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_by TEXT,
  task_type_id TEXT REFERENCES task_types(id),
  category_id TEXT REFERENCES categories(id)
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  escalation_date TEXT NOT NULL DEFAULT (date('now')),
  required_action TEXT,
  target_resolution_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution_date TEXT,
  resolution_remarks TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS scrum_sessions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  scrum_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
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
CREATE INDEX IF NOT EXISTS idx_requests_requested_by ON requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_requests_resolved_by ON requests(resolved_by);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON audit_logs(changed_at);
`);

// Migration: the Blocker and Achievement features were removed at the user's explicit request
// (2026-09-09) — including permanently deleting any existing records, which they confirmed after
// being warned this breaks the app's usual "never delete business data" rule. `actions` and
// `escalations` are unrelated features and are untouched.
db.exec(`DROP TABLE IF EXISTS blockers`);
db.exec(`DROP TABLE IF EXISTS achievements`);

// Migration: the Department feature was removed at the user's explicit request (2026-09-09), after
// confirming only one already-inactive, unused department existed — no real org data was lost. Drop the
// FK columns before the table itself so no reference is left dangling. Teams and Users keep everything else.
{
  const teamCols = db.prepare(`PRAGMA table_info(teams)`).all();
  if (teamCols.some((c) => c.name === 'department_id')) {
    db.exec(`ALTER TABLE teams DROP COLUMN department_id`);
  }
  const userCols = db.prepare(`PRAGMA table_info(users)`).all();
  if (userCols.some((c) => c.name === 'department_id')) {
    db.exec(`ALTER TABLE users DROP COLUMN department_id`);
  }
  db.exec(`DROP TABLE IF EXISTS departments`);
}

// Migration: add task_type_id if this is an existing commitments table from before the Type master existed.
// `type` ('recurring'/'adhoc') stays the source of truth for every existing query and the repeat engine —
// task_type_id just records which named type (from the admin-managed list) was picked, for display/reporting.
{
  const cols = db.prepare(`PRAGMA table_info(commitments)`).all();
  if (!cols.some((c) => c.name === 'task_type_id')) {
    db.exec(`ALTER TABLE commitments ADD COLUMN task_type_id TEXT REFERENCES task_types(id)`);
  }
}

// Migration: recurring_activities gained task_type_id/priority when the admin-managed Recurring Tasks
// master was added, so each generated occurrence can carry the right type and priority forward.
{
  const cols = db.prepare(`PRAGMA table_info(recurring_activities)`).all();
  if (!cols.some((c) => c.name === 'task_type_id')) {
    db.exec(`ALTER TABLE recurring_activities ADD COLUMN task_type_id TEXT REFERENCES task_types(id)`);
  }
  if (!cols.some((c) => c.name === 'priority')) {
    db.exec(`ALTER TABLE recurring_activities ADD COLUMN priority TEXT NOT NULL DEFAULT 'Medium'`);
  }
}

// Migration: add category_id (2026-09-09) — Category is an additional, independent classification from
// Task Type: it answers "what area of the business is this for" (e.g. Finance, Compliance), separate from
// whether the task repeats. commitments.category_id is the source of truth; recurring_activities.category_id
// exists so each generated occurrence can carry the chosen category forward, same as task_type_id/priority.
{
  const commitmentCols = db.prepare(`PRAGMA table_info(commitments)`).all();
  if (!commitmentCols.some((c) => c.name === 'category_id')) {
    db.exec(`ALTER TABLE commitments ADD COLUMN category_id TEXT REFERENCES categories(id)`);
  }
  const recurringCols = db.prepare(`PRAGMA table_info(recurring_activities)`).all();
  if (!recurringCols.some((c) => c.name === 'category_id')) {
    db.exec(`ALTER TABLE recurring_activities ADD COLUMN category_id TEXT REFERENCES categories(id)`);
  }
}

// Migration: recurring_activities gained a full recurrence rule (repeat every N days/weeks/months, specific
// weekdays, an end condition) when the calendar-style recurrence picker replaced the fixed frequency list.
// `frequency` stays populated as a human-readable label — display code that only reads that string still works.
{
  const cols = db.prepare(`PRAGMA table_info(recurring_activities)`).all();
  if (!cols.some((c) => c.name === 'recurrence_rule')) {
    db.exec(`ALTER TABLE recurring_activities ADD COLUMN recurrence_rule TEXT`);
  }
  if (!cols.some((c) => c.name === 'series_start_date')) {
    db.exec(`ALTER TABLE recurring_activities ADD COLUMN series_start_date TEXT`);
    db.exec(`UPDATE recurring_activities SET series_start_date = substr(created_at, 1, 10) WHERE series_start_date IS NULL`);
  }
  if (!cols.some((c) => c.name === 'occurrences_created')) {
    db.exec(`ALTER TABLE recurring_activities ADD COLUMN occurrences_created INTEGER NOT NULL DEFAULT 1`);
  }
}

// Migration: audit_logs gained owner_id/owner_name so an entry can independently record whose task it
// was, separate from changed_by (who made the edit) — needed once Leaders can act on other people's
// tasks, so the trail reads "Leader X did Y to Employee Z's task" instead of just "X did Y".
{
  const cols = db.prepare(`PRAGMA table_info(audit_logs)`).all();
  if (!cols.some((c) => c.name === 'owner_id')) {
    db.exec(`ALTER TABLE audit_logs ADD COLUMN owner_id TEXT REFERENCES users(id)`);
  }
  if (!cols.some((c) => c.name === 'owner_name')) {
    db.exec(`ALTER TABLE audit_logs ADD COLUMN owner_name TEXT`);
  }
}

// Migration: token_version lets requireAuth reject a token signed against an older version, so resetting
// a compromised account's password actually revokes its already-issued sessions instead of leaving a
// stolen token valid for the rest of its 12h life. A counter (compared for equality) rather than a
// changed-at timestamp deliberately avoids a timestamp-precision edge case: both a JWT's `iat` and
// SQLite's datetime('now') only carry second-level precision, so a login and a reset happening within the
// same wall-clock second could otherwise leave the old token looking no older than the new one.
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === 'token_version')) {
    db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`);
  }
}

// Migration: teams.name gains the same UNIQUE constraint task_types.name and categories.name already have.
// SQLite can't ALTER a column into UNIQUE in place, so this rebuilds the table — but only once it's
// confirmed there are no existing duplicate names to conflict with (a small, real org's data always wins
// over enforcing this constraint; skip quietly and log if a rebuild would fail).
{
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='teams'`).get();
  if (row && !row.sql.includes('name TEXT NOT NULL UNIQUE')) {
    const dupes = db.prepare(`SELECT lower(name) n, COUNT(*) c FROM teams GROUP BY lower(name) HAVING c > 1`).all();
    if (dupes.length > 0) {
      console.error('[migration] Skipping teams.name UNIQUE constraint — duplicate team names exist:', dupes.map((d) => d.n));
    } else {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE IF EXISTS teams_new;
        CREATE TABLE teams_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          leader_user_id TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_by TEXT,
          updated_by TEXT
        );
        INSERT INTO teams_new SELECT * FROM teams;
        DROP TABLE teams;
        ALTER TABLE teams_new RENAME TO teams;
        PRAGMA foreign_keys = ON;
      `);
      const problems = db.prepare('PRAGMA foreign_key_check').all();
      if (problems.length) console.error('[migration] teams rebuild left dangling FKs:', problems);
    }
  }
}

// Seed the two protected task types the app's recurrence engine and dashboard split rely on — every
// installation needs at least one active type per mechanic, so these can be renamed but not deleted.
{
  const count = db.prepare(`SELECT COUNT(*) c FROM task_types`).get().c;
  if (count === 0) {
    db.prepare(`INSERT INTO task_types (id, name, mechanic, is_protected) VALUES ('recurring-default', 'Recurring', 'recurring', 1)`).run();
    db.prepare(`INSERT INTO task_types (id, name, mechanic, is_protected) VALUES ('adhoc-default', 'Ad-hoc', 'adhoc', 1)`).run();
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function today() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
