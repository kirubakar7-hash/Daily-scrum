// Opens an encrypted backup and either just checks it, or loads it into an EMPTY database. See BACKUP.md.
//
//   Check a backup (no database needed):
//     BACKUP_PASSPHRASE=... node scripts/restore.js <backup-file> --check
//   Restore into a new, empty database / Neon branch:
//     BACKUP_PASSPHRASE=... RESTORE_DATABASE_URL=... node scripts/restore.js <backup-file>
//
// The target is deliberately RESTORE_DATABASE_URL, never DATABASE_URL, and this script doesn't read .env —
// so it can't pick up the live production database by accident. It also refuses any database that already
// has users or tasks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { decrypt, restoreBackup } from './dbBackup.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/restore.js <backup-file> [--check]');
  process.exit(1);
}
const backup = JSON.parse(decrypt(fs.readFileSync(file), process.env.BACKUP_PASSPHRASE).toString('utf8'));
const summary = Object.entries(backup.tables).map(([t, rows]) => `${t} ${rows.length}`).join(', ');
console.log(`Backup taken ${backup.created_at}`);
console.log(`Rows: ${summary}`);
if (flag === '--check') process.exit(0);

if (!process.env.RESTORE_DATABASE_URL) {
  console.error('RESTORE_DATABASE_URL is not set — point it at a new, empty database or Neon branch.');
  process.exit(1);
}
const migrationSql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '001_schema.sql'), 'utf8');
const client = new pg.Client({ connectionString: process.env.RESTORE_DATABASE_URL });
await client.connect();
try {
  const counts = await restoreBackup(client, backup, migrationSql);
  console.log(`Restored: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
} finally {
  await client.end();
}
