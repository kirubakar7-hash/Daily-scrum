import 'dotenv/config';
import { db } from './db.js';

// Full data reset: removes every business record and every user except the
// protected Super Admin account, so the app starts genuinely empty and the
// Super Admin builds the organization (teams, people) from the UI.

if (process.env.NODE_ENV === 'production' && process.argv[2] !== '--force') {
  console.error('Refusing to reset a production database without --force. This permanently deletes all business data.');
  console.error(`It would run against: ${process.env.DB_PATH || '(local default path)'}`);
  process.exit(1);
}

const superAdmins = await db.prepare('SELECT id, full_name, email FROM users WHERE is_super_admin_protected = 1').all();

if (superAdmins.length === 0) {
  console.error('No protected Super Admin account found — refusing to reset. Run `npm run seed` first, or promote a user manually.');
  process.exit(1);
}
if (superAdmins.length > 1) {
  console.error('More than one protected Super Admin account found — refusing to reset until this is resolved manually.');
  process.exit(1);
}

const superAdmin = superAdmins[0];

console.log('Resetting all data. Keeping only Super Admin:', superAdmin.full_name, `(${superAdmin.email})`);

const wipeTables = [
  'audit_logs',
  'escalations',
  'actions',
  'requests',
  'commitments',
  'scrum_sessions',
  'recurring_activities',
  'system_settings',
];

for (const table of wipeTables) {
  await db.exec(`DELETE FROM ${table}`);
}

// Custom task types and categories are part of this org's setup, same as teams — reset them too,
// but keep the two built-in task types (Recurring/Ad-hoc) the app's repeat engine and dashboard math
// depend on existing.
await db.exec(`DELETE FROM task_types WHERE is_protected = 0`);
await db.exec(`DELETE FROM categories`);

// users.team_id -> teams.id and teams.leader_user_id -> users.id form a cycle,
// so null out both sides before deleting either table.
await db.exec('UPDATE users SET team_id = NULL');
await db.exec('UPDATE teams SET leader_user_id = NULL');
await db.exec('DELETE FROM teams');
await db.prepare('DELETE FROM users WHERE id != ?').run(superAdmin.id);

const remainingUsers = (await db.prepare('SELECT COUNT(*) c FROM users').get()).c;
console.log(`Done. ${remainingUsers} user remains (the Super Admin). All other data has been removed.`);
console.log(`Log in as ${superAdmin.email} to create teams and people from the Admin screen.`);
