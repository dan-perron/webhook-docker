import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { bets, events, legs } from '../src/db/schema.js';
import { createProviders } from '../src/gamestate/registry.js';
import { OddsApiClient, type OddsFetch } from '../src/odds/oddsApi.js';
import {
  findFixture,
  OddsPapiClient,
  toOddsEvent,
  type PapiFixture,
  type PapiHistorical,
} from '../src/odds/oddsPapi.js';
import { legPriceClv, type LegClose } from '../src/tracker/clv.js';
import { preState, Tracker } from '../src/tracker/tracker.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

// OddsPapi closes, from trimmed real responses (test/fixtures/oddspapi).
// As of 00:55Z (tip 01:00 - 5 min), last entry at or before it:
//   FanDuel    ML Dallas 1.49 -> -204, Clippers 2.72 -> +172 (00:52:54)
//   DraftKings ML Dallas 1.524 -> -191, Clippers 2.6 -> +160 (22:36:49)
// (each book's 00:55:0x entries come after the cutoff and are ignored).
// De-vig (proportional):
//   FD .671053 / (.671053 + .367647) = .646051
//   DK .656357 / (.656357 + .384615) = .630523; consensus mean .638287
// Main lines (two prices closest to even): DK spread -4.5 (1.885/1.935),
// total 230.5 (1.926/1.893); FD spread -5.5 (1.93/1.89), total 229.5.
const FIXTURES = fixture<PapiFixture[]>(
  'oddspapi/nba-2026-11-22-fixtures.json'
);
const HIST = fixture<PapiHistorical>('oddspapi/nba-dal-lac-historical.json');
const START = '2026-11-22T01:00:00.000Z';
const AS_OF = Date.parse(START) - 5 * 60_000;
const MAVS = { homeName: 'Dallas Mavericks', awayName: 'LA Clippers' };

describe('findFixture', () => {
  it('matches ESPN names to the fixture, either way round', () => {
    const e = { ...MAVS, startTime: START };
    expect(findFixture(FIXTURES, e)).toMatchObject({
      fixture: { fixtureId: 'id1100013273719724' },
      homeIsFirst: true,
    });
    const swapped = FIXTURES.map((f) => ({
      ...f,
      participant1Name: f.participant2Name,
      participant2Name: f.participant1Name,
    }));
    expect(findFixture(swapped, e)?.homeIsFirst).toBe(false);
    expect(
      findFixture(FIXTURES, { ...e, startTime: '2026-11-23T01:00:00.000Z' })
    ).toBeUndefined();
  });
});

describe('toOddsEvent', () => {
  const f = FIXTURES[1]!;
  const ev = toOddsEvent(
    f,
    true,
    HIST,
    11,
    ['h2h', 'spreads', 'totals'],
    AS_OF
  );
  const book = (k: string) => ev.bookmakers.find((b) => b.key === k)!;
  const market = (k: string, m: string) =>
    book(k).markets.find((x) => x.key === m)!.outcomes;

  it('US books only, prices as of the cutoff, in American odds', () => {
    expect(ev.bookmakers.map((b) => b.key).sort()).toEqual([
      'draftkings',
      'fanduel',
    ]);
    expect(ev).toMatchObject({
      home_team: 'Dallas Mavericks',
      away_team: 'LA Clippers',
      commence_time: START,
    });
    expect(market('fanduel', 'h2h')).toEqual([
      { name: 'Dallas Mavericks', price: -204 },
      { name: 'LA Clippers', price: 172 },
    ]);
    expect(market('draftkings', 'h2h')).toEqual([
      { name: 'Dallas Mavericks', price: -191 },
      { name: 'LA Clippers', price: 160 },
    ]);
  });

  it("each book's main spread and total", () => {
    // DK -4.5: 1.885 -> -113, 1.935 -> -107
    expect(market('draftkings', 'spreads')).toEqual([
      { name: 'Dallas Mavericks', price: -113, point: -4.5 },
      { name: 'LA Clippers', price: -107, point: 4.5 },
    ]);
    expect(market('fanduel', 'spreads')[0]!.point).toBe(-5.5);
    // DK 230.5: 1.926 -> -108, 1.893 -> -112
    expect(market('draftkings', 'totals')).toEqual([
      { name: 'Over', price: -108, point: 230.5 },
      { name: 'Under', price: -112, point: 230.5 },
    ]);
    expect(market('fanduel', 'totals')[0]!.point).toBe(229.5);
  });

  it('home listed second: sides and spread points flip', () => {
    const flipped = toOddsEvent(f, false, HIST, 11, ['h2h', 'spreads'], AS_OF);
    const dk = flipped.bookmakers.find((b) => b.key === 'draftkings')!;
    expect(flipped.home_team).toBe('LA Clippers');
    expect(dk.markets.find((m) => m.key === 'spreads')!.outcomes).toEqual([
      { name: 'LA Clippers', price: -107, point: 4.5 },
      { name: 'Dallas Mavericks', price: -113, point: -4.5 },
    ]);
  });
});

