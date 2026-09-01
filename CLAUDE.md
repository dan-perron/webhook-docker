# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Docker Compose orchestration for a webhook server stack. Manages two services (webhook-server + MongoDB) and coordinates two git submodules that each have their own repos and build contexts.

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
- `webhook-server`: Node.js/TypeScript Express app (port 3000) — built from `./webhook-server` submodule. Connects to MongoDB and mounts an external `thunderdome-ootp` volume at `/ootp`.
- `mongodb`: MongoDB 6.0 with persistent `mongodb-data` volume.
- `windows-rdp-automation`: Python-based RDP automation (currently commented out) — from `./windows-rdp-automation` submodule.

**Git Submodules** (hosted on `github.djperron.com`):
- `webhook-server` — the main application. Has its own `CLAUDE.md` with detailed architecture docs.
- `windows-rdp-automation` — Python service for driving OOTP simulations via RDP.

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
