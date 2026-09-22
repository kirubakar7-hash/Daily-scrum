# Putting Daily Scrum Monitoring online, 24/7

> **This app's real production deployment today is Vercel + Neon Postgres** (`https://daily-scrum-one.vercel.app`),
> not Fly.io — see `vercel.json` and `api/index.js`. Everything below this note describes the original
> Fly.io path and is kept for reference/an alternative hosting option, but doesn't reflect where the live
> app actually runs. Vercel needs no separate deploy walkthrough: pushing to `main` auto-deploys, and the
> only manual step is setting `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=production`, and `CRON_SECRET` as
> real environment variables in the Vercel project's settings (`.env.example` documents each one).

This walks through moving the app from "runs on my computer while Claude has it open" to
"has its own permanent web address, stays on by itself." It uses **Fly.io** — a small
hosting service that runs your app in the cloud and keeps it running.

Everything up to now (the code) is ready. The steps below are things only you can do,
since they involve creating an account and (a small amount of) real money.

**Cost:** a machine this size plus 1GB of storage typically runs a few dollars a month.
Check Fly's current pricing (fly.io/pricing) before you commit — it does change.

---

## One-time setup

**1. Install the Fly command-line tool.** Open PowerShell and run:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
```

Close and reopen your terminal afterwards so it's on your PATH.

**2. Create a Fly account (or log in if you already have one):**

```bash
fly auth signup
```

This opens your browser to sign up. If you already have an account, use `fly auth login` instead.

---

## First deploy

Run these from this project's folder (`C:\Users\BKirubakar\Repos\Scrum Monitoring`).

**3. Register the app on your account.** The project already has a `fly.toml` and a
`Dockerfile` describing how to build and run it, so this just needs to confirm them:

```bash
fly launch --no-deploy --copy-config --yes
```

If it says the name `daily-scrum-monitoring` is already taken by someone else, open
`fly.toml` and change the `app = "..."` line to something else, then run the command again.

**4. Point it at a real PostgreSQL database** — the app no longer uses a local file, so there's
no volume to create here. Get a free connection string from [neon.com](https://neon.com) (or
any PostgreSQL host) and set it on Fly (this is stored encrypted, not in any file):

```bash
fly secrets set DATABASE_URL=paste-your-postgres-connection-string-here
```

**5. Generate a real login secret** (this replaces the placeholder the code uses for local
testing — it's what keeps people from forging a login):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the long string it prints, then set it on Fly the same way:

```bash
fly secrets set JWT_SECRET=paste-the-long-string-here
```

**6. Deploy:**

```bash
fly deploy
```

This builds the app and starts it. When it finishes:

```bash
fly open
```

opens your new, permanent web address in a browser. That address works from anywhere,
any time — not just while your computer is on.

---

## Bringing your existing data across (optional)

A brand-new Postgres database starts empty — a fresh install would need you to log in as
Super Admin and rebuild your teams/people from scratch. If you'd rather keep what's already
in an existing database (your real users, teams, categories, history), point `DATABASE_URL`
at that same database instead of a new one — there's no file to copy, since PostgreSQL is a
network database your app connects to, not a local file this machine holds.

---

## Everyday updates

Any time you make more changes to the code and want them live, just run:

```bash
fly deploy
```

from this folder again. Your data on the volume is untouched by a redeploy.

---

## What changed in the code to make this possible

- The server now also serves the built frontend, so the whole app is one deployable thing
  with one address (`server/src/index.js`).
- The database, the port, and the login secret are now all configurable via environment
  variables instead of being hardcoded — `DATABASE_URL`, `PORT`, `JWT_SECRET`, `CORS_ORIGIN`
  (see `.env.example` for what each one does).
- The server refuses to start in production if `JWT_SECRET` is still the local-dev
  placeholder, so this can't accidentally go live insecurely. `CORS_ORIGIN` is different: it's
  only relevant if the frontend is ever split onto a separate domain from the API, so it's
  optional even in production (see `.env.example`).
