# Fleet Log

A travel schedule, fuel log and service log tracker with a real backend:

- **Frontend**: plain HTML/CSS/JS in `public/` — no build step.
- **Backend**: Node.js + Express (`server.js`), exposing a REST API under `/api/*`.
- **Database**: SQLite (`fleet-log.db`, created automatically on first run), accessed through `db.js` using `better-sqlite3`.

No third-party service is involved. Everything runs from this one folder, on
a machine you control.

## Run it locally

Requires Node.js 18 or later.

```
npm install
npm start
```

Then open **http://localhost:3000**. The database file `fleet-log.db` is
created next to `server.js` the first time you run it, seeded with the same
travellers/vehicles/places/etc. as the original spreadsheet.

## Multi-device / multi-person use

Anyone who opens the same server's address — from any device — sees and can
enter the same data. There's nothing extra to connect; the server itself is
the shared point.

- **Editing is optional to protect with a PIN.** Set one from the **Setup**
  tab. Without a PIN, anyone can edit. With one, only devices that entered
  it can add/change/delete — the server checks this on every write, not just
  in the page's UI, so it can't be bypassed by editing the page.
- Devices without the PIN still see live data (the page polls the server
  every few seconds) — they just can't change anything.

## Hosting it so others can reach it

Locally this only listens on your machine. To make it reachable by other
devices on your network or the internet, run it on a server (a small VPS
works fine) and put it behind a reverse proxy for HTTPS. A minimal example
with **nginx** and **pm2** (keeps the Node process running):

```
npm install -g pm2
pm2 start server.js --name fleet-log
pm2 save
```

Then point an nginx server block at `http://localhost:3000` for your domain,
and get a certificate (e.g. with `certbot`). Happy to help write that config
if you get to this step.

You can also change the port with an environment variable:

```
PORT=8080 npm start
```

## Backups

- **In-app**: Reports tab → "Download backup (.json)" / "Restore from
  backup". This calls the API, so it captures exactly what's in the
  database.
- **Whole database**: `fleet-log.db` (and the `-wal`/`-shm` files next to it
  while the server is running) is the entire database. Stop the server and
  copy those files anywhere for a full backup, or set up a cron job to copy
  `fleet-log.db` on a schedule.

## API overview

All endpoints are under `/api`. Mutating endpoints (POST/PATCH/DELETE,
except `/api/auth/*`) require an `Authorization: Bearer <token>` header once
a PIN is set; the token comes from `/api/auth/unlock`.

| Area | Endpoints |
|---|---|
| Auth | `GET /auth/status`, `POST /auth/unlock`, `POST /auth/set-pin`, `POST /auth/remove-pin` |
| Config | `GET /config`, `POST /config/:list`, `DELETE /config/:list/:value` |
| Schedule | `GET /schedule/:date`, `POST /schedule/:date/entries`, `PATCH /schedule/entries/:id`, `DELETE /schedule/entries/:id`, `POST /schedule/:date/lock` |
| Fuel | `GET /fuel/:month`, `POST /fuel/:month/entries`, `PATCH /fuel/entries/:id`, `DELETE /fuel/entries/:id`, `POST /fuel/:month/lock` |
| Service | `GET /service/:month`, `POST /service/:month/entries`, `PATCH /service/entries/:id`, `DELETE /service/entries/:id`, `POST /service/:month/lock` |
| Reports | `GET /reports/summary`, `GET /reports/range?from=&to=`, `GET /reports/schedule-days`, `GET /reports/fuel-months`, `GET /reports/service-months` |
| Backup | `GET /backup`, `POST /backup/restore` |

## Project layout

```
fleet-log/
  package.json
  server.js        Express app + all routes
  db.js             SQLite schema, seeding, and all queries
  lib/summary.js    Shared calculations (trip/fuel/service totals)
  public/
    index.html
    styles.css
    app.js          Frontend logic — calls the API, no other framework
```
