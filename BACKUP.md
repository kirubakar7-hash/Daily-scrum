# Backing up and restoring Daily Scrum Monitoring

## Why this exists

The production database is one SQLite file on a single Railway volume. Nothing
backs it up automatically today — losing that volume means losing every team,
task, and history record permanently. This is the highest-priority reliability
gap identified in the September 2026 audit (see `CLAUDE.md` §21).

## Manual backup (do this regularly until automation is set up)

From the project folder:

```powershell
railway volume files --volume e59788d2-3cb0-4986-a471-67f1b26195b0 download /scrum.db "backups/scrum-<date>.db"
```

Replace `<date>` with today's date (e.g. `scrum-2026-09-15.db`). Keep several
dated copies, not just the latest one — if a bad write corrupts the live
database, you want a backup from *before* that happened, not just the most
recent one.

**A backup isn't a real backup until it's been test-restored.** After
downloading, sanity-check it:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('backups/scrum-<date>.db',{readOnly:true}); console.log('users:', db.prepare('SELECT COUNT(*) c FROM users').get().c);"
```

If that prints a sensible user count, the backup is good.

## Restoring from a backup

1. Stop the Railway service (or accept brief downtime during the swap).
2. Upload the backup file over the live one:
   ```powershell
   railway volume files --volume e59788d2-3cb0-4986-a471-67f1b26195b0 upload "backups/scrum-<date>.db" "/scrum.db" --overwrite
   ```
3. Also overwrite `/scrum.db-wal` and `/scrum.db-shm` with matching empty
   files (a stale WAL from the old data can override your restored file's
   contents otherwise — this bit us once already during initial setup):
   ```powershell
   node -e "require('fs').writeFileSync('backups/empty.db-wal','')"
   railway volume files --volume e59788d2-3cb0-4986-a471-67f1b26195b0 upload "backups/empty.db-wal" "/scrum.db-wal" --overwrite
   ```
4. Restart the service:
   ```powershell
   railway restart --service daily-scrum-monitoring
   ```
5. Log in and verify: check the Dashboard's user count matches what you
   expect, spot-check a few real records in History.

## Disaster recovery checklist

**Application won't load / is down:**
1. Check `railway logs --latest` for errors.
2. Check Railway's own status page for a platform-wide outage.
3. `railway restart --service daily-scrum-monitoring`.

**Data looks wrong / corrupted:**
1. Stop writes immediately — tell everyone to stop using the app.
2. Identify the most recent backup you're confident is good.
3. Restore it following the steps above.
4. Verify thoroughly before telling people to resume using the app.
5. Note what happened and when, so the cause can be investigated later.

## Known limitation — read this honestly

This is a **manual** process right now, not automatic. Per the project's own
charter (`CLAUDE.md` §21): "Do NOT claim automated disaster recovery if it
does not exist." It doesn't exist yet. A backup only exists if someone
actually runs the command above and keeps the file somewhere safe — ideally
not only on the same computer as everything else.

The real fix is a scheduled, automatic backup that runs on its own (e.g. a
GitHub Actions workflow on a cron schedule, since that's free and doesn't
depend on any one computer being on). That requires a GitHub account for this
project, which doesn't exist yet — worth setting up as the next step.
