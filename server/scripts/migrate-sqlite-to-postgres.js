import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

// One-time migration: copies the real production data out of the Railway SQLite volume's backup file
// and into the Neon Postgres database this app is moving to. Run manually, once, against a freshly
// downloaded+checkpointed SQLite snapshot — never against the live Railway volume directly.
//
// Usage: node scripts/migrate-sqlite-to-postgres.js /path/to/scrum.db
//
// Safety:
// - Read-only against the SQLite source — never writes back to it.
// - Truncates the Postgres tables first. This is only safe because, at the time this script was written,
//   Neon held nothing but disposable demo data from `npm run seed` — never run this against a Postgres
//   database that already holds real data you want to keep.
// - Prints a before/after row count per table so a mismatch is caught immediately, not discovered later.

const sqlitePath = process.argv[2];
if (!sqlitePath) {
  console.error('Usage: node scripts/migrate-sqlite-to-postgres.js /path/to/scrum.db');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set (server/.env) — this writes to Postgres, not SQLite.');
  process.exit(1);
}

pg.types.setTypeParser(20, (val) => parseInt(val, 10)); // same bigint fix as db.js, for the row-count checks below

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
// A single dedicated client, not a Pool — every write below runs inside one BEGIN/COMMIT so a failure
// partway through rolls back cleanly instead of leaving a half-migrated database sitting in Postgres.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

function all(table, orderBy = 'rowid') {
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

// `SELECT *` never includes SQLite's implicit rowid — needed separately wherever it must be carried over.
function allWithRowid(table) {
  return sqlite.prepare(`SELECT *, rowid FROM ${table} ORDER BY rowid`).all();
}

async function insert(table, columns, rows) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
  for (const row of rows) {
    const values = columns.map((c) => (row[c] === undefined ? null : row[c]));
    await client.query(sql, values);
  }
  return rows.length;
}

async function pgCount(table) {
  const r = await client.query(`SELECT COUNT(*) c FROM ${table}`);
  return r.rows[0].c;
}

