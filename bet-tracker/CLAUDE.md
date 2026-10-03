# CLAUDE.md

Live Bet Tracker: tracks Dan's open sportsbook bets, estimates live win
probability from game state (not live odds), serves a mobile web page (SSE) and
an MCP server. Hono + better-sqlite3/Drizzle, Node 24, served at `/bets` on
port 3003 in the webhook-docker stack.

## Development

The `signs` host's glibc/g++ are too old for better-sqlite3's native module, so
install, build and test inside a container with `bin/dev`:

```bash
bin/dev yarn install
bin/dev yarn test          # vitest
bin/dev yarn typecheck
bin/dev yarn lint:check && bin/dev yarn format:check
bin/dev yarn db:generate --name <change>   # after editing src/db/schema.ts
```

Migrations in `drizzle/` are checked in and applied on startup by `openDb`.

## Conventions

- Money is integer cents in the DB, dollars at the MCP/web edges. Prices are
  integer American odds.
- A bet's stated payout always wins over price math (`src/domain/payout.ts`).
- `src/domain/betInput.ts` is the single validated input shape for both the seed
  loader and MCP `add_bet`.
- Seed: `node built/seed/cli.js [--force]` (idempotent without `--force`).
- Game state goes through `GameStateProvider` (`src/gamestate/`): MLB from the
  Stats API (batched `schedule?hydrate=linescore`), everything else from ESPN
  scoreboards (one call per sport/league/date). ESPN `yardLine` is measured
  from the home goal line; don't trust `possessionText` abbreviations.
- Tests use trimmed real responses in `test/fixtures/`; never hit the network.
  `bin/dev node scripts/live-smoke.mjs` (after a build) checks the real APIs.
- Event matching never guesses: anything but exactly one confident event is
  stored as candidates on the leg and needs `confirmLegMatch`.
