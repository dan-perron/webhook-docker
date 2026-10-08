import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  createBet,
  getBet,
  removeBet,
  settleBet,
  updateBet,
  updateLeg,
} from '../db/bets.js';
import type { Db } from '../db/client.js';
import { betInputSchema } from '../domain/betInput.js';
import { BET_STATUSES, BOOST_KINDS, SELECTION_KINDS } from '../domain/types.js';
import type { Providers } from '../gamestate/registry.js';
import { confirmLegMatch, matchLegs } from '../matching/service.js';
import { filterEvents, oddsView, summarizeEvent } from '../odds/consensus.js';
import { ODDS_MARKETS, sportKey, type OddsApiClient } from '../odds/oddsApi.js';
import type { Tracker } from '../tracker/tracker.js';
import { betViewById, betViews, portfolio } from '../tracker/views.js';

export interface Services {
  db: Db;
  providers: Providers;
  tracker: Tracker;
  odds: OddsApiClient;
  /** check_odds calls costing more than this need confirm: true. */
  confirmAboveCost: number;
}

const UNITS =
  'Units: money in US dollars; prices in American odds (e.g. +150, -110); probabilities 0..1.';
const PROVENANCE =
  "pWin/pPush/value/ev come from our state-based models (live score, clock, situation + a pregame prior), never from live odds; when now.source is 'book_implied' the bet has same-game legs without a joint model and pWin is the book's unboosted price instead. price/payout are what the book offered, as entered.";

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
      instructions: `Tracks Dan's sportsbook bets with live, game-state-based win probabilities. ${UNITS} ${PROVENANCE} Use check_odds for current market lines (costs Odds API quota). When add_bet returns legs needing confirmation, show Dan the candidates and call confirm_match with his choice; never pick one yourself.`,
    }
  );

  server.registerTool(
    'check_odds',
    {
      title: 'Check current odds',
      description: `Current lines from The Odds API for a sport, optionally filtered to teams/an event. Returns, per market, each outcome with its own point (spreads: e.g. Brewers -1.5 / Padres +1.5; totals: the line), every book's American price (from the API) and de-vigged fair probability (computed), the cross-book consensus and best price, and the market's average hold, and the Odds API quota remaining after the call. Each call costs markets x regions requests (60 s cache is free); calls costing more than the confirmation threshold return the cost and need confirm: true. ${UNITS}`,
      inputSchema: {
        sport: z
          .string()
          .describe(
            'nfl, ncaaf, mlb, nhl, wnba, mma, soccer (with league), an ESPN soccer league like uefa.nations, or an Odds API sport key like soccer_epl'
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
          .array(z.enum(ODDS_MARKETS))
          .optional()
          .describe(
            'Default h2h, spreads, totals (3 requests). h2h = moneyline.'
          ),
        books: z
          .array(z.string())
          .optional()
          .describe(
            'Bookmaker keys, e.g. ["fanduel","draftkings"]. Default: all US books.'
          ),
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
      if (!s.odds.configured)
        return fail('ODDS_API_KEY is not configured on the server.');
      let key: string;
      try {
        key = sportKey(a.sport, a.league);
      } catch (e) {
        return fail((e as Error).message);
      }
      const req = {
        sportKey: key,
        markets: a.markets ?? [...ODDS_MARKETS],
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
  );

  server.registerTool(
    'add_bet',
    {
      title: 'Add a bet',
      description: `Create a tracked bet (single or parlay) from structured input and match each leg to a live event by sport, date (America/Chicago) and fuzzy team/fighter names. Legs with exactly one confident match are linked; others come back with candidates to confirm via confirm_match (never guess). Returns the bet with current model P(win)/value/EV. ${UNITS} stake/statedPayout in dollars; price/boostedPrice/leg price in American odds; boostPct in percent. Sports: nfl, ncaaf, mlb, nhl, wnba, soccer, mma. Markets: moneyline (NHL includes OT/shootout), moneyline3way (soccer), spread (incl. MLB run line and NHL puck line), total. Set placedLive for bets placed during the game. Pregame, each leg's P(win) is matched to the market's fair price for that exact line when one is known (ESPN/Odds API, else the entered price de-vigged); that adjustment fades as the game plays. ${PROVENANCE}`,
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
        'Link a leg to one of the candidate events add_bet returned for it (eventId from the candidates list). Only stored candidates are accepted.',
      inputSchema: {
        legId: z.number().int(),
        eventId: z.string().describe('e.g. espn:ncaaf:401858474 or mlb:849829'),
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
      description: `Bets with stake, prices, payout and current model P(win), value (expected return) and EV now (value - stake), plus EV at placement (from the pregame prior, or the de-vigged entered price for live bets). Legs include live score/situation. ${UNITS} ${PROVENANCE}`,
      inputSchema: {
        status: z.enum(BET_STATUSES).optional().describe('Default: all'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json(betViews(s.db, status))
  );

  server.registerTool(
    'get_bet',
    {
      title: 'Get a bet',
      description: `Full detail for one bet: each leg's live state (score, clock/inning, situation), model name and inputs (means/sds, run rates, minutes left...), the prior used (source: espn_lines | pregame_snapshot | entered_odds | neutral, with its numbers), P(win) now and at placement, value and EV. ${UNITS} ${PROVENANCE}`,
      inputSchema: { id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const b = getBet(s.db, id);
      return b ? json(betViewById(s.db, b)) : fail(`Bet ${id} not found`);
    }
  );

  server.registerTool(
    'update_bet',
    {
      title: 'Update a bet',
      description: `Edit bet-level fields. ${UNITS} stake/statedPayout in dollars; price/boostedPrice in American odds; boostPct in percent. settledAt corrects when a settled bet settled (it normally comes from its games' final times; a later recompute re-derives it). Pass null to clear an optional field. Legs are not editable (remove and re-add instead).`,
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
            tokenInfo: z.string().nullable(),
            notes: z.string().nullable(),
            settledAt: z.iso.datetime({ offset: true }).nullable(),
          })
          .partial(),
      },
    },
    async ({ id, fields }) => {
      const { settledAt, ...rest } = fields;
      try {
        const b = updateBet(s.db, id, rest);
        if (!b) return fail(`Bet ${id} not found`);
        // Placement values depend on prices, boost and placed time: rebuild.
        if (Object.keys(rest).length) s.tracker.recomputeBet(id);
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
      description: `Fix one leg of a bet: its price (American odds, as placed), line (from the selection's side, e.g. -1.5) and/or selection (kind team/over/under/draw, and team for team picks; must be one of the leg's two participants). Re-validated like add_bet. Then the whole bet is recomputed: prior from its own prices, P(win) at placement and now, same-game joints, and settlement if the game is final. ${UNITS}`,
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
          })
          .partial(),
      },
    },
    async ({ legId, fields }) => {
      try {
        const leg = updateLeg(s.db, legId, fields);
        s.tracker.recomputeBet(leg.betId);
        return json(betViewById(s.db, getBet(s.db, leg.betId)!));
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
        "Rebuild a bet's derived numbers from scratch: each leg's prior from the event's market lines plus this bet's own entered prices, P(win) and EV at placement (market lines as of the bet's placed time), market anchors, same-game joints, and settlement from final scores (the bet status is re-derived from its legs; a manual settle_bet result is replaced). Use after correcting data, or when a bet looks stale.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      if (!getBet(s.db, id)) return fail(`Bet ${id} not found`);
      s.tracker.recomputeBet(id);
      return json(betViewById(s.db, getBet(s.db, id)!));
    }
  );

  server.registerTool(
    'settle_bet',
    {
      title: 'Settle a bet by hand',
      description:
        'Record a bet result manually (won/lost/push/void), overriding what the legs say; "open" reopens it. Bets normally settle automatically when their games go final.',
      inputSchema: {
        id: z.number().int(),
        result: z.enum(BET_STATUSES),
      },
    },
    async ({ id, result }) => {
      const b = settleBet(s.db, id, result);
      return b ? json(betViewById(s.db, b)) : fail(`Bet ${id} not found`);
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
      description: `Totals for open bets (staked, current value, EV now) and settled bets (staked, returned, profit), plus an exposure grid for every event carrying two or more open bets: expected P&L per outcome for each bet and net. Moneyline singles are exact; parlays weight by their other legs' current model P(win). ${UNITS} ${PROVENANCE}`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ ...portfolio(s.db), oddsApiQuota: s.odds.quota() })
  );

  return server;
}
