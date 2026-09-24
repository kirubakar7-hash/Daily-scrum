// Writes an encrypted backup of the whole database to a file. Read-only against the database.
//   DATABASE_URL=... BACKUP_PASSPHRASE=... node scripts/backup.js backups/daily-scrum-2026-09-24.dsmb
// Locally, DATABASE_URL can come from server/.env. See BACKUP.md.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { checkPassphrase, connectWithRetry, createBackup, encrypt, resolveDatabaseUrl, scrubber } from './dbBackup.js';

// Every failure ends in one plain sentence — never a stack trace, which could carry connection details
// into a public workflow log.
function fail(message) {
  console.error(`Backup failed: ${message}`);
  process.exit(1);
}

const outFile = process.argv[2];
if (!outFile) fail('usage is node scripts/backup.js <output-file>');

let databaseUrl;
try {
  databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL);
  checkPassphrase(process.env.BACKUP_PASSPHRASE);
} catch (e) {
  fail(e.message);
}
const scrub = scrubber(databaseUrl);

let client;
try {
  client = await connectWithRetry(() => new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 30_000 }), { scrub });
  const backup = await createBackup(client);
  const file = encrypt(Buffer.from(JSON.stringify(backup)), process.env.BACKUP_PASSPHRASE);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, file);
  const counts = Object.entries(backup.tables).map(([t, rows]) => `${t} ${rows.length}`).join(', ');
  console.log(`Backup written: ${outFile} (${(file.length / 1024).toFixed(1)} KB, encrypted)`);
  console.log(`Rows: ${counts}`);
} catch (e) {
  fail(scrub(e.message));
} finally {
  await client?.end().catch(() => {});
}
