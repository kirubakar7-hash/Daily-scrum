// Encrypted, restorable backups of the whole database — used by scripts/backup.js, scripts/restore.js and
// the nightly GitHub Actions workflow (.github/workflows/backup.yml). See BACKUP.md for how to use them.
//
// A backup file is: a short header, then the whole database as JSON, gzipped and encrypted with AES-256-GCM
// under a key derived (scrypt) from BACKUP_PASSPHRASE. GCM also detects a wrong passphrase or a damaged
// file, so a restore can never silently load garbage. The repository is public and the backups are stored
// next to it, so they must be unreadable without the passphrase.
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const MAGIC = Buffer.from('DSMBACKUP1\n');
export const FORMAT = 'daily-scrum-backup';

export function checkPassphrase(passphrase) {
  if (!passphrase || passphrase.length < 12) {
    throw new Error('BACKUP_PASSPHRASE must be set and at least 12 characters long.');
  }
  // These names are printed in the public workflow file — as a passphrase, anyone could guess them.
  if (['BACKUP_PASSPHRASE', 'DATABASE_URL'].includes(passphrase.trim())) {
    throw new Error('BACKUP_PASSPHRASE is set to a secret\'s name instead of a real passphrase. Choose a long, private passphrase.');
  }
}

/** The connection string from a pasted secret, with the usual copy-paste slips (surrounding spaces or
 *  quotes, a leading "DATABASE_URL=") tidied up. Anything else wrong is reported without echoing the value,
 *  since this runs in public workflow logs. */
export function resolveDatabaseUrl(raw) {
  let value = (raw || '').trim();
  if (!value) throw new Error('DATABASE_URL is not set.');
  if (/[\r\n]/.test(value)) {
    throw new Error('DATABASE_URL has more than one line in it. It must hold only the connection string (one line, starting with postgresql://).');
  }
  value = value.replace(/^DATABASE_URL\s*=\s*/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string. It should look like postgresql://user:password@host/database?sslmode=require.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error(`DATABASE_URL must be a PostgreSQL connection string (postgresql://…), not ${url.protocol.replace(':', '')}.`);
  }
  return value;
}

/** Hides the parts of a connection string that must never reach a (public) log. */
export function scrubber(connectionString) {
  const url = new URL(connectionString);
  const hide = [url.password, decodeURIComponent(url.password), url.username, url.hostname].filter((v) => v && v.length > 2);
  return (message) => hide.reduce((m, v) => m.split(v).join('***'), String(message));
}

/** Connects, retrying a few times: Neon's Free plan suspends the database when idle, and a nightly run is
 *  often the first connection in hours. */
