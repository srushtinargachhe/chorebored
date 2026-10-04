# 🏡 chorebored

Cute chore board: New / In progress / Done, epics with subtasks, daily recurring tasks,
multiple people, points, and weekly/monthly/quarterly rewards.

**Stack:** Node + Express + SQLite (one file DB) + a single static HTML page. No build step.

## Run locally
    npm install && npm start      # http://localhost:3000

## Host it
Any host that runs Node or Docker works. The only thing to persist is the SQLite file.
- **Render / Railway / Fly.io:** deploy this folder (uses the Dockerfile), attach a persistent
  disk/volume mounted at `/data`. DB lives at `/data/chores.db` (set via `DB_PATH`).
- **Home server / Pi:** `docker build -t choreboard . && docker run -d -p 80:3000 -v choreboard:/data choreboard`

## How it works
- Moving a task to **Done** gives its points to the assignee (unassigned tasks earn nothing). Moving it back removes them.
- **Daily tasks** reset to New automatically on the first load of a new day (set `TZ` env var to your timezone).
- Rewards compare each person's points this week (Mon–Sun), month, or quarter to the target.
- Data is shared by anyone with the URL: no login yet, so keep it on your home network or add basic auth at the host.

## Accounts
First visit shows "create the first account" (that person is the admin). The admin adds everyone else from
Rewards → "+ Add person" (name, username, password). Everyone can edit their own profile (tap your name, top right).
Passwords are hashed (scrypt); sessions last 30 days. For internet hosting, use HTTPS.

## Deploy on Vercel (free) with Turso
1. Create a free database at turso.tech, then copy its URL (`libsql://...`) and create a token.
2. In Vercel → Project → Settings → Environment Variables add `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
   and `APP_TZ` (your timezone, e.g. `Asia/Kolkata`). Redeploy.
Tables are created automatically on the first request. Locally it still uses the `chores.db` file.

## Joining & staying logged in
The login screen has a "Create an account" link. Set `HOUSEHOLD_CODE` (any phrase) in your host's environment variables
and new people must enter it to register; if it's unset, anyone with the link can register. The first account is the admin.
Logins last a year and renew on every visit.
