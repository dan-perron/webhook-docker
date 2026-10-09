# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Docker Compose orchestration for the app stack on the `signs` home server. Runs
four app services plus MongoDB. Some app directories are git submodules with
their own repos; others are plain directories committed straight into this repo.

Apache2 on the host (not in Docker) terminates TLS for `djperron.com` and
reverse-proxies each app onto a path of the main domain, so no app needs its own
DNS record or certificate.

## Commands

```bash
# Start all services
docker compose up -d

# Rebuild and start (after code changes in submodules)
docker compose up -d --build

# View logs
docker compose logs -f webhook-server

# Stop services
docker compose down
```

## Architecture

**Services** defined in `docker-compose.yml`:
- `webhook-server`: Node/TypeScript Express app (port 3000) — from the `./webhook-server` submodule. Connects to MongoDB and mounts an external `thunderdome-ootp` volume at `/ootp`. Proxied at `/webhooks/`.
- `calcium-tracker`: Node/TypeScript Hono app (port 3001) — from the `./calcium-tracker` submodule. Proxied at `/calcium`.
- `meeting-scheduler`: Node/TypeScript Hono app (port 3002) — plain directory, **not** a submodule. A self-hosted When2Meet. Proxied at `/meet`.
- `bet-tracker`: Node/TypeScript Hono app (port 3003) — plain directory, **not** a submodule. Live bet tracker + a Scores view (followed teams/starred games, ntfy alerts) + MCP server; uses its own SQLite on the `bet-tracker-data` volume, not Mongo. Proxied at `/bets`. Build/test via `bet-tracker/bin/dev` (see its CLAUDE.md).
- `personal-assistant`: Node/TypeScript Slack bot (Socket Mode, no HTTP port) — plain directory, **not** a submodule.
- `mongodb`: MongoDB 6.0 with persistent `mongodb-data` volume. **Not published to the host** — only reachable on this stack's network as hostname `mongodb`, which is why every app here deploys as a service in this stack.
- `windows-rdp-automation`: Python RDP automation (currently commented out) — from the `./windows-rdp-automation` submodule.

Each app uses its own logical database on the shared MongoDB (`webhook-server`,
`calcium`, `scheduler`, …), not shared collections.

**Git Submodules** (hosted on `github.djperron.com`):
- `webhook-server` — the original application. Has its own `CLAUDE.md` with detailed architecture docs.
- `calcium-tracker` — Hono + hono/jsx + HTMX app; the canonical template for adding a new web app here.
- `windows-rdp-automation` — Python service for driving OOTP simulations via RDP.

**Plain directories** (committed to this repo, no separate remote): `personal-assistant`,
`meeting-scheduler`. These deploy with a plain `docker compose up -d --build <name>` —
no submodule bump. Prefer this for small apps; reach for a submodule only when the
app genuinely needs its own repo and history.

**Adding a new web app**: copy the `calcium-tracker` layout (Dockerfile,
`config/default.cjs` with `normalizeBasePath`, `src/util/url.ts`, `/healthz`,
eslint/prettier/husky), make it base-path aware from day one, give it the next
free port, add the `MONGODB_CONNSTRING` env line, and add a two-line
`ProxyPass`/`ProxyPassReverse` pair to
`/etc/apache2/sites-enabled/000-default-le-ssl.conf` (the path passes through
verbatim — no rewrite — because the app knows its own base path).

**Environment**: `.env` file (gitignored) provides `MONGO_USERNAME` and `MONGO_PASSWORD`. See `.env_template` for required variables.

**External Volume**: `thunderdome-ootp` must exist before starting (`docker volume create thunderdome-ootp`). It's shared with the webhook-server container for OOTP game file access.

## Working with Submodules

When cloning fresh: `git clone --recurse-submodules`

To update a submodule to its latest commit:
```bash
cd webhook-server   # or windows-rdp-automation
git pull origin master
cd ..
git add webhook-server
git commit -m "Update webhook-server"
```

Most application code changes happen inside the `webhook-server` submodule — refer to `webhook-server/CLAUDE.md` for development commands (build, lint, test) and detailed architecture.

## Backups

`ops/backup-signs` (cron 03:30) backs up Mongo, bet-tracker, Home Assistant,
Pi-hole, the *arr configs, every stack's compose/.env files and the Apache
config to `/mnt/archive/backups/signs/`. See `ops/README.md` for contents and
restore steps. A new app with state should get a part in that script.
