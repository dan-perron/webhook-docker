# Bet Tracker

Tracks Dan's open sportsbook bets and estimates each one's live chance of
winning **from game state** (score, clock, situation), not from live odds.
It serves a mobile web page at <https://djperron.com/bets> with live updates,
and an MCP server so Claude can add and manage bets and check odds.

The **Today** view (<https://djperron.com/bets/scores>) combines live scores
and situation for followed teams' games, starred games and games with an
open bet, with related bet tickets and push alerts through ntfy.

- **Web:** Today / Bets / History navigation; scores and game clocks first,
  bets grouped live / upcoming / pending, with one scoreboard for tickets on
  the same game, stake and total return if won, and
  model- or price-based win estimates. Bet details expand for prices, boosts,
  value and EV; completed parlay games and exposure are collapsible.
  Calibration lives on Settings, with one overall score and an expandable
  sport/baseline comparison. Expanded sections and
  sport filters survive live updates.
  Each game shows data age and warns when live data is over two minutes old
  (twenty minutes pregame), independently of stream connection status.
- **Today:** live / upcoming / visible completed-today cards with open bet
  tickets and sport filters. Followed and starred games stay visible through
  their completion day in the viewer's time zone. Settled tickets compress to
  one headline: today's realized P/L plus current EV of all open bets.
  The "Today + EV" headline includes a breakdown and links to History.
  Add games and follow teams through MCP; the
  existing schedule browser and Teams routes remain available. Followed
  teams' games in the next week are added automatically. Alerts: start,
  lead change, close late, final.
  Also covers men's college basketball, men's and women's college hockey and
  women's college volleyball (scores only; those can't be bet on).
- **MCP tools:** `check_odds`, `add_bet`, `confirm_match`, `list_bets`,
  `get_bet`, `update_bet`, `update_leg`, `recompute_bet`, `settle_bet`,
  `remove_bet`, `portfolio`; Scores: `scores`, `list_games`, `watch_game`,
  `unwatch_game`, `follow_team`, `unfollow_team`, `set_score_alerts`.
- **Stack:** Node 24, TypeScript, Hono, SQLite (better-sqlite3 + Drizzle),
  `@modelcontextprotocol/sdk`, Vitest. Runs as a service in the
  `webhook-docker` compose stack on `signs`.

## Product goals and UI priorities

Owner context, recorded October 11, 2026:

- **Betting goal:** use all available bonus bets when there is a positive
  expected value (EV+) opportunity. This is the main reason for tracking bets.
- **Games of interest:** follow teams Dan cares about, plus occasional games
  of interest for any reason. A game does not need an associated bet to matter.
- **Today:** completed games for followed teams and individually watched
  events remain visible for the local day. The headline combines realized
  profit/loss today with current EV of all open bets; keep EV visible.
- **Watching:** viewing ZIP is **60640 (Chicago, DMA 602)**. Show the TV
  channel/streaming app on game cards, with explicit local OTA availability
  for regional NFL games. Put the broadcast beside the date/time, with a
  short OTA indicator; keep full watch details expandable.
- **Discovery:** finding more events would be useful, but discovery must not
  displace tracked bets, followed teams, or individually selected games.
- **Simplicity:** existing score trackers feel too bloated. Keep this interface
  compact and quick to scan, with scores, clocks, and relevant bets prominent.
  Avoid repeating selections, status, game situation, and summary totals.
- **Management:** adding games and following teams happens through MCP. The web
  interface primarily serves monitoring.
- **Deployment:** deploy and verify completed changes on the hosted site.

Use these priorities when considering future features: keep personally relevant
bets and games in the main view, make discovery secondary and optional, and keep
expanded analysis from crowding the everyday score-tracking experience.

## How it works

1. **Matching.** Each leg is matched to a game by sport, local date and fuzzy
   team/fighter names (`src/matching/`). Anything short of one confident match
   is held with candidates for confirmation; it never guesses.
