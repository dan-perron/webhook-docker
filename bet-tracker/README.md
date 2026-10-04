# Bet Tracker

Tracks Dan's open sportsbook bets and estimates each one's live chance of
winning **from game state** (score, clock, situation), not from live odds.
It serves a mobile web page at <https://djperron.com/bets> with live updates,
and an MCP server so Claude can add and manage bets and check odds.

- **Web:** totals, a card per bet (price → boosted price, stake → payout,
  P(win), value, EV now vs at placement), each leg's live score and
  situation, an exposure grid for games with several bets, and a Settled tab
  with calibration (Brier scores, reliability charts).
- **MCP tools:** `check_odds`, `add_bet`, `confirm_match`, `list_bets`,
  `get_bet`, `update_bet`, `settle_bet`, `remove_bet`, `portfolio`.
- **Stack:** Node 24, TypeScript, Hono, SQLite (better-sqlite3 + Drizzle),
  `@modelcontextprotocol/sdk`, Vitest. Runs as a service in the
  `webhook-docker` compose stack on `signs`.

## How it works

1. **Matching.** Each leg is matched to a game by sport, local date and fuzzy
   team/fighter names (`src/matching/`). Anything short of one confident match
   is held with candidates for confirmation; it never guesses.
2. **Game state.** `GameStateProvider` adapters (`src/gamestate/`) normalize
   ESPN scoreboards (NFL, NCAAF, soccer, UFC) and the MLB Stats API into one
   `GameState`. Polling is batched: one ESPN scoreboard per sport, league and
   date; one Stats API call for all MLB games.
3. **Priors.** Each game starts from a pregame prior, from the first of:
   ESPN's DraftKings lines (the summary keeps the closing line after kickoff),
   an optional Odds API snapshot shortly before start (only when ESPN has
   none, e.g. UFC), the odds entered with pregame bets, or neutral.
4. **Models** (`src/models/`), pure `(state, prior, selection) → {win, push}`:
   - **Football:** an integer final-margin distribution, normal × NFL
     key-number weights fitted on 2002–2026 results, with σ fitted per game
     so the model reproduces the moneyline; totals normal. Same-game parlays
     are summed exactly over (margin, total).
   - **MLB:** Monte Carlo of the remaining half-innings from the current
     base/out state (RE24), with extras and walk-offs.
   - **Soccer:** Poisson goals over the minutes left, including stoppage time.
   - **UFC:** the prior until the fight is final.
5. **Tracker** (`src/tracker/tracker.ts`) polls every 30 s live and 10 min
   pregame, stores each leg's probability, settles finals, prices same-game
   groups, and logs calibration snapshots. Bets are valued exactly over every
   win/push path (`src/domain/value.ts`); the book's stated payout always wins
   over price math.

Same-game legs in MLB, soccer or UFC have no joint model yet: those bets show
P(win) from the book's unboosted price, labeled "book-implied".

## Configuration

Set in the stack's `.env` (`webhook-docker/.env`, see `.env_template`) and
mapped in `docker-compose.yml`:

| Variable (container)                      | `.env` name            | Default                    | Purpose                                                            |
| ----------------------------------------- | ---------------------- | -------------------------- | ------------------------------------------------------------------ |
| `APP_TOKEN`                               | `BET_APP_TOKEN`        | required                   | Web login, bearer token for HTTP MCP, OAuth approval               |
| `ODDS_API_KEY`                            | `ODDS_API_KEY`         | empty (odds off)           | The Odds API key; never logged or returned                         |
| `PREGAME_SNAPSHOT`                        | `BET_PREGAME_SNAPSHOT` | `true`                     | One Odds API snapshot per game before start when ESPN has no lines |
| `BASE_PATH`                               | `BET_BASE_PATH`        | `/bets`                    | Path the app is served under                                       |
| `PUBLIC_ORIGIN`                           | `BET_PUBLIC_ORIGIN`    | `https://djperron.com`     | Absolute origin for OAuth metadata and Secure cookies              |
| `DATABASE_PATH`                           | —                      | `/data/bet-tracker.sqlite` | SQLite file (named volume `bet-tracker-data`)                      |
| `TZ`                                      | —                      | `America/Chicago`          | Local dates for matching; fallback for page times                  |
| `OAUTH_EXTRA_REDIRECT_URIS`               | —                      | empty                      | Extra exact OAuth redirect URIs (comma-separated)                  |
| `NFL_MARGIN_SIGMA` / `NCAAF_MARGIN_SIGMA` | —                      | 13.5 / 15                  | Default margin σ when a game has no moneyline + spread             |

Other tunables (polling, Odds API cost threshold, σ bounds) are in
`config/default.cjs`. Generate a token with `openssl rand -base64 32`.

## Development

