# lager-avvik

A mockup that demonstrates how weekly discrepancy ("avvik") notifications to
purchasers ("innkjøpere") could work. It exists to show the concept, not to
send anything real:

- All data is seeded test data (`src/mockData.js`). Nothing here reads from
  `dwh` or `aa-x-s-14`.
- No email is ever sent. The weekly job only builds an email *preview*
  (subject + body) and logs it, so you can see who would have been emailed
  and what it would have said.
- State is in-memory and resets when the process restarts.

## Run it locally

Requires Node.js 22.

```sh
npm install
npm start
```

Then open `http://localhost:8080`. The dashboard lists the mock avvik, lets
you mark one resolved, and has a "run weekly job now" button so you don't
have to wait a week to see the notification logic fire.

## Test

```sh
npm test
```

Tests cover the pure decision logic (`src/notify.js`: who is due for a
reminder, and that a resolved avvik stops getting them) and the weekly job
(`src/job.js`: it only notifies what's due, and doesn't double-notify if run
twice back to back). No database or network access is needed to run them.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check. |
| `GET` | `/` | Dashboard (HTML). |
| `GET` | `/api/avvik` | List mock avvik. |
| `POST` | `/api/avvik/:id/resolve` | Mark one resolved. |
| `GET` | `/api/notifications` | Log of simulated email previews. |
| `POST` | `/api/jobs/run-weekly` | Manually trigger the weekly check (demo only). |

## What's deliberately not here yet

This is step one. Turning it into the real thing needs decisions and platform
setup that are out of scope for a mockup:

- **Real data from `dwh` and `aa-x-s-14`.** These are internal servers, so the
  app can't reach them by default. A tenant admin needs to install a
  [Minato Link](https://intility.github.io/minato/) agent on a server that can
  reach them, then the app attaches to that link. This also means deciding
  exactly which tables/views hold the avvik data and the purchaser's email.
- **Real email sending.** Not decided yet — options are Microsoft Graph /
  Exchange Online, an internal SMTP relay (needs a Link, since SMTP isn't port
  443), or a third-party API like SendGrid (needs an egress rule + API key
  secret).
- **Persistent storage.** The in-memory store here would become a Minato
  managed Postgres database (already scoped for this app) so avvik and
  notification history survive restarts.
- **Scheduling.** Minato has no built-in cron. The in-process weekly timer in
  `src/scheduler.js` needs the app kept warm (`minScale: 1`) instead of
  scaling to zero.

## Environment

- `PORT` — port to listen on (defaults to `8080`; Minato sets this).

No secrets or non-secret environment values are required for this mockup.
