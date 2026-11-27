import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createBet,
  getBet,
  removeBet,
  settleBet,
  settleLeg,
  updateBet,
  updateLeg,
} from '../db/bets.js';
import type { Db } from '../db/client.js';
import { betInputSchema } from '../domain/betInput.js';
import { TIMING_BUCKETS } from '../domain/timing.js';
import {
  BET_ORIGINS,
  BET_SPORTS,
  BET_STATUSES,
  BOOST_KINDS,
  ORIGIN_FILTERS,
  SELECTION_KINDS,
  SPORTS,
} from '../domain/types.js';
import type { Providers } from '../gamestate/registry.js';
import { confirmLegMatch, matchLegs } from '../matching/service.js';
import { filterEvents, oddsView, summarizeEvent } from '../odds/consensus.js';
import { mergeEvents, mergedView } from '../odds/merge.js';
import { ODDS_MARKETS, sportKey, type OddsApiClient } from '../odds/oddsApi.js';
import {
  SPORTS as PAPI_SPORTS,
  type OddsPapiClient,
} from '../odds/oddsPapi.js';
import { summarizeHistory } from '../odds/papiHistory.js';
import type { PapiLookups } from '../odds/papiLookups.js';
import {
  findFixtureFor,
  OddsApiProvider,
  papiSlug,
  quotaView,
  type NormMarket,
  type OddsPapiProvider,
  type PreparedCall,
  type ProviderResult,
} from '../odds/provider.js';
import type { ScoreService } from '../scores/service.js';
import type { LiveMarketCheck } from '../tracker/liveMarket.js';
import type { Tracker } from '../tracker/tracker.js';
import {
  betViewById,
  liveMarketWarning,
  betViews,
  eventRow,
  portfolio,
} from '../tracker/views.js';

export interface Services {
  db: Db;
  providers: Providers;
  tracker: Tracker;
  scores: ScoreService;
  odds: OddsApiClient;
  /** get_bet's live-market debug field (absent = off). */
  liveMarket?: LiveMarketCheck;
  /** check_odds calls costing more than this need confirm: true. */
  confirmAboveCost: number;
  /** OddsPapi (check_odds source oddspapi/both, get_historical_odds). */
  papi?: {
    client: OddsPapiClient;
    provider: OddsPapiProvider;
    lookups: PapiLookups;
  };
}

/** Our sport -> Odds API sport key, for OddsPapi's coverage. */
const PAPI_COVERED = Object.keys(PAPI_SPORTS);

const SOURCES =
  'source: "oddsapi" (default; The Odds API: US books, game lines, quota in its own requests) | "oddspapi" (OddsPapi: adds Pinnacle as the sharp reference and player props; nba, wnba, ncaab, nfl, ncaaf, mlb, nhl only) | "both" (merged by event/market/outcome, each price labelled with its provider; if OddsPapi fails you get the Odds API data plus a warning).';

const UNITS =
  'Units: money in US dollars; prices in American odds (e.g. +150, -110); probabilities 0..1.';
const PROVENANCE =
  "pWin/pPush/value/ev come from our state-based models (live score, clock, situation + a pregame prior; series: per-game win probabilities over the remaining games), never from live odds; when now.source is 'book_implied' the bet has same-game legs without a joint model and pWin is the book's unboosted price instead; when it is 'entered_price', unmatchedLegIds lists legs not yet matched to a game and propLegIds lists open player props, each valued at its entered price de-vigged (props: with an assumed prop hold, then live from the box score: anytime TD: a TD wins, otherwise P falls as the game clock runs; over/unders: the stat so far plus what is still to come at the pregame rate (NBA: blended with his pace, over his share of the minutes left; MLB batters: expected plate appearances left; pitchers: outs left in his pitch budget; pulled/subbed out = final)). price/payout are what the book offered, as entered.";
const ORIGIN =
  "origin: 'recommended' = Claude recommended it as +EV, 'own' = Dan's one-off; null = untagged (older bets; set it with update_bet).";

const BONUS =
  'bonusBet: true when placed with a sportsbook bonus bet (e.g. DraftKings "$25 Bonus Bet"): the stake is not cash and is not returned, so payout = profit only (stake x (decimal - 1); a statedPayout is taken as profit, like DK\'s "To Pay"), cost 0, ev = value, conversion = value / stake; a loss is $0, a push/void $0 (the book may return the bonus bet).';

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
});

/** Run a tick so new/changed bets get evaluated before we answer. */
async function refresh(s: Services) {
  try {
    await s.tracker.tick();
  } catch {
    // The background poller will catch up; answer with what we have.
  }
}

