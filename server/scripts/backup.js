// Writes an encrypted backup of the whole database to a file. Read-only against the database.
//   DATABASE_URL=... BACKUP_PASSPHRASE=... node scripts/backup.js backups/daily-scrum-2026-09-24.dsmb
// Locally, DATABASE_URL can come from server/.env. See BACKUP.md.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { checkPassphrase, createBackup, encrypt } from './dbBackup.js';

const outFile = process.argv[2];
if (!outFile) {
  console.error('Usage: node scripts/backup.js <output-file>');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
checkPassphrase(process.env.BACKUP_PASSPHRASE);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const backup = await createBackup(client);
  const file = encrypt(Buffer.from(JSON.stringify(backup)), process.env.BACKUP_PASSPHRASE);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, file);
  const counts = Object.entries(backup.tables).map(([t, rows]) => `${t} ${rows.length}`).join(', ');
  console.log(`Backup written: ${outFile} (${(file.length / 1024).toFixed(1)} KB, encrypted)`);
  console.log(`Rows: ${counts}`);
} finally {
  await client.end();
}
