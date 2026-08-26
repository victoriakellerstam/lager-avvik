# lager-avvik

A mockup for the warehouse/back-office team ("lageravdelingen") who clean up
order discrepancies ("avvik"). **This page is internal only - purchasers
("innkjøpere") never see it.** The intended real-world flow is: a purchaser
gets a single weekly email about their discrepancy and does as little as
possible; if they reply or otherwise flag something, that becomes a comment
on the avvik here. It exists to show the concept, not to send anything real:

- All avvik data is still seeded test data (`src/mockData.js`) - nothing here
  reads real avvik from `dwh` yet. A Minato Link named `dwh` is attached
  (`local_port: 1433`), and `src/dwh.js` can open a real SQL Server
  connection through it (`POST /api/dwh/test-connection`, with a matching
  "Test tilkobling til dwh" button on the dashboard) to prove connectivity
  end to end. It runs `SELECT 1` and nothing else - no real avvik query yet.
- No email is ever sent. The weekly job only builds an email *preview*
  (subject + body) and logs it, so you can see who would have been emailed
  and what it would have said.
- Discrepancy types match the real scenario catalog ("SCENARIOER OG
  ANBEFALTE TILTAK"): Ikke mottatt faktura i Medius, Internbestilling,
  Kostnadsfaktura — reverser, Kredittkort lisenskjøp/feilaktig mottatt,
  Manuell ordre, Ordre opprettet med feilaktig distributør, Spesielle caser -
  Finance, and Varefaktura — under behandling. Each has its own color-coded
  badge (`src/typeBadges.js`) and its own instruction steps
  (`src/instructions.js`), derived from the recommended actions for that
  scenario.
- The email template (`src/notify.js` + `src/instructions.js`) follows the
  shape: which order, what the discrepancy is, the numbered actions required
  from the purchaser, and who to contact with questions (Finance). Each
  avvik row shows how many times it's been notified, the full history of who
  was notified and when, and a "Vis e-posteksempel" button to preview/hide
  the exact email for that avvik on demand.
- The top of the page shows counts (total / open / resolved) and the top 3
  purchasers by number of avvik, so the team can see where to focus.
- Avvik are split into three views: an "Åpne avvik" list (top, with filters
  by order, purchaser, and discrepancy type - client-side, and they combine),
  a "Spesielle caser - Finance" table, and a collapsed "Arkiv" of resolved
  avvik at the bottom (its date column shows when each was resolved, not
  when it was last notified). Finance cases are never emailed to a purchaser
  (`src/financeTypes.js` - `needsNotification` skips them entirely), so
  instead of an email-preview column that table shows a "Fremgangsmåte"
  (resolution procedure) built from the same instruction steps that would
  otherwise go in an email.
- State is in-memory and resets when the process restarts.
- Each avvik has a comment thread, showing who wrote each comment. There's no
  login, so whoever adds one (the team, or a stand-in for a purchaser's
  reply) types their own name. A real inbound-email-to-comment pipeline isn't
  built - see "What's deliberately not here yet" below.
- The UI uses Intility's real [Bifrost design system](https://bifrost.intility.com/)
  (`@intility/bifrost-css`, loaded via CDN in `src/dashboard.js`), forced into
  dark mode (`data-bf-color-mode="dark"`). For a production app this should be
  self-hosted instead of pulled from unpkg - see Bifrost's own CSS install docs.

## Run it locally

Requires Node.js 22.

```sh
npm install
npm start
```

There is no committed `package-lock.json` right now: this repo was built on a
machine with no Node/npm available, so the lockfile for the `mssql` dependency
couldn't be generated and verified locally. `npm install` resolves it fresh.
Regenerate and commit a real lockfile (`npm install` then commit the result)
the next time someone with Node touches this repo.

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
| `GET` | `/api/notifications` | Log of simulated email previews (who was notified, when). Not shown on the dashboard anymore, still available for inspection. |
| `POST` | `/api/jobs/run-weekly` | Manually trigger the weekly check (demo only). |
| `POST` | `/api/avvik/:id/comments` | Add a comment (`{"author": "...", "text": "..."}`). |
| `GET` | `/api/avvik/:id/preview-email` | Render the exact email template for one avvik, regardless of whether it's currently due. |
| `POST` | `/api/dwh/test-connection` | Open a real connection to `dwh` through the Minato Link and run `SELECT 1`. |

## What's deliberately not here yet

This is step one. Turning it into the real thing needs decisions and platform
setup that are out of scope for a mockup:

- **Real avvik data from `dwh`.** The network path now exists (Minato Link
  `dwh`, connectivity verified), but the app still doesn't query real avvik -
  we haven't decided which table/view holds the avvik data, which columns
  map to purchaser name/email, or how "Spesielle caser - Finance" is
  identified in that data.
- **`aa-x-s-14`.** No link exists for this server yet.
- **Real email sending.** Not decided yet — options are Microsoft Graph /
  Exchange Online, an internal SMTP relay (needs a Link, since SMTP isn't port
  443), or a third-party API like SendGrid (needs an egress rule + API key
  secret).
- **Turning a purchaser's reply into a comment.** Today a comment is just a
  free-text field anyone with access to this page can fill in. Making a real
  email reply land here automatically needs an inbound mail pipeline (e.g. a
  shared mailbox polled via Microsoft Graph) - not built.
- **Persistent storage.** The in-memory store here would become a Minato
  managed Postgres database (already scoped for this app) so avvik and
  notification history survive restarts.
- **Scheduling.** Minato has no built-in cron. The in-process weekly timer in
  `src/scheduler.js` needs the app kept warm (`minScale: 1`) instead of
  scaling to zero.

## Environment

- `PORT` — port to listen on (defaults to `8080`; Minato sets this).
- `MINATO_LINK_DWH_ADDR` — injected by the attached `dwh` Minato Link
  (`host:port`, currently `127.0.0.1:1433`). Never hardcode this value; read
  it at runtime, since it's only guaranteed for as long as the link stays
  attached this way.
- `DWH_USER` — SQL Server username for `dwh` (non-secret, set via `minato_deploy`/`minato_set_app` `env`).
- `DWH_DATABASE` — database name on `dwh` (non-secret, same as above).
- `LAGER_AVVIK` (secret) — the `DWH_USER` password. Pinned via `minato_set_app.secrets`; never passed through MCP as a value.
