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
- Models (`src/models/`) are pure `(state, prior, selection) -> {win, push}`.
  Every expected number in their tests is hand-derived (comments show the
  math); keep it that way. MLB tests use a seeded RNG.
- Prior order: ESPN/DraftKings lines (summary `pickcenter` keeps the closing
  line after kickoff) -> Odds API pregame snapshot -> entered odds (pregame
  bets only) -> neutral. Priors refresh until the event starts, then freeze.
- `Tracker.tick()` (every 5 s from `server.ts`) polls due events with an open
  leg (even on a settled bet, so calibration gets outcomes), stores each leg's latest P(win)/P(push), settles
  finals, and logs calibration snapshots (max one per leg per 5 min).
- Parlay push/void recompute scales the remaining legs by the book's pricing
  factor (stated price / product of legs).

## MCP

- Tools live in `src/mcp/server.ts` (`createMcpServer(services)`), shared by
  stdio (`src/mcp/stdio.ts`, `docker exec -i bet-tracker node
  built/mcp/stdio.js` on signs) and HTTP (`POST /bets/mcp`, stateless, JSON
  responses).
- `/mcp` accepts `Authorization: Bearer <APP_TOKEN>` or an OAuth access token.
  OAuth (`src/auth/`) is single-user: dynamic client registration, PKCE S256,
  login = APP_TOKEN, redirect allowlist = Claude's connector callbacks +
  loopback (+ `OAUTH_EXTRA_REDIRECT_URIS`). Codes 5 min, access 1 h, refresh
  30 d with rotation; all stored hashed.

## Deploy (Apache on signs)

Add to `/etc/apache2/sites-enabled/000-default-le-ssl.conf` next to /meet. The
two `.well-known` lines let OAuth clients find metadata at the root paths
RFC 8414/9728 derive from `https://djperron.com/bets`; `flushpackets=on` keeps
the page's SSE stream unbuffered.

    ProxyPass        "/.well-known/oauth-protected-resource/bets/mcp" "http://localhost:3003/bets/.well-known/oauth-protected-resource"
    ProxyPass        "/.well-known/oauth-authorization-server/bets" "http://localhost:3003/bets/.well-known/oauth-authorization-server"
    ProxyPass        "/bets" "http://localhost:3003/bets" flushpackets=on timeout=300
    ProxyPassReverse "/bets" "http://localhost:3003/bets"