2. **Game state.** `GameStateProvider` adapters (`src/gamestate/`) normalize
   ESPN scoreboards (NFL, NCAAF, NHL, NBA, WNBA, soccer, UFC) and the MLB Stats API into one
   `GameState`. Polling is batched: one ESPN scoreboard per sport, league and
   date; one Stats API call for all MLB games. TV/stream listings come from
   those same feeds. NFL cards are enriched from the public [NFL game guide](https://www.nfl.com/ways-to-watch)
   (cached one hour per week). Chicago OTA eligibility uses published DMA
   assignments, not ESPN's unreliable national/regional tag. A missing map,
   unassigned market, failed fetch, or stale coverage stays unconfirmed;
   "No OTA" for regional games requires a different game assigned to Chicago
   in the same network/time window. Streaming options require subscriptions;
   OTA eligibility does not guarantee antenna reception. The viewing ZIP,
   market name and matching DMA are configured together in `viewingLocation`.
3. **Priors.** Each game starts from a pregame prior, from the first of:
   ESPN's DraftKings lines (the summary keeps the closing line after kickoff),
   an optional Odds API snapshot shortly before start (only when ESPN has
   none, e.g. UFC), the odds entered with pregame bets, or neutral.
4. **Models** (`src/models/`), pure `(state, prior, selection) → {win, push}`,
   each fitted pregame (`fit.ts`) so it reproduces the de-vigged main lines:
   - **NFL / NCAAF / NBA / WNBA:** integer final-margin distribution (normal × NFL
     key-number weights fitted on 2002–2026 results; none for NCAAF/NBA/WNBA),
     mean and σ fitted to the moneyline and spread price, total mean to the
     over/under price. Only the NFL can tie. Same-game legs summed exactly.
   - **MLB:** exact final-score distribution, half-inning by half-inning from
     the base/out state (RE24), with extras and walk-offs. Total runs, home
     share and an inning-dispersion knob fitted to moneyline, run line, total.
   - **NHL:** Poisson goals stepped over the clock, with the trailing team
     pulling its goalie late (empty-net goals), then 3-on-3 OT and a shootout
     (playoffs: sudden death); the OT/SO winner wins by one and that goal
     counts in the total. Goal rates and empty-net strength fitted to
     moneyline, puck line and total.
   - **Soccer:** Poisson goals over the minutes left (incl. stoppage) with the
     Dixon–Coles low-score correction, fitted to home/draw/away and the total.
   - **UFC:** the prior until the fight is final.
   - **Player props** (NFL anytime TD; NBA points, rebounds, assists, threes,
     PRA; MLB home runs / to hit a HR, total bases, hits, pitcher strikeouts,
     pitcher outs): the entered price de-vigged with an assumed prop hold,
     then live from the ESPN box score. Over/unders: the stat so far plus a
     Poisson / negative-binomial count still to come, its mean the pregame
     rate (calibrated to the price) times what is left: NBA minutes (his
     share of the minutes left, pace blended with the pregame rate), MLB
     batters' expected plate appearances left (lineup spot, outs left),
     pitchers' outs left in their pitch budget. Pulled, subbed out or
     ejected = final. Settled from the final box score; a player with no
     line (or an NBA DNP) waits for a hand settle.
   - **Series** (`series_winner`, `series_spread`: MLB, NBA, NHL, WNBA
     playoffs): linked to the series (ESPN season + both team ids, from the
     team's postseason schedule). Each remaining game's win probability is
     its own ESPN line, else a neutral-site strength from the latest line
     (or the entered price) ± home edge for the host; a game in progress
     uses ESPN's live win probability. The remaining games are enumerated
     exactly; settled when the series ends.
   - **Exact-line anchor:** when the market prices a leg's exact line (ESPN,
     Odds API, else the entered price de-vigged), pregame P(win) is shifted
     onto it in log-odds; the shift fades linearly as the game is played.
5. **Tracker** (`src/tracker/tracker.ts`) polls every 30 s live and 10 min
   pregame, stores each leg's probability, settles finals, prices same-game
   groups, and logs calibration snapshots. Bets are valued exactly over every
   win/push path (`src/domain/value.ts`); the book's stated payout always wins
   over price math.

Same-game legs are priced jointly from the same game model in every sport
except UFC (and any group with an open player prop), where those bets show
P(win) from the book's unboosted price, labeled "book-implied". Two legs on
one series are priced jointly from the series distribution.

Every bet carries an **origin**: `recommended` (Claude recommended it as
+EV) or `own` (Dan's one-off); bets from before origins existed are untagged
until set with `update_bet`. The Bets and History pages filter by origin and
History breaks results down by it (stake, P/L, ROI, EV at placement), as
does the MCP `portfolio` tool.

## Configuration

Set in the stack's `.env` (`webhook-docker/.env`, see `.env_template`) and
mapped in `docker-compose.yml`:

| Variable (container)                      | `.env` name            | Default                    | Purpose                                                             |
| ----------------------------------------- | ---------------------- | -------------------------- | ------------------------------------------------------------------- |
| `APP_TOKEN`                               | `BET_APP_TOKEN`        | required                   | Web login, bearer token for HTTP MCP, OAuth approval                |
| `ODDS_API_KEY`                            | `ODDS_API_KEY`         | empty (odds off)           | The Odds API key; never logged or returned                          |
| `PREGAME_SNAPSHOT`                        | `BET_PREGAME_SNAPSHOT` | `true`                     | One Odds API snapshot per game before start when ESPN has no lines  |
| `BASE_PATH`                               | `BET_BASE_PATH`        | `/bets`                    | Path the app is served under                                        |
| `PUBLIC_ORIGIN`                           | `BET_PUBLIC_ORIGIN`    | `https://djperron.com`     | Absolute origin for OAuth metadata and Secure cookies               |
| `DATABASE_PATH`                           | —                      | `/data/bet-tracker.sqlite` | SQLite file (named volume `bet-tracker-data`)                       |
| `TZ`                                      | —                      | `America/Chicago`          | Local dates for matching; fallback for page times                   |
| `OAUTH_EXTRA_REDIRECT_URIS`               | —                      | empty                      | Extra exact OAuth redirect URIs (comma-separated)                   |
| `NFL_MARGIN_SIGMA` / `NCAAF_MARGIN_SIGMA` | —                      | 13.5 / 15                  | Default margin σ when a game has no moneyline + spread              |
| `ATD_HOLD` / `ATD_HOLD_LONG`              | —                      | 0.08 / 0.15                | Assumed anytime TD hold, up to +200 / longer                        |
| `PROP_HOLD` / `PROP_HOLD_LONG`            | —                      | 0.07 / 0.12                | Assumed over/under prop (and to hit a HR) hold, up to +200 / longer |

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
- **Odds API quota** shows in Bets → Portfolio details and in `portfolio`; each
  `check_odds` costs markets × regions requests (cached 60 s), and calls over
  3 requests need `confirm: true`.
- **Calibration** (Settings → Calibration) gets meaningful past roughly 10 settled legs
  per sport; that is the place to judge whether to tune the models.