export async function connectWithRetry(makeClient, { attempts = 4, delayMs = 10_000, log = console.log, scrub = (m) => m } = {}) {
  for (let attempt = 1; ; attempt++) {
    const client = makeClient();
    try {
      await client.connect();
      return client;
    } catch (e) {
      await client.end().catch(() => {});
      const reason = scrub(e.message);
      if (attempt >= attempts) throw new Error(`Could not connect to the database after ${attempts} tries: ${reason}`);
      log(`Database not reachable yet (${reason}) — retrying in ${delayMs / 1000}s (${attempt}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function encrypt(plain, passphrase) {
  checkPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

export function decrypt(file, passphrase) {
  checkPassphrase(passphrase);
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a Daily Scrum backup file.');
  let at = MAGIC.length;
  const salt = file.subarray(at, (at += 16));
  const iv = file.subarray(at, (at += 12));
  const tag = file.subarray(at, (at += 16));
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  decipher.setAuthTag(tag);
  try {
    return zlib.gunzipSync(Buffer.concat([decipher.update(file.subarray(at)), decipher.final()]));
  } catch {
    throw new Error('Could not open the backup — the passphrase is wrong, or the file is damaged.');
  }
}

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

async function tableNames(client) {
  const { rows } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name
  `);
  return rows.map((r) => r.table_name);
}

/** Every row of every table, read in one read-only snapshot so the copy is consistent even while people
 *  keep using the app. */
export async function createBackup(client) {
  const backup = { format: FORMAT, version: 1, created_at: new Date().toISOString(), tables: {} };
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    for (const table of await tableNames(client)) {
      backup.tables[table] = (await client.query(`SELECT * FROM ${quote(table)}`)).rows;
    }
  } finally {
    await client.query('COMMIT');
  }
  return backup;
}

/** Loads a backup into an EMPTY database (or Neon branch): creates the tables with the app's own migration,
 *  then inserts every row in one transaction — all or nothing. Refuses outright if the target already has
 *  users or tasks, so it can never overwrite a live database. */
export async function restoreBackup(client, backup, migrationSql) {
  if (backup?.format !== FORMAT) throw new Error('This is not a Daily Scrum backup.');
  await client.query(migrationSql);
  const { rows: [existing] } = await client.query('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM commitments) AS n');
  if (Number(existing.n) > 0) {
    throw new Error('The target database already has users or tasks. Restore only into a new, empty database or Neon branch (see BACKUP.md).');
  }

  const targetTables = new Set(await tableNames(client));
  const unknown = Object.keys(backup.tables).filter((t) => !targetTables.has(t));
  if (unknown.length) throw new Error(`The backup has tables this version of the app doesn't: ${unknown.join(', ')}.`);

  // Parents before children, from the database's own foreign keys. A column pointing at its own table
  // (a user's manager, a task's carried-forward link) is filled in afterwards, once every row exists.
  const { rows: fks } = await client.query(`
    SELECT conrelid::regclass::text AS child, a.attname AS col, confrelid::regclass::text AS parent
    FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
    WHERE con.contype = 'f' AND con.connamespace = current_schema()::regnamespace
  `);
  const unq = (name) => name.replace(/^.*\./, '').replace(/"/g, '');
  const selfColumns = {};
  const parentsOf = {};
  for (const fk of fks) {
    const child = unq(fk.child);
    const parent = unq(fk.parent);
    if (child === parent) (selfColumns[child] ||= []).push(fk.col);
    else (parentsOf[child] ||= new Set()).add(parent);
  }
  const order = [];
  const visit = (table, path = new Set()) => {
    if (order.includes(table) || path.has(table)) return;
    path.add(table);
    for (const parent of parentsOf[table] || []) visit(parent, path);
    order.push(table);
  };
  [...targetTables].sort().forEach((t) => visit(t));

  const counts = {};
  await client.query('BEGIN');
  try {
    for (const table of [...order].reverse()) await client.query(`DELETE FROM ${quote(table)}`); // just the migration's default rows
    for (const table of order) {
      const rows = backup.tables[table] || [];
      counts[table] = rows.length;
      if (rows.length === 0) continue;
      const deferred = selfColumns[table] || [];
      const columns = Object.keys(rows[0]);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const params = [];
        const tuples = chunk.map((row) => `(${columns.map((c) => { params.push(deferred.includes(c) ? null : row[c]); return `$${params.length}`; }).join(', ')})`);
        await client.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES ${tuples.join(', ')}`, params);
      }
      for (const col of deferred) {
        for (const row of rows) {
          if (row[col] != null) await client.query(`UPDATE ${quote(table)} SET ${quote(col)} = $1 WHERE id = $2`, [row[col], row.id]);
        }
      }
    }
    // Auto-numbered columns (commitments.seq) continue after the highest restored value.
    const { rows: serials } = await client.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_default LIKE 'nextval(%'
    `);
    for (const { table_name: t, column_name: c } of serials) {
      await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quote(c)}) FROM ${quote(t)}), 1), (SELECT MAX(${quote(c)}) FROM ${quote(t)}) IS NOT NULL)`, [quote(t), c]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return counts;
}
