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

## Host it on Debian behind a Cloudflare Tunnel

The app has no login of its own. Put it behind **Cloudflare Access** so the
public hostname asks for your email one-time code before anything reaches
the server. Access is free for a handful of users.

1. **Run the app** on the server, either way:
   - Docker: `docker compose up -d --build` (binds to `127.0.0.1:8787`, data
     in `./data`).
   - systemd: copy the app to `/opt/timecard`, create a `timecard` user and
     `/var/lib/timecard`, install `deploy/timecard.service`, then
     `systemctl enable --now timecard`.
2. **Tunnel**: `cloudflared tunnel create timecard`, route a hostname to it,
   and point the ingress at `http://127.0.0.1:8787`
   (see `deploy/cloudflared-config.example.yml`). Run `cloudflared` as a
   service.
3. **Access**: in Zero Trust → Access → Applications, add a self-hosted app
   for that hostname with a policy allowing your email. Set a long session
   duration so your phone does not keep asking.
4. **Install on the phone**: open the hostname in Safari or Chrome and use
   "Add to Home Screen". It launches full-screen with its own icon.

### Punching from Shortcuts, Siri, or scripts

`POST /api/punch` toggles (or takes `{"action":"in"}` / `{"action":"out"}`)
and rounds on the server's clock. Set `TIMECARD_TOKEN` and send it as a
bearer token. Because Cloudflare Access would block a non-interactive
request, add an Access **bypass** policy for the path `/api/punch` or use a
**service token**; the bearer token then protects that one endpoint.

```bash
curl -X POST https://timecard.example.com/api/punch \
  -H "Authorization: Bearer $TIMECARD_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"toggle"}'
```

An iOS Shortcut with a "Get Contents of URL" action doing the same can be
named "Punch in" and triggered with Siri.

### Backups

Everything is in `timecard.json` in `DATA_DIR`. Copy it, or download it from
Settings → Download backup. Restoring is putting the file back and restarting.

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
deploy/            systemd unit and cloudflared example
```
