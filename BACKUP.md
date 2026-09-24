# Backing up and restoring Daily Scrum Monitoring

## How it works

The data lives in a Neon Postgres database. Neon's Free plan keeps only **6 hours** of restore history, so
anything older can't be recovered from Neon itself. To cover that, a GitHub Actions workflow
(`.github/workflows/backup.yml`) takes a full backup **every night at about 02:00 IST** and keeps each one
for **30 days**.

- Every table is copied in one consistent, read-only snapshot — the app keeps working while it runs.
- Each backup is **encrypted** (AES-256) with a passphrase only you hold. The GitHub repository is public,
  so the backup files can be downloaded by others — without the passphrase they are unreadable.
- Right after taking it, the workflow opens the backup again to prove it isn't damaged. A failed backup
  shows as a red ✗ on the repository's **Actions** tab, and GitHub emails the repository owner.

## One-time setup (you do this — it needs your secrets)

1. Choose a long passphrase (at least 12 characters; a sentence of 4–5 random words works well) and save it
   in your password manager. **If it is lost, no backup can ever be opened.**
2. On GitHub, open the repository → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**, and add **two separate secrets** — one name and one value each:
   - Name `DATABASE_URL`, value: **only** the connection string, on one line, starting with
     `postgresql://`. Get it from the Neon console → your project → **Connect** (Vercel may not show the
     value of a sensitive variable). Don't include the name, quotes, or anything else.
   - Name `BACKUP_PASSPHRASE`, value: the passphrase from step 1 (not the word BACKUP_PASSPHRASE).
   The workflow checks both and says exactly which one is missing or malformed — without ever showing them.
3. Open the **Actions** tab → **Nightly database backup** → **Run workflow** once, and check it ends with a
   green ✓. From then on it runs by itself every night.

GitHub pauses scheduled workflows in a public repository after **60 days without any commits**. If the
project goes quiet for that long, re-enable the workflow on the Actions tab.

## Getting a backup

Actions tab → **Nightly database backup** → pick a run → **Artifacts** → download
`daily-scrum-backup-…`. It downloads as a zip; inside is one `daily-scrum-YYYY-MM-DD.dsmb` file.

To check a backup opens and see what it contains (no database needed), from the `server` folder:

```powershell
$env:BACKUP_PASSPHRASE = "your passphrase"
node scripts/restore.js path\to\daily-scrum-2026-09-24.dsmb --check
```

You can also take a backup yourself at any time (reads `DATABASE_URL` from `server/.env`):

```powershell
$env:BACKUP_PASSPHRASE = "your passphrase"
node scripts/backup.js backups\daily-scrum-manual.dsmb
```

## Restoring

A restore only ever goes into a **new, empty** database — never over the live one. The restore script
refuses any database that already has users or tasks, and it uses its own setting
(`RESTORE_DATABASE_URL`) so it can't pick up the production address by accident.

1. In the Neon console, create a new empty database (or a new project) and copy its connection string.
2. From the `server` folder:
   ```powershell
   $env:BACKUP_PASSPHRASE = "your passphrase"
   $env:RESTORE_DATABASE_URL = "the NEW database's connection string"
   node scripts/restore.js path\to\daily-scrum-2026-09-24.dsmb
   ```
   It creates the tables, loads every row in one step (all or nothing), and prints how many rows each
   table received.
3. In Vercel → Settings → Environment Variables, change `DATABASE_URL` to the new database's connection
   string, then redeploy.
4. Log in and check: the users, recent tasks and recurring tasks you expect are there.

The old database is left untouched throughout, so switching back is just a matter of restoring the old
`DATABASE_URL`.

## If something goes wrong

**Data looks wrong or was deleted by mistake:**
1. Ask everyone to stop using the app.
2. If it happened within the last 6 hours, Neon's own restore (console → Branches → Restore) is fastest.
3. Otherwise pick the latest nightly backup from *before* the problem and follow **Restoring** above.
4. Check thoroughly before telling people to carry on.

**App is down:** check the Vercel dashboard (Deployments, Logs) and Neon's status — a Free-plan database
is suspended, not deleted, if it runs out of its monthly allowance.

## Honest limits

- Backups are nightly, so anything entered after the last one (up to a day) is only covered by Neon's
  6-hour history.
- Each backup is kept 30 days.
- Everything above depends on the two secrets being set. Until then, **no automatic backup runs**.