export function createMcpServer(s: Services): McpServer {
  const server = new McpServer(
    { name: 'bet-tracker', version: '1.0.0' },
    {
      instructions: `Tracks Dan's sportsbook bets with live, game-state-based win probabilities, and (Scores) live scores for games he follows without betting: watch_game / follow_team add them, scores shows the board. ${UNITS} ${PROVENANCE} Tag every bet you add with origin: 'recommended' when you recommended it as +EV, 'own' when it is Dan's one-off. Use check_odds for current market lines: source "oddsapi" (default, Odds API quota) for US books' game lines; "oddspapi" or "both" when you want Pinnacle as the sharp reference (fair = Pinnacle no-vig) or player props, filtered to one game (about 2 OddsPapi requests; its monthly allowance is small). Use get_historical_odds (OddsPapi, finished games, no monthly quota, 5 s per 3 books) to see a game's open, close and the price when a bet was placed. Odds are market data only, never inputs to pWin/value/ev. When add_bet returns legs needing confirmation, show Dan the candidates and call confirm_match with his choice; never pick one yourself.`,
    }
  );

  server.registerTool(
    'check_odds',
    {
      title: 'Check current odds',
      description: `Current market lines for a sport, optionally filtered to teams/an event. Market data only: never an input to pWin/value/ev. ${SOURCES} source oddsapi returns, per market, each outcome with its own point (spreads: e.g. Brewers -1.5 / Padres +1.5; totals: the line), every book's American price (from the API) and de-vigged fair probability (computed), the cross-book consensus and best price, the market's average hold, and the Odds API quota remaining. Cost: markets x regions requests (60 s cache is free). source oddspapi/both returns per outcome: consensus (mean of the books' de-vigged probabilities), fair + fairAmerican (Pinnacle's no-vig price, when Pinnacle priced every side), best, and books [{provider, book, american, decimal, fair, lastUpdated}] (OddsPapi's American and decimal prices are the API's own; derived marks a converted one), plus warnings and each provider's quota. OddsPapi cost: 1 request for the fixtures list (cached 10 min) + 1 per game priced (all books in one call); a filter usually means 2, no filter up to 11 (the next day's games, at most 10). OddsPapi's monthly allowance is small (250 on the free plan): filter to the game you care about. Calls costing more than the confirmation threshold on either provider return the cost and need confirm: true. ${UNITS}`,
      inputSchema: {
        sport: z
          .string()
          .describe(
            "nfl, ncaaf, mlb, nhl, nba, wnba, ncaab (men's college basketball), mma, soccer (with league), an ESPN soccer league like uefa.nations, or an Odds API sport key like soccer_epl"
          ),
        league: z
          .string()
          .optional()
          .describe('For sport=soccer: ESPN league, e.g. uefa.nations, eng.1'),
        teams_or_event: z
          .string()
          .optional()
          .describe(
            'Filter, e.g. "Rams", "Rams @ Eagles", "Portugal v Norway"'
          ),
        markets: z
          .array(z.enum([...ODDS_MARKETS, 'player_prop']))
          .optional()
          .describe(
            'Default h2h, spreads, totals (Odds API: 3 requests). h2h = moneyline. player_prop: OddsPapi only (over/under and yes/no player markets, main line per player).'
          ),
        player: z
          .string()
          .optional()
          .describe('player_prop: keep only players whose name contains this'),
        books: z
          .array(z.string())
          .optional()
          .describe(
            'Bookmaker keys, e.g. ["fanduel","draftkings","pinnacle"]. Default: all US books (OddsPapi: the US books plus Pinnacle).'
          ),
        source: z
          .enum(['oddsapi', 'oddspapi', 'both'])
          .optional()
          .describe('Default oddsapi. See the description.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Required when the call would cost more than the threshold'
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      const source = a.source ?? 'oddsapi';
      let key: string;
      try {
        key = sportKey(a.sport, a.league);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (source === 'oddsapi') {
        if (a.markets?.includes('player_prop'))
          return fail(
            'player_prop odds come from OddsPapi: call with source "oddspapi" or "both".'
          );
        return oddsApiOnly(key, a);
      }
      const markets = (a.markets ?? [...ODDS_MARKETS]) as NormMarket[];
      const warnings: string[] = [];
      const req = {
        sportKey: key,
        markets,
        ...(a.books ? { books: a.books } : {}),
        ...(a.teams_or_event ? { filter: a.teams_or_event } : {}),
        ...(a.player ? { player: a.player } : {}),
      };
      const papiProblem = !s.papi?.client.configured
        ? 'ODDSPAPI_KEY is not configured on the server'
        : !PAPI_COVERED.includes(key)
          ? `OddsPapi does not cover ${key} (it covers ${PAPI_COVERED.join(', ')})`
          : null;
      if (source === 'oddspapi' && papiProblem) return fail(`${papiProblem}.`);
      const useOddsApi = source === 'both' && s.odds.configured;
      if (source === 'both' && !s.odds.configured)
        warnings.push('oddsapi: ODDS_API_KEY is not configured');
      const prepared: PreparedCall[] = [];
      if (useOddsApi)
        prepared.push(await new OddsApiProvider(s.odds).prepare(req));
      if (papiProblem) warnings.push(`oddspapi: ${papiProblem}`);
      else
        try {
          prepared.push(await s.papi!.provider.prepare(req));
        } catch (e) {
          if (source === 'oddspapi') return fail((e as Error).message);
          warnings.push(
            `oddspapi: ${(e as Error).message}; showing Odds API data only`
          );
        }
      const over = prepared.filter((p) => p.cost > s.confirmAboveCost);
      if (over.length && !a.confirm)
        return json({
          requiresConfirmation: true,
          cost: Object.fromEntries(prepared.map((p) => [p.provider, p.cost])),
          message: `This call costs ${prepared.map((p) => `${p.cost} ${p.provider === 'oddsapi' ? 'Odds API' : 'OddsPapi'} requests`).join(' + ')}. Call again with confirm: true to proceed${a.teams_or_event ? '' : ', or filter with teams_or_event'}.`,
        });
      const results: ProviderResult[] = [];
      for (const p of prepared) {
        try {
          const r = await p.run();
          results.push(r);
          warnings.push(...r.warnings);
        } catch (e) {
          if (source === 'oddspapi' || p.provider === 'oddsapi')
            return fail((e as Error).message);
          warnings.push(
            `oddspapi: ${(e as Error).message}; showing Odds API data only`
          );
        }
      }
      const merged = mergeEvents(results.map((r) => r.events));
      return json({
        source,
        sportKey: key,
        cost: Object.fromEntries(results.map((r) => [r.provider, r.cost])),
        quota: Object.fromEntries(results.map((r) => [r.provider, r.quota])),
        ...(warnings.length ? { warnings } : {}),
        eventCount: merged.length,
        events: merged.slice(0, 10).map(mergedView),
      });
    }
  );

  /** check_odds with source oddsapi: exactly what it returned before. */
  async function oddsApiOnly(
    key: string,
    a: {
      markets?: string[];
      books?: string[];
      teams_or_event?: string;
      confirm?: boolean;
    }
  ) {
    if (!s.odds.configured)
      return fail('ODDS_API_KEY is not configured on the server.');
    const req = {
      sportKey: key,
      markets: (a.markets ?? [
        ...ODDS_MARKETS,
      ]) as (typeof ODDS_MARKETS)[number][],
      books: a.books,
    };
    const cost = s.odds.costOf(req);
    if (cost > s.confirmAboveCost && !a.confirm) {
      return json({
        requiresConfirmation: true,
        cost,
        quota: s.odds.quota(),
        message: `This call costs ${cost} Odds API requests. Call again with confirm: true to proceed.`,
      });
    }
    try {
      const r = await s.odds.getOdds(req);
      const matched = filterEvents(r.events, a.teams_or_event);
      return json({
        source: 'The Odds API',
        sportKey: key,
        cost: r.cost,
        cached: r.cached,
        quota: { remaining: r.quota.remaining, used: r.quota.used },
        eventCount: matched.length,
        events: matched.slice(0, 10).map((e) => oddsView(summarizeEvent(e))),
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  }

  server.registerTool(
    'get_historical_odds',
    {
      title: 'Historical odds (OddsPapi)',
      description: `A finished game's price history from OddsPapi, per book, for one market: the open (first price), the close (last price at or before the start), each book's no-vig close (fairClose), and with legId the price when the bet was placed (atBet, from the bet's placedAt). For backtesting line timing (opening vs closing vs bet time) and CLV; market data only, never an input to pWin. Name the game by legId, eventId (ours, e.g. espn:nba:401910025) or OddsPapi fixtureId. Free-plan history covers settled games only (from January 2026; prices from about 75 days before start). Cost: no monthly quota for the history itself, but each call of up to 3 books takes 5 s (more books = more 5 s calls); finding the fixture for an eventId/legId costs 1 request the first time (then it is remembered), a fixtureId 1 request. Prices: decimal as recorded, American derived from it. Spreads/totals: each book's main line at the close unless line is given (spreads: the home side's line).`,
      inputSchema: {
        legId: z.number().int().optional(),
        eventId: z.string().optional(),
        fixtureId: z
          .string()
          .optional()
          .describe('OddsPapi fixture id, e.g. id1100013273719724'),
        market: z.enum(ODDS_MARKETS).optional().describe('Default h2h'),
        line: z.number().optional(),
        books: z
          .array(z.string())
          .optional()
          .describe(
            'Default ["pinnacle","draftkings","fanduel"] (one 5 s call). Odds API keys or OddsPapi slugs.'
          ),
        includeHistory: z
          .boolean()
          .optional()
          .describe('Also return every price change (at most 200 per outcome)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      const papi = s.papi;
      if (!papi?.client.configured)
        return fail('ODDSPAPI_KEY is not configured on the server.');
      try {
        const target = await findFixtureFor(s.db, papi.client, a);
        const books = (
          a.books?.length ? a.books : ['pinnacle', 'draftkings', 'fanduel']
        ).map(papiSlug);
        const { byId } = await papi.lookups.markets();
        const hist = await papi.client.historical(
          target.fixture.fixtureId,
          books
        );
        const market = a.market ?? 'h2h';
        const out = summarizeHistory(hist, byId, {
          fixture: target.fixture,
          homeIsFirst: target.homeIsFirst,
          sportId: target.sportId,
          market,
          ...(a.line != null ? { line: a.line } : {}),
          ...(target.betAt ? { betAt: target.betAt } : {}),
          ...(a.includeHistory ? { includeHistory: true } : {}),
        });
        const missing = books
          .map((b) => b)
          .filter((b) => !hist.bookmakers?.[b]);
        return json({
          fixtureId: target.fixture.fixtureId,
          ...(target.eventId ? { eventId: target.eventId } : {}),
          start: new Date(Date.parse(target.fixture.startTime)).toISOString(),
          home: target.homeIsFirst
            ? target.fixture.participant1Name
            : target.fixture.participant2Name,
          away: target.homeIsFirst
            ? target.fixture.participant2Name
            : target.fixture.participant1Name,
          market,
          ...(target.leg ? { leg: target.leg } : {}),
          books: out,
          ...(missing.length
            ? { warnings: [`no history from ${missing.join(', ')}`] }
            : {}),
          quota: quotaView(await papi.client.usageNow()),
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'add_bet',
    {
      title: 'Add a bet',
      description: `Create a tracked bet (single or parlay) from structured input and match each leg to a live event (or, for series markets, a playoff series) by sport, date (America/Chicago) and fuzzy team/fighter names. Legs with exactly one confident match are linked; others come back with candidates to confirm via confirm_match (never guess). Returns the bet with current model P(win)/value/EV. ${UNITS} stake/statedPayout in dollars; price/boostedPrice/leg price in American odds; boostPct in percent. ${BONUS} Sports: nfl, ncaaf, mlb, nhl, nba, wnba, ncaab (men's college basketball, all of Division I; no player props yet), soccer, mma. Markets: moneyline (NHL includes OT/shootout; NBA and NCAAB include OT), moneyline3way (soccer), spread (incl. MLB run line and NHL puck line), total, player_prop, series_winner and series_spread (playoff series; mlb, nba, nhl, wnba). player_prop legs: participants are the two teams, prop {type, player, team: the player's team, one of participants}. Prop types: nfl anytime_td (selection yes, no line); nba points, rebounds, assists, threes, pra (points+rebounds+assists); mlb home_runs, total_bases, hits (batters), pitcher_strikeouts, pitcher_outs (outs recorded) — all over/under with a line (e.g. selection {kind: over}, line 24.5); to hit a HR = home_runs with selection yes and no line (or over 0.5). Player props are valued from their entered price de-vigged with an assumed hold (anytime TD: 8% up to +200, 15% above; over/unders and to hit a HR: 7% up to +200, 12% above), move live with the box score, and settle from ESPN's final box score (anytime TD: rushing/receiving/return TDs count, passing TDs don't); if the player has no box score line (or did not play), the leg stays open to settle by hand with settle_bet (void if the book voided it). Series legs: selection {kind: team, team}; series_spread takes line = games won minus lost from the backed team's side (Brewers -2.5 = win the series by 3+ games, i.e. 4-0 or 4-1; +1.5 = win, or lose 3-4); eventDate = the date of any game in the series. They link to the series (ESPN season + both teams), are valued by simulating the remaining games from the current series state with per-game win probabilities (each game's own ESPN line, else a strength from the latest line or the entered price, adjusted for home/away; a game in progress uses ESPN's live win probability), and settle when the series ends. Set placedLive for bets placed during the game. Pregame, each game leg's P(win) is matched to the market's fair price for that exact line when one is known (ESPN/Odds API, else the entered price de-vigged); that adjustment fades as the game plays. Set origin on every new bet: ${ORIGIN} For a bet you recommended, also set recommendedAt (when you recommended it) and each leg's recommendedPrice (the price you quoted), so price movement before placement can be split from movement after. ${PROVENANCE}`,
      inputSchema: betInputSchema,
    },
    async (input) => {
      let bet;
      try {
        bet = createBet(s.db, input);
      } catch (e) {
        return fail(`Invalid bet: ${(e as Error).message}`);
      }
      let matchError: string | undefined;
      try {
        await matchLegs(
          s.db,
          s.providers,
          bet.legs.map((l) => l.id)
        );
      } catch (e) {
        // Saved anyway; unmatched legs are retried every 10 minutes.
        matchError = (e as Error).message;
      }
      await refresh(s);
      const view = betViewById(s.db, getBet(s.db, bet.bet.id)!);
      const pending = view.legs.filter((l) => l.match.status !== 'matched');
      return json({
        bet: view,
        matching: pending.length
          ? {
              needsAttention: pending.map((l) => ({
                legId: l.id,
                eventLabel: l.eventLabel,
                status: l.match.status,
                candidates: l.match.candidates ?? [],
              })),
              hint: 'Show Dan the candidates; call confirm_match(legId, eventId) with his choice. Unmatched legs are retried automatically every 10 minutes.',
            }
          : 'all legs matched',
        ...(matchError ? { matchError } : {}),
      });
    }
  );

  server.registerTool(
    'confirm_match',
    {
      title: 'Confirm a leg’s event',
      description:
        'Link a leg to one of the candidate events add_bet returned for it (eventId from the candidates list; for series legs the candidate is a series). Only stored candidates are accepted.',
      inputSchema: {
        legId: z.number().int(),
        eventId: z
          .string()
          .describe(
            'e.g. espn:ncaaf:401858474, mlb:849829, or a series espn:mlb:series:2026:8-30'
          ),
      },
    },
    async ({ legId, eventId }) => {
      try {
        const r = confirmLegMatch(s.db, legId, eventId);
        await refresh(s);
        const bet = getBet(s.db, r.betId)!;
        return json({ confirmed: r, bet: betViewById(s.db, bet) });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'list_bets',
    {
      title: 'List bets',
      description: `Bets with stake, prices, payout, origin and current model P(win), value (expected return) and EV now (value - stake), plus EV at placement (from the pregame prior, or the de-vigged entered price for live bets), and once games near their start the closing line: per leg close {p, price, line, source: exact | interpolated | unsupported | missed | live, snapshotAt}, clv (close.p - pWinAtPlacement) and clvPct, priceClv (placed price at the de-vigged closing fair: fair x decimal price - 1), close.fair and close.book {key, price} (the bet's own book at close, vig in), recommendedPrice, priceMove {recToPlaced, placedToClose}, hoursBeforeStart and timing (>12h | 2-12h | <2h); per bet recommendedAt, timing {placedAt, placedAtSource: entered | created (no placedAt: when it was entered, if before the game), hoursBeforeStart (to the first leg), bucket}, atClose {pWin, value, ev, source} and clv (pWin at close / at placement - 1). Null = not resolved yet, or a bet from before CLV. Legs include live score/situation (series legs: the series score and next game; props: the stat so far). ${UNITS} ${ORIGIN} ${PROVENANCE}`,
      inputSchema: {
        status: z.enum(BET_STATUSES).optional().describe('Default: all'),
        origin: z
          .enum(ORIGIN_FILTERS)
          .optional()
          .describe(
            'recommended | own | untagged (no origin yet). Default: all'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, origin }) => json(betViews(s.db, status, origin))
  );

  server.registerTool(
    'get_bet',
    {
      title: 'Get a bet',
      description: `Full detail for one bet: each leg's live state (score, clock/inning, situation; series legs: the series score and next game), model name and inputs (means/sds, run rates, minutes left...; props: the stat so far, minutes/plate appearances/pitches and the mean still to come; series: per-game win probabilities), the prior used (source: espn_lines | pregame_snapshot | entered_odds | neutral, or entered_price for player props, with its numbers), P(win) now and at placement, value and EV, and the closing line (close, clv, clvPct per leg; atClose, clv per bet; see list_bets). Debug, on open legs in progress (moneyline/spread): liveMarket = the live market's de-vigged moneyline for the backed team, found by name (marketWin, books, asOf) beside our model's P(side wins the game) (modelWin) and drift = marketWin - modelWin; for spotting model drift only, never used for pWin (one cached Odds API h2h request per sport when stale; null = no match or quota floor). A leg's warnings (absent when none; also on list_bets) flag a likely home/away side mismatch: in progress with ESPN's win probability for the backed team more than 0.5 from our P(win), or (get_bet only) the live market for the backed team more than 0.5 from modelWin, or the event's stored home/away disagreeing with its latest state. Tell Dan; recompute_bet re-derives the side. ${UNITS} ${PROVENANCE}`,
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = getBet(s.db, id);
      if (!b) return fail(`Bet ${id} not found`);
      const view = betViewById(s.db, b);
      if (!s.liveMarket) return json(view);
      const market = await s.liveMarket.forLegs(
        b.legs.map((leg) => ({
          leg,
          event: leg.eventId ? eventRow(s.db, leg.eventId) : undefined,
        }))
      );
      return json({
        ...view,
        legs: view.legs.map((l) => {
          if (!market.has(l.id)) return l;
          const m = market.get(l.id);
          const w = m && liveMarketWarning(m);
          return {
            ...l,
            liveMarket: m,
            ...(w ? { warnings: [...(l.warnings ?? []), w] } : {}),
          };
        }),
      });
    }
  );

  server.registerTool(
    'update_bet',
    {
      title: 'Update a bet',
      description: `Edit bet-level fields. ${UNITS} stake/statedPayout in dollars; price/boostedPrice in American odds; boostPct in percent. ${BONUS} settledAt corrects when a settled bet settled (it normally comes from its games' final times; a later recompute re-derives it). ${ORIGIN} Pass null to clear an optional field. Legs are edited with update_leg.`,
      inputSchema: {
        id: z.number().int(),
        fields: z
          .object({
            book: z.string().min(1),
            externalBetId: z.string().nullable(),
            placedAt: z.iso.datetime({ offset: true }).nullable(),
            placedLive: z.boolean(),
            stake: z.number().positive(),
            price: z.number().int(),
            boostPct: z.number().positive().nullable(),
            boostKind: z.enum(BOOST_KINDS).nullable(),
            boostedPrice: z.number().int().nullable(),
            statedPayout: z.number().positive().nullable(),
            bonusBet: z.boolean(),
            tokenInfo: z.string().nullable(),
            notes: z.string().nullable(),
            origin: z
              .enum(BET_ORIGINS)
              .nullable()
              .describe('recommended | own; null = untagged'),
            settledAt: z.iso.datetime({ offset: true }).nullable(),
            recommendedAt: z.iso
              .datetime({ offset: true })
              .nullable()
              .describe('When Claude recommended it; null clears'),
          })
          .partial(),
      },
    },
    async ({ id, fields }) => {
      const { settledAt, ...rest } = fields;
      try {
        const b = updateBet(s.db, id, rest);
        if (!b) return fail(`Bet ${id} not found`);
        // Placement values depend on prices, boost and placed time: rebuild
        // (notes and origin don't move any number).
        const { notes: _n, origin: _o, recommendedAt: _r, ...priced } = rest;
        if (Object.keys(priced).length) s.tracker.recomputeBet(id);
        // After the recompute, which would re-derive it.
        if (settledAt !== undefined) updateBet(s.db, id, { settledAt });
      } catch (e) {
        return fail((e as Error).message);
      }
      return json(betViewById(s.db, getBet(s.db, id)!));
    }
  );

  server.registerTool(
    'update_leg',
    {
      title: 'Update a leg',
      description: `Fix one leg of a bet: its price (American odds, as placed), line (from the selection's side, e.g. -1.5; a prop or series spread line) and/or selection (kind team/over/under/draw/yes, and team for team and series picks; must be one of the leg's two participants; a player prop keeps its prop type, player and team). Re-validated like add_bet. Then the whole bet is recomputed: prior from its own prices, P(win) at placement and now, same-game joints, and settlement if the game is final. recommendedPrice (this leg's price when Claude recommended it) and recommendedAt (the bet's recommendation time) only record the recommendation: no recompute. ${UNITS}`,
      inputSchema: {
        legId: z.number().int(),
        fields: z
          .object({
            price: z.number().int(),
            line: z.number().nullable(),
            selection: z.object({
              kind: z.enum(SELECTION_KINDS),
              team: z.string().optional(),
            }),
            recommendedPrice: z
              .number()
              .int()
              .nullable()
              .describe(
                'The price (American) when Claude recommended this leg; null clears'
              ),
            recommendedAt: z.iso
              .datetime({ offset: true })
              .nullable()
              .describe(
                "When Claude recommended the bet (sets the bet's recommendedAt; null clears)"
              ),
          })
          .partial(),
      },
    },
    async ({ legId, fields }) => {
      try {
        const { recommendedAt, ...legFields } = fields;
        const leg = updateLeg(s.db, legId, legFields);
        if (recommendedAt !== undefined)
          updateBet(s.db, leg.betId, { recommendedAt });
        // Recommendation fields alone don't move any number.
        const { recommendedPrice: _rp, ...priced } = legFields;
        const r = Object.keys(priced).length
          ? s.tracker.recomputeBet(leg.betId)
          : null;
        const view = betViewById(s.db, getBet(s.db, leg.betId)!);
        return json(r?.warnings ? { ...view, warnings: r.warnings } : view);
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'recompute_bet',
    {
      title: 'Recompute a bet',
      description:
        "Rebuild a bet's derived numbers from scratch: each leg's prior from the event's market lines plus this bet's own entered prices, P(win) and EV at placement (market lines as of the bet's placed time), market anchors, same-game joints, and settlement from final scores (the bet status is re-derived from its legs). Each team leg's home/away side is re-derived from its event by team name first (an event ESPN has since swapped home/away for is re-oriented). A manual settle_bet result that disagrees with what the legs now say is kept, with a warning (settle_bet again to accept the legs' result). Use after correcting data, or when a bet looks stale.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      if (!getBet(s.db, id)) return fail(`Bet ${id} not found`);
      const r = s.tracker.recomputeBet(id);
      const view = betViewById(s.db, getBet(s.db, id)!);
      return json(r.warnings ? { ...view, warnings: r.warnings } : view);
    }
  );

  server.registerTool(
    'settle_bet',
    {
      title: 'Settle a bet by hand',
      description:
        'Record a bet result manually (won/lost/push/void), overriding what the legs say; "open" reopens it. A single player prop bet\'s leg takes the same result. With legId, settle just that leg (e.g. a player prop in a parlay) and re-derive the bet from its legs. Bets normally settle automatically when their games go final (series legs when the series ends); player props settle from the final box score when ESPN has the player (a player with no line, or an NBA player who did not play, needs this; void if the book voided it).',
      inputSchema: {
        id: z.number().int(),
        result: z.enum(BET_STATUSES),
        legId: z
          .number()
          .int()
          .optional()
          .describe('Settle only this leg of the bet'),
      },
    },
    async ({ id, result, legId }) => {
      if (legId == null) {
        const b = settleBet(s.db, id, result);
        return b ? json(betViewById(s.db, b)) : fail(`Bet ${id} not found`);
      }
      if (!getBet(s.db, id)?.legs.some((l) => l.id === legId))
        return fail(`Bet ${id} has no leg ${legId}`);
      try {
        return json(betViewById(s.db, settleLeg(s.db, legId, result)));
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'remove_bet',
    {
      title: 'Remove a bet',
      description:
        'Permanently delete a bet with its legs and calibration snapshots. Confirm with Dan first.',
      inputSchema: { id: z.number().int() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) =>
      removeBet(s.db, id) ? json({ removed: id }) : fail(`Bet ${id} not found`)
  );

  server.registerTool(
    'portfolio',
    {
      title: 'Portfolio',
      description: `Totals for open bets (staked, current value, EV now) and settled bets (staked, returned, profit); byOrigin breaks them down by origin (recommended / own / untagged): stake, profit/loss, ROI, and for settled bets EV at placement next to the realized profit (expectedRoi vs roi, realizedVsExpected), and closing line value: clvCount (bets with CLV), avgClv (stake-weighted), clvLegCount, pctBeatClose (share of legs with clv > 0), evAtClose with evAtPlacementWithClv and profitWithClv over the same bets (these CLVs are close vs P(win) at placement); byTiming (hours from placement to the leg's start: >12h, 2-12h, <2h, unknown) and bySport break down leg price CLV, the placed price at the de-vigged closing fair (fair x decimal price - 1, so > 0 beat the close; parlay legs at their own leg price; each leg weighs its bet's stake split over its legs): legCount, clvCount, avgClv, pctBeatClose, and where legs have a recommendedPrice, priceMove {count, recToPlaced, closeCount, placedToClose} (decimal-odds ratios, positive = better for Dan: placed vs recommended, placed vs the book's own closing price); plus an exposure grid for every event carrying two or more open bets: expected P&L per outcome for each bet and net. Moneyline singles are exact; parlays weight by their other legs' current model P(win). origin filters everything to one origin. ${UNITS} ${ORIGIN} ${PROVENANCE}`,
      inputSchema: {
        origin: z
          .enum(ORIGIN_FILTERS)
          .optional()
          .describe(
            'recommended | own | untagged (no origin yet). Default: all'
          ),
        sport: z
          .enum(BET_SPORTS)
          .optional()
          .describe(
            'Only bets with a leg in this sport; byTiming/bySport count only those legs'
          ),
        timing: z
          .enum(TIMING_BUCKETS)
          .optional()
          .describe(
            'Only bets with a leg placed this long before its start (>12h | 2-12h | <2h); byTiming/bySport count only those legs'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ origin, sport, timing }) =>
      json({
        ...portfolio(s.db, { origin, sport, timing }),
        oddsApiQuota: s.odds.quota(),
      })
  );

  // --- Scores: games followed for their score (not bets) --------------------

  const sport = z
    .enum(SPORTS)
    .describe(
      "ncaab = men's college basketball (all of Division I). Scores-only (no bets): ncaamh / ncaawh = men's / women's college hockey, ncaawvb = women's college volleyball"
    );
  const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Local (America/Chicago) date YYYY-MM-DD; default today');

  server.registerTool(
    'scores',
    {
      title: 'Scores',
      description:
        "Dan's Scores board: live, upcoming and recently finished games he watches (starred games and followed teams' games) plus games he has an open bet on, each with score, clock/situation and whether alerts are on; also followed teams and recent alerts (ntfy push).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(s.scores.board())
  );

  server.registerTool(
    'list_games',
    {
      title: 'List games',
      description:
        "A sport's schedule on a date (from ESPN / MLB Stats API) with event ids and whether each game is already watched. Use to find a game for watch_game.",
      inputSchema: { sport, date },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        return json(await s.scores.schedule(a.sport, a.date));
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'watch_game',
    {
      title: 'Watch a game',
      description:
        'Add one game to the Scores board (live score + alerts for start, lead changes, close late, final). Give eventId (from list_games) or teams ("Packers @ Bears" or just "Bears"). Anything but exactly one confident game returns candidates: show Dan and call again with his choice\'s eventId; never pick one yourself.',
      inputSchema: {
        sport,
        date,
        eventId: z.string().optional(),
        teams: z.string().optional(),
        alerts: z.boolean().optional().describe('Default true'),
      },
    },
    async (a) => {
      try {
        return json(await s.scores.watchGame(a));
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'unwatch_game',
    {
      title: 'Stop watching a game',
      description:
        "Remove a game from the Scores board (a followed team's game is hidden, not re-added).",
      inputSchema: { eventId: z.string() },
    },
    async ({ eventId }) => {
      try {
        s.scores.unwatchGame(eventId);
        return json({ unwatched: eventId });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'follow_team',
    {
      title: 'Follow a team',
      description:
        'Follow a team: its games in the next week are added to the Scores board automatically (rescanned hourly). The name is resolved against the next 3 weeks of games, else the league\'s team list (offseason: games are added once scheduled); an ambiguous name ("Chicago") returns candidate team names to ask Dan about.',
      inputSchema: {
        sport,
        team: z.string().describe('e.g. "Bears", "Chicago Cubs"'),
        alerts: z.boolean().optional().describe('Default true'),
      },
    },
    async (a) => {
      try {
        return json(await s.scores.followTeam(a.sport, a.team, a.alerts));
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'unfollow_team',
    {
      title: 'Unfollow a team',
      description:
        'Stop following a team (followId from scores.follows) and drop its auto-added games.',
      inputSchema: { followId: z.number().int() },
    },
    async ({ followId }) => {
      try {
        return json({ unfollowed: s.scores.unfollowTeam(followId) });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  server.registerTool(
    'set_score_alerts',
    {
      title: 'Score alerts on/off',
      description:
        'Turn push alerts on or off for one watched game (eventId) or a followed team (followId; applies to its games).',
      inputSchema: {
        eventId: z.string().optional(),
        followId: z.number().int().optional(),
        on: z.boolean(),
      },
    },
    async (a) => {
      try {
        if (a.eventId) s.scores.setAlerts({ eventId: a.eventId }, a.on);
        else if (a.followId != null)
          s.scores.setAlerts({ followId: a.followId }, a.on);
        else return fail('Give eventId or followId');
        return json({ ok: true });
      } catch (e) {
        return fail((e as Error).message);
      }
    }
  );

  return server;
}