async function main() {
  console.log(`Reading from ${sqlitePath}...`);
  await client.connect();
  await client.query('BEGIN');

  console.log('\nTruncating Postgres tables (clearing demo/seed data)...');
  await client.query(`TRUNCATE users, teams, task_types, categories, recurring_activities, commitments,
    requests, actions, escalations, scrum_sessions, audit_logs, system_settings RESTART IDENTITY CASCADE`);

  // Dependency order: task_types/categories have no FKs out. users/teams reference each other (circular),
  // so users are inserted with team_id NULL first, teams second, then users.team_id is backfilled.
  // commitments self-references (carried_forward_from_id/to_id) for the same reason, backfilled after.

  console.log('\ntask_types...');
  // TRUNCATE above already cleared the two protected rows 001_schema.sql seeds on a fresh install, so
  // this insert (which includes the source's own 'recurring-default'/'adhoc-default' rows) hits an empty
  // table — no id conflict.
  const taskTypes = all('task_types');
  await insert('task_types', ['id', 'name', 'mechanic', 'is_protected', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by'], taskTypes);

  console.log('categories...');
  await insert('categories', ['id', 'name', 'description', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by'], all('categories'));

  console.log('users (team_id deferred)...');
  const users = all('users');
  await insert('users',
    ['id', 'full_name', 'email', 'password_hash', 'role', 'job_title', 'is_active', 'is_super_admin_protected',
      'token_version', 'created_at', 'updated_at', 'created_by', 'updated_by', 'password_changed_at'],
    users.map((r) => ({ ...r, team_id: undefined })));

  console.log('teams...');
  await insert('teams', ['id', 'name', 'leader_user_id', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by'], all('teams'));

  console.log('backfilling users.team_id...');
  for (const u of users) {
    if (u.team_id) await client.query('UPDATE users SET team_id = $1 WHERE id = $2', [u.team_id, u.id]);
  }

  console.log('recurring_activities...');
  await insert('recurring_activities',
    ['id', 'employee_id', 'title', 'frequency', 'recurrence_rule', 'series_start_date', 'occurrences_created',
      'task_type_id', 'category_id', 'priority', 'is_active', 'created_at', 'created_by'],
    all('recurring_activities'));

  console.log('commitments (self-refs deferred)...');
  // seq is set EXPLICITLY from the SQLite rowid, not left to BIGSERIAL's own auto-increment — a table
  // that's ever had a row deleted has a gap in its rowid sequence (e.g. 1-10, 12-24, no 11), and a fresh
  // dense BIGSERIAL can't reproduce that gap. Since history.js derives the permanent, user-facing
  // "TSK-000123" code from this column, letting it renumber densely would silently shift every code after
  // the gap by one — caught by an independent verification pass before this fix was made.
  const commitments = allWithRowid('commitments'); // rowid order, explicit rowid values preserved as seq below
  await insert('commitments',
    ['seq', 'id', 'employee_id', 'scrum_date', 'description', 'type', 'recurring_activity_id', 'priority', 'expected_outcome',
      'start_date', 'due_date', 'original_due_date', 'due_time', 'estimated_effort', 'dependency', 'dependency_owner',
      'remarks', 'status', 'completion_pct', 'completed_at', 'non_completion_reason', 'non_completion_explanation',
      'non_completion_dependency', 'non_completion_dependency_owner', 'new_target_date', 'recovery_action',
      'leader_intervention_note', 'is_leader_support_task', 'is_active', 'created_at', 'updated_at', 'created_by',
      'updated_by', 'task_type_id', 'category_id'],
    commitments.map((r) => ({ ...r, seq: r.rowid, carried_forward_from_id: undefined, carried_forward_to_id: undefined })));

  console.log('advancing the seq sequence past the highest explicitly-inserted value...');
  await client.query(`SELECT setval(pg_get_serial_sequence('commitments', 'seq'), COALESCE((SELECT MAX(seq) FROM commitments), 0))`);

  console.log('backfilling commitments carry-forward links...');
  for (const c of commitments) {
    if (c.carried_forward_from_id) await client.query('UPDATE commitments SET carried_forward_from_id = $1 WHERE id = $2', [c.carried_forward_from_id, c.id]);
    if (c.carried_forward_to_id) await client.query('UPDATE commitments SET carried_forward_to_id = $1 WHERE id = $2', [c.carried_forward_to_id, c.id]);
  }

  console.log('requests...');
  await insert('requests',
    ['id', 'commitment_id', 'type', 'requested_by', 'reason', 'explanation', 'requested_due_date', 'status',
      'resolved_by', 'resolved_at', 'leader_note', 'created_at', 'updated_at'],
    all('requests'));

  console.log('actions...');
  await insert('actions',
    ['id', 'employee_id', 'scrum_date', 'description', 'owner', 'due_date', 'priority', 'source', 'status',
      'completion_date', 'remarks', 'is_active', 'created_at', 'updated_at', 'created_by', 'updated_by'],
    all('actions'));

  console.log('escalations...');
  await insert('escalations',
    ['id', 'issue', 'employee_id', 'activity_id', 'escalated_by', 'escalated_to', 'escalation_date', 'required_action',
      'target_resolution_date', 'status', 'resolution_date', 'resolution_remarks', 'is_active', 'created_at',
      'updated_at', 'created_by', 'updated_by'],
    all('escalations'));

  console.log('scrum_sessions...');
  await insert('scrum_sessions', ['id', 'employee_id', 'scrum_date', 'status', 'completed_at', 'created_at', 'updated_at'], all('scrum_sessions'));

  console.log('audit_logs...');
  await insert('audit_logs',
    ['id', 'table_name', 'record_id', 'field_name', 'old_value', 'new_value', 'changed_by', 'changed_by_name',
      'changed_at', 'reason', 'owner_id', 'owner_name'],
    all('audit_logs'));

  console.log('system_settings...');
  await insert('system_settings', ['key', 'value', 'updated_at', 'updated_by'], all('system_settings', 'key'));

  console.log('\n--- Row count comparison (SQLite source -> Postgres, within the open transaction) ---');
  const tables = ['users', 'teams', 'task_types', 'categories', 'recurring_activities', 'commitments',
    'requests', 'actions', 'escalations', 'scrum_sessions', 'audit_logs', 'system_settings'];
  let allMatch = true;
  for (const t of tables) {
    const srcCount = sqlite.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    const dstCount = await pgCount(t);
    const match = srcCount === dstCount;
    if (!match) allMatch = false;
    console.log(`${t.padEnd(22)} source=${srcCount}  postgres=${dstCount}  ${match ? 'OK' : 'MISMATCH'}`);
  }

  if (allMatch) {
    await client.query('COMMIT');
    console.log('\nAll row counts match. Transaction committed.');
  } else {
    await client.query('ROLLBACK');
    console.log('\nMISMATCH DETECTED — transaction rolled back, Postgres is unchanged. Do not proceed to cutover.');
  }

  sqlite.close();
  await client.end();
  process.exit(allMatch ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  try { await client.query('ROLLBACK'); console.error('Transaction rolled back — Postgres is unchanged.'); } catch {}
  process.exit(1);
});
