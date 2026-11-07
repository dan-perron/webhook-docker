# CLAUDE.md

Health log: recurring issues (canker sores, ...) logged against possible
triggers (sleep, alcohol, meals, prepared food) and one-change-at-a-time
experiments. Separate from training. MCP only (no web UI, no REST): Claude
logs what Dan reports in chat and reads the report. Hono, Node 24, Mongo
database `health`, port 3007, base path `/health`.

## Development

No native modules; runs on the host's Node 24.

```bash
yarn install
yarn test          # vitest; in-memory mongod (mongodb-memory-server)
yarn typecheck
yarn lint:check && yarn format:check
```

## Layout and rules

- `src/domain/report.ts` is pure: lookback windows, per-week rates, the
  during-vs-before comparison. `src/db/store.ts` owns every write and the
  report query; `src/mcp/server.ts` is thin.
- Flares: client-generated `_id` (UUID); resending replaces. `count`
  defaults to 1. Issues are lowercase tags (`canker_sore`).
- Day logs: one per date, `_id` = the date. Resending merges the fields
  given; null clears one; meals keyed per meal merge, a list replaces.
- Experiments: `_id` is a slug of the name; matched by id or exact name
  (a name renames only when matched by id). They may not overlap in time
  (any issue), so a flare-rate change maps to one change.
- Report: `during` runs from the start through the end or today; `before`
  is the same number of days just before the start (`beforeOverlaps` names
  any experiment inside it). Rates are per 7 days, 2 decimals.
- Mongo is standalone (no transactions): single-document writes.
- Dates are local (`TZ`, America/Chicago) `YYYY-MM-DD` strings.

## MCP

Stateless HTTP at `POST /health/mcp`, `Authorization: Bearer
<HEALTH_APP_TOKEN>`; the stack sets it to the gateway's own `MCP_APP_TOKEN`
(no separate secret, since only the gateway can reach it). Reached only
through mcp-gateway (`MCP_BACKENDS` `health=http://health:3007/health/mcp`). Tool names are `health_`-prefixed
so they can't clash with other apps'.

## Deploy (signs)

`docker compose up -d --build health mcp-gateway`. No published port and no
Apache entry: only the gateway calls it. Backups: covered by the nightly
Mongo dump in `ops/backup-signs`.