describe('backfill from OddsPapi', () => {
  let db: Db;
  let calls: string[];
  let papiError: string | null;

  const papiFetch: OddsFetch = async (url) => {
    calls.push(url);
    const body = papiError
      ? { error: { code: papiError } }
      : url.includes('/fixtures?')
        ? FIXTURES
        : HIST;
    return {
      ok: !papiError,
      status: papiError ? 400 : 200,
      headers: { get: () => null },
      json: async () => body,
    };
  };
  const oddsApiFetch: OddsFetch = async (url) => {
    calls.push(url);
    return {
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({
        error_code: 'HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN',
      }),
    };
  };

  function tracker(opts: { historical?: boolean; papi?: boolean } = {}) {
    return new Tracker(
      db,
      createProviders(async () => ({ events: [] })),
      {
        params: PARAMS,
        polling: { liveSeconds: 30, scheduledSeconds: 600 },
        now: () => new Date('2026-11-22T15:00:00Z'),
        clv: {
          client: new OddsApiClient(db, {
            apiKey: 'k',
            baseUrl: 'http://odds',
            regions: 'us',
            cacheSeconds: 0,
            fetch: oddsApiFetch,
          }),
          enabled: true,
          leadMinutes: 5,
          windowMinutes: 15,
          retrySeconds: 60,
          quotaFloor: 40,
          historical: opts.historical ?? false,
          ...(opts.papi === false
            ? {}
            : {
                papi: new OddsPapiClient({
                  apiKey: 'p',
                  baseUrl: 'http://papi',
                  books: ['draftkings', 'fanduel'],
                  fetch: papiFetch,
                  sleep: async () => {},
                }),
              }),
        },
      }
    );
  }

  /** Bet 166's Mavs leg: DK, Dallas ML -190, settled, given close. */
  function mavsLeg(close: LegClose | null): number {
    const row = {
      id: 'espn:nba:401910025',
      sport: 'nba' as const,
      provider: 'espn',
      providerEventId: '401910025',
      startTime: START,
      ...MAVS,
      status: 'final' as const,
      nextPollAt: '2030-01-01T00:00:00.000Z',
    };
    db.insert(events)
      .values({
        ...row,
        stateJson: JSON.stringify(
          preState({ ...row, homeAbbr: null, awayAbbr: null } as never)
        ),
      })
      .run();
    const { bet, legs: rows } = createBet(db, {
      book: 'DraftKings',
      stake: 10,
      price: -190,
      legs: [
        {
          sport: 'nba',
          eventDate: '2026-11-21',
          participants: ['LA Clippers', 'Dallas Mavericks'],
          market: 'moneyline',
          selection: { kind: 'team', team: 'Dallas Mavericks' },
          price: -190,
        },
      ],
    });
    db.update(legs)
      .set({
        eventId: row.id,
        matchStatus: 'matched',
        side: 'home',
        status: 'won',
        pWinPlacement: 0.636113,
        pPushPlacement: 0,
        closeJson: close && JSON.stringify(close),
      })
      .where(eq(legs.id, rows[0]!.id))
      .run();
    db.update(bets).set({ status: 'won' }).where(eq(bets.id, bet.id)).run();
    return rows[0]!.id;
  }
  const close = (id: number) =>
    JSON.parse(
      db.select().from(legs).where(eq(legs.id, id)).get()!.closeJson!
    ) as LegClose;
  const UNSUPPORTED: LegClose = {
    p: null,
    price: null,
    line: null,
    source: 'unsupported',
    snapshotAt: '2026-11-22T00:55:02.948Z',
  };

  beforeEach(() => {
    db = openDb(':memory:');
    calls = [];
    papiError = null;
  });

  it('re-closes a named leg over its stored close', async () => {
    const id = mavsLeg(UNSUPPORTED);
    const r = await tracker().backfillCloses({
      source: 'oddspapi',
      legIds: [id],
    });
    expect(r).toMatchObject({ source: 'oddspapi', filled: 1, spent: 1 });
    // One fixtures lookup (tip +/- 3 h), one historical call (2 books).
    expect(calls).toHaveLength(2);
    const fx = new URL(calls[0]!);
    expect(fx.pathname).toBe('/fixtures');
    expect(fx.searchParams.get('tournamentId')).toBe('132');
    expect(fx.searchParams.get('from')).toBe('2026-11-21T22:00:00Z');
    expect(new URL(calls[1]!).searchParams.get('bookmakers')).toBe(
      'draftkings,fanduel'
    );
    const c = close(id);
    expect(c).toMatchObject({
      source: 'exact',
      via: 'oddspapi',
      snapshotAt: '2026-11-22T00:55:00.000Z',
      book: { key: 'draftkings', price: -191 },
    });
    expect(c.fair).toBeCloseTo(0.638287, 5);
    // priceClv = .638287 x decimal(-190) 1.526316 - 1 = -.025773
    const leg = db.select().from(legs).where(eq(legs.id, id)).get()!;
    expect(legPriceClv(leg)).toBeCloseTo(-0.025773, 5);
  });

  it('without legIds a stored close is left alone', async () => {
    mavsLeg(UNSUPPORTED);
    const r = await tracker().backfillCloses({ source: 'oddspapi' });
    expect(r.missingClose).toBe(0);
    expect(calls).toEqual([]);
  });

  it('auto: OddsPapi when historical is off; dry run costs 1 per window', async () => {
    mavsLeg(null);
    const r = await tracker().backfillCloses({ dryRun: true });
    expect(r).toMatchObject({
      source: 'oddspapi',
      windows: 1,
      estimatedCost: 1,
    });
    expect(calls).toEqual([]);
  });

  it('auto: an Odds API plan refusal moves on to OddsPapi', async () => {
    const id = mavsLeg(null);
    const r = await tracker({ historical: true }).backfillCloses();
    expect(r).toMatchObject({
      source: 'oddspapi',
      planAvailable: false,
      filled: 1,
    });
    expect(calls[0]).toContain('/historical/');
    expect(close(id).via).toBe('oddspapi');
  });

  it('without an OddsPapi key, auto stays on the Odds API', async () => {
    const id = mavsLeg(null);
    const r = await tracker({ papi: false }).backfillCloses();
    expect(r).toMatchObject({ source: 'oddsapi', planAvailable: false });
    expect(
      db.select().from(legs).where(eq(legs.id, id)).get()!.closeJson
    ).toBeNull();
  });

  it('an OddsPapi error leaves the close as it was', async () => {
    const id = mavsLeg(UNSUPPORTED);
    papiError = 'REQUEST_LIMIT_EXCEEDED';
    const r = await tracker().backfillCloses({
      source: 'oddspapi',
      legIds: [id],
    });
    expect(r.filled).toBe(0);
    expect(r.errors.join()).toContain('REQUEST_LIMIT_EXCEEDED');
    expect(close(id).source).toBe('unsupported');
  });
});
