import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPassphrase, connectWithRetry, resolveDatabaseUrl, scrubber } from '../scripts/dbBackup.js';

// The nightly backup runs in a PUBLIC repository's Actions log, from secrets pasted in by hand — so it must
// catch the common paste mistakes with a clear message, and never echo a secret while doing so.
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = 'postgresql://app_user:s3cr3t-Pa55@ep-quiet-sky-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';

test('resolveDatabaseUrl — accepts a connection string and tidies up paste slips', () => {
  assert.equal(resolveDatabaseUrl(GOOD), GOOD);
  assert.equal(resolveDatabaseUrl(`  ${GOOD}  `), GOOD, 'surrounding spaces');
  assert.equal(resolveDatabaseUrl(`"${GOOD}"`), GOOD, 'surrounding quotes, as in a .env file');
  assert.equal(resolveDatabaseUrl(`DATABASE_URL=${GOOD}`), GOOD, 'a pasted "DATABASE_URL=" line');
  assert.equal(resolveDatabaseUrl(GOOD.replace('postgresql:', 'postgres:')), GOOD.replace('postgresql:', 'postgres:'));
});

test('resolveDatabaseUrl — rejects what cannot be a single Postgres connection string, without echoing it', () => {
  const cases = [
    ['', /not set/],
    [`${GOOD}\nBACKUP_PASSPHRASE\nsomething-private`, /more than one line/],
    ['BACKUP_PASSPHRASE', /not a valid connection string/],
    ['mysql://u:p@host/db', /PostgreSQL connection string/],
    ['file:./server/data/scrum.db', /PostgreSQL connection string/],
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => resolveDatabaseUrl(value), (e) => {
      assert.match(e.message, expected);
      assert.ok(!e.message.includes('s3cr3t') && !e.message.includes('something-private'), 'no secret in the message');
      return true;
    });
  }
});

test('checkPassphrase — refuses a secret\'s name used as the passphrase', () => {
  assert.throws(() => checkPassphrase('BACKUP_PASSPHRASE'), /secret's name/);
  assert.throws(() => checkPassphrase('DATABASE_URL'), /at least 12|secret's name/);
  assert.throws(() => checkPassphrase('short'), /at least 12/);
  assert.doesNotThrow(() => checkPassphrase('four random words here'));
});

test('scrubber — hides the password, user and host from any message', () => {
  const scrub = scrubber(GOOD);
  const message = scrub('connect ECONNREFUSED ep-quiet-sky-123456-pooler.us-east-2.aws.neon.tech as app_user with s3cr3t-Pa55');
  assert.ok(!message.includes('s3cr3t-Pa55') && !message.includes('app_user') && !message.includes('ep-quiet-sky'), message);
});

test('connectWithRetry — retries a sleeping database, then succeeds; gives up clearly after the limit', async () => {
  let calls = 0;
  const flaky = () => ({ connect: async () => { if (++calls < 3) throw new Error('Connection terminated unexpectedly'); }, end: async () => {} });
  const client = await connectWithRetry(flaky, { delayMs: 1, log: () => {} });
  assert.ok(client);
  assert.equal(calls, 3);

  const down = () => ({ connect: async () => { throw new Error('getaddrinfo ENOTFOUND secret-host.neon.tech'); }, end: async () => {} });
  await assert.rejects(
    () => connectWithRetry(down, { attempts: 2, delayMs: 1, log: () => {}, scrub: (m) => m.replace('secret-host.neon.tech', '***') }),
    (e) => /after 2 tries/.test(e.message) && !e.message.includes('secret-host'),
  );
});

test('backup.js — a malformed DATABASE_URL fails with one clear line and never prints the value', () => {
  let output = '';
  try {
    execFileSync(process.execPath, ['scripts/backup.js', 'unused.dsmb'], {
      cwd: serverDir, encoding: 'utf8', stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: `${GOOD}\nBACKUP_PASSPHRASE`, BACKUP_PASSPHRASE: 'four random words here', DOTENV_CONFIG_PATH: 'nonexistent.env' },
    });
    assert.fail('should have failed');
  } catch (e) {
    output = `${e.stdout}${e.stderr}`;
    assert.equal(e.status, 1);
  }
  assert.match(output, /Backup failed: DATABASE_URL has more than one line/);
  assert.ok(!output.includes('s3cr3t-Pa55') && !output.includes('ep-quiet-sky'), 'the secret is not in the output');
  assert.ok(!/\n\s+at /.test(output), 'no stack trace');
});
