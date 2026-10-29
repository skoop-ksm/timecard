# Timecard, web client

A web client for the Timecard punch clock, meant to sit next to the iPhone,
Apple Watch and Mac apps. It records when you start and stop work and shows
hours and pay per pay period. One user, one server, no accounts in the app
itself. Works as an installable web app on phones and as a normal page on
desktop.

No dependencies: Node 18 or newer is all it needs. Data lives in one JSON
file written atomically, so a backup is a file copy.

## What it does

- **Start / Stop** with the same rounding as the native apps: starts snap
  back to the previous grid mark, stops forward to the next (5 minutes by
  default, or 10, 15, 30, or off).
- **Start earlier…** when you forgot to punch in, **Adjust start…** while
  running, and **Add past entry…** for any day.
- Tap any entry to edit it. Start and stop times have **− / +** buttons that
  nudge by one grid step. Entries that end after midnight are handled.
- **History** by pay period with hours, pay and days worked, previous/next
  navigation and **Export CSV** (one line per day: date, hours, decimal
  hours, amount, same columns as the native export).
- **Settings**: hourly rate, currency, pay period (monthly with a start day,
  weekly with a start weekday, or every two weeks from a chosen date),
  rounding grid, and a one-click JSON backup.
- Light and dark theme follow the system. Keeps itself in sync across open
  tabs and devices by refreshing on focus and once a minute.

Left out on purpose: Siri, the Watch app, iCloud sync and the timeQplus
integration. Two-way sync with the native apps through CloudKit is planned;
the store behind `lib/store.js` is the seam for it.

## Run it

```bash
node server.js
```

Then open <http://127.0.0.1:8787>. Environment variables:

| Variable         | Default            | Purpose                                                        |
|------------------|--------------------|----------------------------------------------------------------|
| `PORT`           | `8787`             | Listen port                                                    |
| `HOST`           | `127.0.0.1`        | Bind address (`0.0.0.0` inside a container)                    |
| `DATA_DIR`       | `./data`           | Folder for `timecard.json`                                     |
| `TIMECARD_TOKEN` | unset              | If set, `POST /api/punch` requires `Authorization: Bearer …`   |

Tests: `node test/run.js`. Regenerate the PNG icons: `node scripts/make-icons.js`.

## Deploy

Same pattern as aracari: every push to `main` that touches `web/` runs the
tests, builds `ghcr.io/skoop-ksm/timecard:prod` on GitHub's runners, and a
self-hosted runner on the home server pulls and restarts it, waits for the
container to be healthy, and rolls back to the previous image if it is not
(`.github/workflows/deploy.yml`).

The container joins redbird's compose network, so redbird's `cloudflared`
reaches it at `http://timecard:8787`. No host ports are published.

### One-time server setup

1. **Runner**: register a self-hosted runner against this repo with the label
   `timecard`, the way redbird's `server-bootstrap.sh` did for redbird
   (Settings → Actions → Runners → New self-hosted runner). Runners are per
   repo on a personal account.
2. **Files**:
   ```bash
   sudo mkdir -p /srv/timecard/data
   sudo cp deploy/compose.yml /srv/timecard/compose.yml
   sudo cp deploy/env.prod.example /srv/timecard/.env.prod   # then set TIMECARD_TOKEN
   sudo chown -R $USER:docker /srv/timecard && sudo chown 1000:1000 /srv/timecard/data
   sudo chmod 750 /srv/timecard && sudo chmod 640 /srv/timecard/.env.prod
   ```
3. **Tunnel hostname**: Zero Trust → Networks → Tunnels → redbird → Public
   hostnames → add `timecard.redbird.party` → `http://timecard:8787`.
4. **Access**: Zero Trust → Access → Applications → self-hosted app for that
   hostname, policy allowing your email, long session. The app has no login of
   its own, so this is the front door. Add a bypass or service-token policy for
   the path `/api/punch` if you want Shortcuts to punch without a browser.
5. **Backup**: copy `deploy/timecard-backup.sh` to `/usr/local/bin` and add it
   to root's crontab after aracari's. It copies the one JSON file and keeps
   30 days.
6. Push to `main` (or re-run the workflow). The first deploy creates the
   container.

### Install on the phone

Open the hostname in Safari or Chrome and use "Add to Home Screen". It
launches full-screen with its own icon.

### Punching from Shortcuts, Siri, or scripts

`POST /api/punch` toggles (or takes `{"action":"in"}` / `{"action":"out"}`)
and rounds on the server's clock. Send the `TIMECARD_TOKEN` as a bearer token:

```bash
curl -X POST https://timecard.redbird.party/api/punch \
  -H "Authorization: Bearer $TIMECARD_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"toggle"}'
```

An iOS Shortcut with a "Get Contents of URL" action doing the same can be
named "Punch in" and triggered with Siri.

### Backups and restore

Everything is in `/srv/timecard/data/timecard.json`, also downloadable from
Settings → Download backup. Restoring is putting the file back and running
`docker compose restart timecard`.

## API

| Method   | Path                 | Body / notes                                        |
|----------|----------------------|-----------------------------------------------------|
| `GET`    | `/api/state`         | `{ now, settings, entries }`                        |
| `POST`   | `/api/entries`       | `{ start, stop? }` ms timestamps; `stop` null = running |
| `PATCH`  | `/api/entries/:id`   | `{ start?, stop? }`                                 |
| `DELETE` | `/api/entries/:id`   |                                                     |
| `GET`    | `/api/settings`      |                                                     |
| `PUT`    | `/api/settings`      | Any subset of the settings keys                     |
| `POST`   | `/api/punch`         | `{ action: "in" \| "out" \| "toggle", at? }`        |
| `GET`    | `/api/backup`        | Downloads the data file                             |

Only one entry can be running at a time; the API answers 409 otherwise.

## Layout

```
server.js          HTTP API and static files
lib/store.js       JSON file store with validation
shared/time.js     rounding, pay periods, formatting (used by server and browser)
public/            the app: index.html, app.js, style.css, service worker, icons
test/run.js        tests (node test/run.js)
deploy/            server compose file, env example, backup script
```