The `signs` host's glibc and g++ are too old for better-sqlite3's native
module, so everything runs in a `node:24` container through `bin/dev`:

```bash
bin/dev yarn install
bin/dev yarn test            # 230+ tests, fixtures only, no network
bin/dev yarn typecheck
bin/dev yarn lint:check && bin/dev yarn format:check
bin/dev yarn build
bin/dev yarn db:generate --name <change>   # after editing src/db/schema.ts
bin/dev node scripts/live-smoke.mjs        # match + one tick against the real APIs
```

Run the server locally on port 3093 with a throwaway database:

```bash
bin/dev yarn build
docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e APP_TOKEN=dev -e PUBLIC_ORIGIN=http://localhost:3093 \
  -e DATABASE_PATH=./data/local.sqlite \
  -p 127.0.0.1:3093:3003 -v "$PWD":/app -w /app node:24 node built/server.js
# seed it from another shell:
docker exec <container> node built/seed/cli.js
```

Then open <http://localhost:3093/login> and sign in with `dev`.

Tests use trimmed real responses recorded from live games in
`test/fixtures/` (the Odds API fixture is hand-built; see its README). Model
tests check hand-derived values; the football ones come from an independent
Python implementation. Migrations in `drizzle/` are checked in and apply on
startup; the server also re-evaluates every open leg at startup so model
changes take effect immediately.

## Deploy (signs)

```bash
cd ~/docker-compose/webhook-docker
docker compose up -d --build bet-tracker
docker exec bet-tracker node built/seed/cli.js   # first time only; --force replaces all bets
```

Apache (`/etc/apache2/sites-enabled/000-default-le-ssl.conf`) terminates TLS
and proxies `/bets`. The two `.well-known` lines let OAuth clients find
metadata at the root paths they derive from `https://djperron.com/bets`;
`flushpackets=on` keeps the page's live stream unbuffered:

```apache
ProxyPass        "/.well-known/oauth-protected-resource/bets/mcp" "http://localhost:3003/bets/.well-known/oauth-protected-resource"
ProxyPass        "/.well-known/oauth-authorization-server/bets" "http://localhost:3003/bets/.well-known/oauth-authorization-server"
ProxyPass        "/bets" "http://localhost:3003/bets" flushpackets=on timeout=300
ProxyPassReverse "/bets" "http://localhost:3003/bets"
```

**Backups:** `bin/backup` takes an online SQLite backup inside the container,
checks its integrity, copies it to `/mnt/archive/backups/signs/bet-tracker/`
and keeps 30 days. It runs nightly from `ops/backup-signs`
(log: `/tmp/backup-signs.log`; see `ops/README.md`). To restore, stop the container, copy a
backup over `/data/bet-tracker.sqlite` in the `bet-tracker-data` volume, and
start it.

## Connecting Claude (MCP)

**Claude Code on signs** (stdio, shares the server's database):

```bash
claude mcp add bet-tracker -- docker exec -i bet-tracker node built/mcp/stdio.js
```

**Claude Code anywhere else** (HTTP with the app token):

```bash
claude mcp add --transport http bet-tracker https://djperron.com/bets/mcp \
  --header "Authorization: Bearer <BET_APP_TOKEN>"
```

**claude.ai, the mobile apps, and Claude Desktop:** Settings → Connectors →
add a custom connector with URL `https://djperron.com/bets/mcp`, leaving any
OAuth client ID/secret fields empty. Connecting opens a "Connect Claude" page
on djperron.com: paste the app token and tap Allow. The client gets
short-lived tokens (1 h, refreshed automatically, 30-day refresh); the app
token itself is never stored by the client.

**Claude Desktop via local config** (stdio over SSH, if you prefer it to a
connector), in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bet-tracker": {
      "command": "ssh",
      "args": [
        "signs",
        "docker",
        "exec",
        "-i",
        "bet-tracker",
        "node",
        "built/mcp/stdio.js"
      ]
    }
  }
}
```

OAuth is single-user: dynamic client registration, PKCE S256, redirects only
to Claude's connector callbacks and loopback URIs, failed approvals rate
limited, all codes and tokens stored hashed. Rotating `APP_TOKEN` logs out
every browser; revoke connector tokens by deleting rows from `oauth_tokens`.

## Maintenance

- **Refit NFL key numbers** (e.g. each offseason):
  ```bash
  curl -sLO https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
  python3 scripts/fit_key_numbers.py games.csv > src/models/data/nfl-key-numbers.json
  ```
  then update the hand-checked football test values (`test/football.test.ts`).
- **Odds API quota** shows in the page header and in `portfolio`; each
  `check_odds` costs markets × regions requests (cached 60 s), and calls over
  3 requests need `confirm: true`.
- **Calibration** (Settled tab) gets meaningful past roughly 10 settled legs
  per sport; that is the place to judge whether to tune the models.
