# CLAUDE.md

Live Bet Tracker: tracks Dan's open sportsbook bets, estimates live win
probability from game state (not live odds), serves a mobile web page (SSE) and
an MCP server. A second view, Scores (`/bets/scores`), tracks games Dan follows
without betting, with ntfy push alerts. Hono + better-sqlite3/Drizzle, Node 24,
served at `/bets` on port 3003 in the webhook-docker stack.

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
  Stats API (batched `schedule?hydrate=linescore,team,gameInfo`), everything else from ESPN
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
- Every model is fitted (`models/fit.ts`) so the pregame model reproduces the
  de-vigged main moneyline, spread/run/puck line and total;
  `test/marketFit.test.ts` holds every sport to 1 point. Legs on other lines
  get a per-leg log-odds anchor to that exact line's market price (stored on
  the leg, fading with fraction remaining). MLB/NHL lines only count when
  priced (they are not 50/50 lines).
- `Tracker.tick()` (every 5 s from `server.ts`) polls due events with an open
  leg (even on a settled bet, so calibration gets outcomes), stores each leg's latest P(win)/P(push), settles
  finals, and logs calibration snapshots (max one per leg per 5 min).
- `settledAt` is when the bet's games ended, never when settlement ran
  (`src/domain/settleTime.ts`): a loss at its first losing leg's final,
  otherwise its last leg's final. Event end = provider end time (MLB
  `gameInfo`) or start + per-sport estimate, capped by when we saw it final.
  Manual `settle_bet` uses now; `update_bet` can correct it. Re-derive for
  existing bets: `node built/tracker/backfillCli.js [--dry-run]`.
- Scores (`src/scores/`, `src/web/scores.tsx`): `follows` (teams, resolved
  to the provider's full name from the next week's games; ambiguous names
  return candidates) and `watches` (one per event: `manual` star or `follow`;
  unstarring a followed game sets `hidden` so discovery doesn't re-add it).
  `ScoreService.discover()` runs hourly from `server.ts`. The Tracker polls
  watched events with the bets' events but fetches lines/snapshots only for
  events with an open leg, and emits `state` (prev/next GameState) per poll;
  `detectAlerts` (pure) turns that into start / lead change (through ties,
  via `watches.last_leader`) / close late / final. `score_alerts` is unique
  per (event, key), so restarts and the stdio process never double-send; a
  first fetch never alerts. Push is ntfy (`NTFY_URL`, JSON publish), with
  `SCORES_QUIET_HOURS` logging instead. Scores name lookups add nickname
  and place aliases (MLB Stats API has full names only; "Chicago" must hit
  both clubs); bet matching does not. `followTeam` ranks the schedule (7, then
  21 days) together with the provider's team list (`listTeams`: ESPN
  `/teams`, MLB `/teams`), so offseason teams resolve and a shared city is
  always ambiguous.
- `SPORTS` = `BET_SPORTS` (modeled, incl. NBA; `add_bet` accepts only these) +
  `SCORE_ONLY_SPORTS` (ncaab, ncaamh, ncaawh, ncaawvb: ESPN scoreboards,
  Scores view only; `evaluate` throws for them). Volleyball's score is sets
  won, its situation the points per set; a fifth set is its "close late".
- Parlay push/void recompute scales the remaining legs by the book's pricing
  factor (stated price / product of legs).
- NBA is a margin sport like WNBA (`basketball_normal`: the football_normal
  machinery without key numbers or possession; 12-minute quarters;
  `models.nba` σ in config).
- Player props (`market: 'player_prop'`; `src/models/props.ts`):
  `PROP_SPECS` per prop type (sport, selections, line, stat keys,
  dispersion, MLB role): NFL `anytime_td`; NBA points, rebounds, assists,
  threes, pra; MLB home_runs (yes = over 0.5, "to hit a HR"), total_bases,
  hits, pitcher_strikeouts, pitcher_outs. Leg columns `prop_type`/
  `player_name`, with `selectionTeam` = the player's team (matching
  resolves its `side`). No player model: P(win) is the entered price
  de-vigged with an assumed hold (`props.anytimeTdHold` 8%/15%,
  `props.overUnderHold` 7%/12%, split at +200; source `entered_price`).
  Once the game starts the Tracker fetches the ESPN summary box score
  (`events.player_stats_json`) with each live poll, then until ESPN marks it
  complete; MLB events (Stats API) are found on ESPN by teams and date
  (registry, cached per event). ESPN puts season totals in a pregame MLB box
  score, so `parsePlayerStats` returns null until the header says the game
  started. Anytime TD live: a TD = 1, else 1 - (1 - p)^f. Over/unders: final
  = stat so far + a count to come (Poisson, or negative binomial with
  variance = dispersion x mean), full-game mean calibrated so P(over) is the
  de-vigged price; still to come = NBA (stat + μw)/(elapsed + 48w) x minutes
  left (his share and pace blended with the pregame rate, w = 0.5 games);
  MLB batters rate per PA x expected PAs left (team outs left, lineup spot
  from team PAs mod 9, PAs = outs + NegBin(outs, outRate)); pitchers K rate
  per out (pace-blended) x outs left in the pitch budget (outs props: the
  calibrated outs mean x pitches/out), capped by outs left in regulation.
  Pulled (ESPN pitching `active` false), subbed out or ejected = done. MLB
  total bases = H + 2B + 2x3B + 3xHR with doubles/triples counted from the
  plays. Final: settle on the box score; no line (or an NBA DNP) stays open
  (`prop_unverified`) for `settle_bet` (legId settles one leg; manual legs
  survive recompute). No joint model covers a prop, so a same-game parlay
  with an open prop is `book_implied`.
- Series markets (`series_winner`, `series_spread` in games; MLB/NBA/NHL/
  WNBA; `src/models/series.ts`, `src/gamestate/espnSeries.ts`): legs link to
  a `series` row via `legs.series_id` (eventId stays null). ESPN has no
  series id: `espn:<sport>:series:<season>:<lo team id>-<hi>`, read from a
  team's `/teams/{id}/schedule?seasontype=3` (lists If Necessary games and
  hosts; "Game N" notes give numbers, MLB titles the round length). home =
  game 1's host (home field). Matching resolves both names against ESPN's
  team list and needs postseason games between them within 30 days of the
  leg's date; anything unsure is candidates. Strength (`series.strength_json`)
  = neutral-site log-odds from the next/current game's ESPN moneyline minus
  `HOME_EDGE` for its host, plus each game's own line; else the bet's entered
  series price fitted at the series state when placed; else neutral. A live
  game uses ESPN's summary `winprobability`. The DP enumerates the remaining
  games exactly; legs on one series price jointly (jointJson keyed by series
  id); placement = the model at the series as of placedAt (games over by
  then); settled when a team reaches the wins needed, settledAt = deciding
  game start + GAME_MINUTES. Correlation with game legs in the same series is
  ignored.
- Bet origin (`bets.origin`): `recommended` (Claude's +EV pick) | `own`
  (Dan's one-off) | null (untagged, older bets). add_bet/update_bet set it;
  list_bets, portfolio and the web page filter by it (`untagged` = null);
  `portfolio().byOrigin` has stake, P/L, ROI and EV at placement vs realized
  per origin.

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
