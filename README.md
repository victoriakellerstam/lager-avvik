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
- **Arkiv** is every case that has been an avvik and no longer is. `dwh` has
  no status-history table, so it can't be derived from `dwh` alone: the app
  remembers which rows it has seen as open avvik and archives a row once it
  stops coming back from a sync. That is also how a case closes in the real
  world - an order line sits at `order_status` 3030 ("mottat") until it gets
  matched against a supplier invoice line, then it leaves 3030 and stops being
  an avvik. A row going missing from the sync is therefore the expected signal,
  not an error, and it's archived right away. Its "Løst" date is the first sync
  where the row was seen gone, since dwh can't tell us the real resolution date.
  - An auto-archived row reopens by itself if it reappears in a later sync (a
    status blip, or dwh disagreeing with itself) - showing a genuinely open
    avvik in the archive would be worse. One that a person resolved with
    "Marker løst" stays resolved regardless; only they can reopen it.
  - Consequence: the archive reflects what this app has been running and
    watching, so it fills up over time instead of starting out complete.
    Checked against `dwh` on 2026-10-01: of the 2026-onward order lines
    received more than 21 days ago, only 4 are no longer 3030 and the rest are
    still open - so an archive built from dwh alone would be 4 rows rather than
    a history. The 2026 cutoff (`MAIN_TABLE_CUTOFF_DATE` in
    `src/dwhQueries.js`) is what keeps this to orders from 2026 and later.
- The top of the page shows counts (total / open / resolved) and the top 3
  purchasers by number of avvik, so the team can see where to focus.
- Avvik are split into three views: an "Åpne avvik" list (top, with filters
  by order, purchaser, and discrepancy type - client-side, and they combine),
  a "Spesielle caser - Finance" table, and an always-visible "Arkiv" of
  resolved avvik (its date column shows when each was resolved, not when it
  was last notified). Finance cases are never emailed to a purchaser
  (`src/financeTypes.js` - `needsNotification` skips them entirely), so
  instead of an email-preview column that table shows a "Fremgangsmåte"
  (resolution procedure) built from the same instruction steps that would
  otherwise go in an email. The archive is sorted most-recently-resolved first,
  so it reads as a running history.
- Local state (comments, resolved/archived avvik, notification history) is
  persisted to `data/state.json`, so it survives a page refresh and a restart
  of the process. Everything derived from `dwh` is still re-fetched on every
  sync and is not persisted - except for archived avvik, whose dwh fields are
  kept as-is because `dwh` no longer returns those rows at all. See "Arkiv"
  below and "Local state" under Run it locally.
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

### Local state

Comments, resolved/archived avvik, manual purchaser corrections and the
notification log are written to `data/state.json` (git-ignored), so they survive
a page refresh and a restart - including `npm run dev` restarts on file save,
which used to throw all of it away. The file is written whole via a temp file
plus rename, so an interrupted write can't corrupt it; a corrupt or
unrecognized file is reported on startup and ignored rather than crashing the
app.

Override the path with `LAGER_AVVIK_STATE_FILE` if you want a separate state per
checkout, or to point a throwaway run somewhere else. Delete the file to reset
everything to empty (the next dwh sync repopulates the avvik themselves, with
no comments).

This is a plain local file on purpose - Postgres on Minato is the eventual
answer, but that filesystem is ephemeral, so this persistence does **not**
survive a redeploy. The read/write pair is isolated in `src/persistence.js` so
swapping in a database touches only that file.

### Local dwh access

`npm run dev` (instead of `npm start`) runs the app with `--watch` (restarts
on file changes) and loads a git-ignored `.env` if you have one. Locally,
`src/dwh.js` connects straight to the DWH SQL Server using your own Windows
identity - no username or password - as long as this process runs directly
on your Windows host (not in a container, which doesn't inherit that
identity). This only works when `MINATO_LINK_DWH_ADDR` is *not* set, which is
always true locally and never true when deployed to Minato; the two paths
never both apply. It needs the `msnodesqlv8` optional dependency (native,
Windows-only - `npm install` skips it harmlessly on other platforms) and the
Microsoft ODBC Driver for SQL Server installed on your machine. Nothing here
is secret, but you can still override the defaults (server
`g-datascience-3.gamma.xcv.net`, port `1433`, database `dwh`) with a local
`.env` file (copy `.env.example` to `.env`). The local connection also asks for
read-only intent, and the app only ever issues `SELECT`s:

```
DWH_LOCAL_SERVER=g-datascience-3.gamma.xcv.net
DWH_LOCAL_PORT=1433
DWH_LOCAL_DATABASE=dwh
```

This is a separate, local-only path from the Minato Link setup below -
deployed access to `dwh` is unaffected.

## Test

```sh
npm test
```

Tests cover the pure decision logic (`src/notify.js`: who is due for a
reminder, and that a resolved avvik stops getting them), the weekly job
(`src/job.js`: it only notifies what's due, and doesn't double-notify if run
twice back to back), and the store's merge rules (`src/store.js`: what a dwh
sync may and may not overwrite, and when a row is archived or reopened).
`test/persistence.test.js` exercises the real `data/state.json` round trip in an
OS temp directory - comments, resolved state and the notification log surviving
a simulated restart, plus corrupt/unknown-version files being ignored rather
than trusted. No database or network access is needed to run them.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness check. |
| `GET` | `/` | Dashboard (HTML). |
| `GET` | `/api/avvik` | List mock avvik. |
| `POST` | `/api/avvik/:id/resolve` | Mark one resolved. |
| `POST` | `/api/avvik/:id/reopen` | Move a resolved avvik back to the open list. |
| `POST` | `/api/avvik/:id/purchaser` | Manually set the purchaser on a "Sakseier ikke funnet" case (`{"name": "...", "email": "..."}`). |
| `POST` | `/api/dwh/refresh-avvik` | Run a dwh sync now (the same one that runs at startup). |
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
- **Persistent storage.** Comments and resolved/archived avvik now survive a
  restart via a local `data/state.json` (see "Local state" above), which is
  enough for local use but not for deployment - Minato's filesystem is
  ephemeral, so the real version needs the Minato managed Postgres database
  already scoped for this app.
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
- `DWH_LOCAL_SERVER`, `DWH_LOCAL_PORT`, `DWH_LOCAL_DATABASE` — local-only, Windows-integrated-auth path (see "Local dwh access" above). Not read at all when `MINATO_LINK_DWH_ADDR` is set. All three are non-secret and default to `g-datascience-3.gamma.xcv.net`, `1433`, `dwh`.
- `LAGER_AVVIK_STATE_FILE` — where local state is persisted (defaults to `data/state.json`). See "Local state" above.
