import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet, updateBet, updateLeg } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { bets, events, legs, type LegRow } from '../src/db/schema.js';
import type { BetInput } from '../src/domain/betInput.js';
import {
  hoursBeforeStart,
  placedTime,
  timingBucket,
} from '../src/domain/timing.js';
import { createProviders } from '../src/gamestate/registry.js';
import {
  OddsApiClient,
  type OddsEvent,
  type OddsFetch,
} from '../src/odds/oddsApi.js';
import {
  bookKeyFor,
  closeFair,
  legPriceClv,
  legPriceMove,
  type LegClose,
} from '../src/tracker/clv.js';
import { preState, Tracker } from '../src/tracker/tracker.js';
import { betViewById, portfolio } from '../src/tracker/views.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

// Closing-line timing, price CLV and backfill. Consensus numbers come from
// the constructed fixture (test/fixtures/oddsapi/README.md):
//   Rams  FD -190/+160 -> .630102, DK -185/+154 -> .622467; mean .626284
//   Bears FD -142/+120 -> .586777/.454545; .586777 / 1.041322 = .563492
// Price CLV = fair x decimal(placed) - 1:
//   Rams  at -150 (1.666667): .626284 x 1.666667 - 1 = +.043807
//   Bears at -130 (1.769231): .563492 x 1.769231 - 1 = -.003053
const FIXTURE = fixture<OddsEvent[]>('oddsapi/nfl-lar-phi-constructed.json');
const START = '2026-10-04T17:00:00.000Z';
const HOUR = 3_600_000;
const at = (msFromStart: number) => new Date(Date.parse(START) + msFromStart);

let db: Db;
let clock: Date;
let calls: string[];
/** Live (/odds) responses, served in order (the last one repeats). */
let served: OddsEvent[][];
/** Historical: status and body. */
let historical: { status: number; body: unknown };

const fetchOdds: OddsFetch = async (url) => {
  calls.push(url);
  const isHistorical = url.includes('/historical/');
  const status = isHistorical ? historical.status : 200;
  const body = isHistorical
    ? historical.body
    : served[
        Math.min(
          calls.filter((u) => !u.includes('/historical/')).length - 1,
          served.length - 1
        )
      ];
  const headers = new Map([
    ['x-requests-remaining', '400'],
    ['x-requests-used', '100'],
    ['x-requests-last', isHistorical ? '10' : '1'],
  ]);
  return {
    ok: status < 400,
    status,
    headers: { get: (h) => headers.get(h) ?? null },
    json: async () => body,
  };
};

function tracker(opts: { historical?: boolean } = {}): Tracker {
  const client = new OddsApiClient(db, {
    apiKey: 'k',
    baseUrl: 'http://odds',
    regions: 'us',
    cacheSeconds: 0,
    fetch: fetchOdds,
    now: () => clock.getTime(),
  });
  return new Tracker(
    db,
    createProviders(async () => ({ events: [] })),
    {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => clock,
      clv: {
        client,
        enabled: true,
        leadMinutes: 5,
        windowMinutes: 15,
        retrySeconds: 60,
        quotaFloor: 40,
        historical: opts.historical ?? false,
      },
    }
  );
}

function addEvent(
  home: string,
  away: string,
  status: 'pre' | 'in' | 'final' = 'pre'
): string {
  const id = `espn:nfl:${home}`;
  const row = {
    id,
    sport: 'nfl' as const,
    provider: 'espn',
    providerEventId: home,
    startTime: START,
    homeName: home,
    awayName: away,
    status,
    nextPollAt: '2030-01-01T00:00:00.000Z',
  };
  db.insert(events)
    .values({
      ...row,
      stateJson: JSON.stringify(
        preState({
          ...row,
          homeAbbr: null,
          awayAbbr: null,
          updatedAt: START,
        } as never)
      ),
    })
    .run();
  return id;
}

const RAMS = {
  home: 'Philadelphia Eagles',
  away: 'Los Angeles Rams',
  side: 'away' as const,
};
const BEARS = {
  home: 'Chicago Bears',
  away: 'New York Jets',
  side: 'home' as const,
};
type Pick = typeof RAMS | typeof BEARS;

/** A moneyline bet on `picks`, legs matched, placement set directly. */
function addBet(
  picks: { pick: Pick; price: number; rec?: number }[],
  over: Partial<BetInput> = {}
): { id: number; legIds: number[] } {
  const { bet, legs: rows } = createBet(db, {
    book: 'FanDuel',
    stake: 10,
    price: picks.length === 1 ? picks[0]!.price : 250,
    origin: 'recommended',
    placedAt: at(-24 * HOUR).toISOString(),
    legs: picks.map(({ pick, price, rec }) => ({
      sport: 'nfl',
      eventDate: '2026-10-04',
      participants: [pick.home, pick.away] as [string, string],
      market: 'moneyline',
      selection: {
        kind: 'team' as const,
        team: pick.side === 'away' ? pick.away : pick.home,
      },
      price,
      ...(rec != null ? { recommendedPrice: rec } : {}),
    })),
    ...over,
  });
  rows.forEach((l, i) => {
    const pick = picks[i]!.pick;
    const eventId = `espn:nfl:${pick.home}`;
    if (!db.select().from(events).where(eq(events.id, eventId)).get())
      addEvent(pick.home, pick.away);
    db.update(legs)
      .set({
        eventId,
        matchStatus: 'matched',
        side: pick.side,
        pWin: 0.6,
        pPush: 0,
        pWinPlacement: 0.6,
        pPushPlacement: 0,
        evaluatedAt: START,
      })
      .where(eq(legs.id, l.id))
      .run();
  });
  return { id: bet.id, legIds: rows.map((l) => l.id) };
}

const view = (id: number) => betViewById(db, getBet(db, id)!);
const legRow = (id: number) =>
  db.select().from(legs).where(eq(legs.id, id)).get()!;

/** The fixture with every event's commence_time moved. */
const commencing = (iso: string): OddsEvent[] =>
  FIXTURE.map((e) => ({ ...e, commence_time: iso }));

beforeEach(() => {
  db = openDb(':memory:');
  clock = at(-5 * 60_000); // T-5
  calls = [];
  served = [FIXTURE];
  historical = {
    status: 401,
    body: {
      message: 'Historical odds are only available on paid usage plans.',
      error_code: 'HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN',
    },
  };
});

describe('timing buckets', () => {
  it('hours before start = commence - placed', () => {
    expect(hoursBeforeStart('2026-10-04T05:00:00Z', START)).toBe(12);
    expect(hoursBeforeStart('2026-10-04T17:30:00Z', START)).toBe(-0.5);
    expect(hoursBeforeStart(null, START)).toBeNull();
    expect(hoursBeforeStart('2026-10-04T05:00:00Z', null)).toBeNull();
  });

  it('>12h, 2-12h with both ends, <2h including after the start', () => {
    expect(timingBucket(12.01)).toBe('>12h');
    expect(timingBucket(72)).toBe('>12h');
    expect(timingBucket(12)).toBe('2-12h');
    expect(timingBucket(2)).toBe('2-12h');
    expect(timingBucket(1.99)).toBe('<2h');
    expect(timingBucket(0)).toBe('<2h');
    expect(timingBucket(-1)).toBe('<2h');
    expect(timingBucket(null)).toBeNull();
  });

  it('without placed_at, when it was entered counts only if before the game', () => {
    expect(
      placedTime({ placedAt: '2026-10-04T10:00:00Z', createdAt: START }, START)
    ).toEqual({ at: '2026-10-04T10:00:00Z', source: 'entered' });
    expect(
      placedTime({ placedAt: null, createdAt: '2026-10-04T15:00:00Z' }, START)
    ).toEqual({ at: '2026-10-04T15:00:00Z', source: 'created' });
    // Entered after kickoff (e.g. seeded later): unknown, not negative.
    expect(
      placedTime({ placedAt: null, createdAt: '2026-10-05T00:00:00Z' }, START)
    ).toEqual({ at: null, source: null });
  });

  it('each leg is bucketed by its own start; the bet by its first', () => {
    const { id } = addBet([{ pick: RAMS, price: -150 }], {
      placedAt: at(-3 * HOUR).toISOString(),
    });
    const v = view(id);
    expect(v.legs[0]!.hoursBeforeStart).toBe(3);
    expect(v.legs[0]!.timing).toBe('2-12h');
    expect(v.timing).toEqual({
      placedAt: at(-3 * HOUR).toISOString(),
      placedAtSource: 'entered',
      hoursBeforeStart: 3,
      bucket: '2-12h',
    });
  });
});

describe('price CLV math', () => {
  const leg = (over: Partial<LegRow>, close: Partial<LegClose>): LegRow =>
    ({
      priceAmerican: 100,
      pPushPlacement: 0,
      recommendedPrice: null,
      closeJson: JSON.stringify({
        p: 0.5,
        price: 100,
        line: null,
        source: 'exact',
        snapshotAt: START,
        ...close,
      }),
      ...over,
    }) as LegRow;

  it('fair at close x decimal placed price - 1', () => {
    // .55 x 2.0 - 1 = +.10; at -120 (1.833333): .55 x 1.833333 - 1 = +.008333
    expect(legPriceClv(leg({}, { p: 0.55, fair: 0.55 }))).toBeCloseTo(0.1, 6);
    expect(
      legPriceClv(leg({ priceAmerican: -120 }, { p: 0.55, fair: 0.55 }))
    ).toBeCloseTo(0.008333, 6);
    // A coin flip at -110: .5 x 1.909091 - 1 = -.045455 (the vig).
    expect(
      legPriceClv(leg({ priceAmerican: -110 }, { p: 0.5, fair: 0.5 }))
    ).toBeCloseTo(-0.045455, 6);
  });

  it('pushes aside: an old exact close (no fair) divides out P(push) at placement', () => {
    // p .45 with P(push) .10 -> fair .45 / .90 = .5; at +100: .5 x 2 - 1 = 0.
    const l = leg({ pPushPlacement: 0.1 }, { p: 0.45 });
    expect(closeFair(l, JSON.parse(l.closeJson!))).toBeCloseTo(0.5, 9);
    expect(legPriceClv(l)).toBeCloseTo(0, 9);
  });

  it('no priced close, no CLV', () => {
    expect(legPriceClv(leg({}, { p: null, source: 'missed' }))).toBeNull();
    expect(legPriceClv({ closeJson: null } as LegRow)).toBeNull();
  });

  it('price movement: rec -> placed and placed -> the book close', () => {
    // rec -140 (1.714286) -> placed -150 (1.666667): 1.666667/1.714286 - 1 = -.027778
    // placed -150 vs book close -190 (1.526316): 1.666667/1.526316 - 1 = +.091954
    const m = legPriceMove(
      leg(
        { priceAmerican: -150, recommendedPrice: -140 },
        { book: { key: 'fanduel', price: -190 } }
      )
    );
    expect(m.recToPlaced).toBeCloseTo(-0.027778, 6);
    expect(m.placedToClose).toBeCloseTo(0.091954, 6);
    expect(legPriceMove(leg({}, { book: null }))).toEqual({
      recToPlaced: null,
      placedToClose: null,
    });
  });

  it('book names map to Odds API keys; unknown books have none', () => {
    expect(bookKeyFor('FanDuel')).toBe('fanduel');
    expect(bookKeyFor('fanduel')).toBe('fanduel');
    expect(bookKeyFor('Caesars')).toBe('williamhill_us');
    expect(bookKeyFor('Circa')).toBeNull();
    expect(bookKeyFor('Kalshi')).toBeNull();
  });

  it('a parlay is measured per leg, each at its own leg price, with its book close', async () => {
    const { id } = addBet([
      { pick: RAMS, price: -150, rec: -140 },
      { pick: BEARS, price: -130 },
    ]);
    await tracker().tick();
    const [rams, bears] = view(id).legs;
    expect(rams!.close).toMatchObject({
      source: 'exact',
      via: 'snapshot',
      book: { key: 'fanduel', price: -190 },
    });
    expect(rams!.close!.fair).toBeCloseTo(0.626284, 6);
    expect(rams!.priceClv).toBeCloseTo(0.0438, 4);
    expect(rams!.priceMove).toEqual({
      recToPlaced: -0.0278,
      placedToClose: 0.092,
    });
    expect(bears!.close!.book).toEqual({ key: 'fanduel', price: -142 });
    // Beat FanDuel's close (-130 vs -142, +.038144) yet not the fair close:
    // the book's -142 has vig in it.
    expect(bears!.priceClv).toBeCloseTo(-0.0031, 4);
    expect(bears!.priceMove.placedToClose).toBeCloseTo(0.0381, 4);
  });

  it("a book the API doesn't carry still gets the consensus fair", async () => {
    const { id } = addBet([{ pick: RAMS, price: -150 }], { book: 'Circa' });
    await tracker().tick();
    const l = view(id).legs[0]!;
    expect(l.close!.book).toBeNull();
    expect(l.priceClv).toBeCloseTo(0.0438, 4);
    expect(l.priceMove.placedToClose).toBeNull();
  });
});

describe('snapshot job', () => {
  it('fetches at T-5, not before', async () => {
    addBet([{ pick: RAMS, price: -150 }]);
    clock = at(-5 * 60_000 - 1000);
    await tracker().tick();
    expect(calls).toEqual([]);
    clock = at(-5 * 60_000);
    await tracker().tick();
    expect(calls).toHaveLength(1);
  });

  it('is idempotent: one call per slate, a stored close is never rewritten', async () => {
    const a = addBet([{ pick: RAMS, price: -150 }]);
    const b = addBet([{ pick: BEARS, price: -130 }], { origin: 'own' });
    const t = tracker();
    await t.tick();
    // One call covered both games in the slate.
    expect(calls).toHaveLength(1);
    const first = [a, b].map((x) => legRow(x.legIds[0]!).closeJson);
    // The market moves; later ticks (and a fresh process) leave it alone.
    served = [commencing(START).map((e) => ({ ...e, bookmakers: [] }))];
    clock = at(-2 * 60_000);
    await t.tick();
    await tracker().tick();
    expect(calls).toHaveLength(1);
    expect([a, b].map((x) => legRow(x.legIds[0]!).closeJson)).toEqual(first);
  });

  it('two trackers racing for one slate: the first write wins', async () => {
    const { legIds } = addBet([{ pick: RAMS, price: -150 }]);
    // Second response: Rams at a different price.
    const moved = structuredClone(FIXTURE);
    moved[0]!.bookmakers = moved[0]!.bookmakers.slice(0, 1);
    served = [FIXTURE, moved];
    await Promise.all([tracker().tick(), tracker().tick()]);
    const close = JSON.parse(legRow(legIds[0]!).closeJson!) as LegClose;
    // The two-book consensus from the first response, not FanDuel alone.
    expect(close.fair).toBeCloseTo(0.626284, 6);
  });

  it('an early start (the API lists it as begun) is never closed at live odds', async () => {
    const { legIds } = addBet([{ pick: RAMS, price: -150 }]);
    served = [commencing(at(-20 * 60_000).toISOString())];
    await tracker().tick();
    expect(JSON.parse(legRow(legIds[0]!).closeJson!)).toMatchObject({
      p: null,
      source: 'missed',
    });
  });

  it('with historical odds on, an early start is read as of 5 min before it began', async () => {
    const { legIds } = addBet([{ pick: RAMS, price: -150 }]);
    const began = at(-20 * 60_000);
    served = [commencing(began.toISOString())];
    historical = {
      status: 200,
      body: {
        timestamp: '2026-10-04T16:35:00Z',
        data: commencing(began.toISOString()),
      },
    };
    await tracker({ historical: true }).tick();
    expect(calls).toHaveLength(2);
    const h = new URL(calls[1]!);
    expect(h.pathname).toBe('/historical/sports/americanfootball_nfl/odds');
    expect(h.searchParams.get('date')).toBe('2026-10-04T16:35:00Z');
    const close = JSON.parse(legRow(legIds[0]!).closeJson!) as LegClose;
    expect(close).toMatchObject({
      source: 'exact',
      via: 'historical',
      snapshotAt: '2026-10-04T16:35:00.000Z',
    });
  });

  it('a game we saw start without a close: historical as of start - 5, or missed', async () => {
    const { legIds } = addBet([{ pick: RAMS, price: -150 }]);
    clock = at(10 * 60_000);
    db.update(events).set({ status: 'in' }).run();
    historical = {
      status: 200,
      body: { timestamp: '2026-10-04T16:55:00Z', data: FIXTURE },
    };
    await tracker({ historical: true }).tick();
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).searchParams.get('date')).toBe(
      '2026-10-04T16:55:00Z'
    );
    expect(JSON.parse(legRow(legIds[0]!).closeJson!).via).toBe('historical');

    // Off (the default): missed, no call.
    db.update(legs).set({ closeJson: null }).run();
    calls = [];
    await tracker().tick();
    expect(calls).toEqual([]);
    expect(JSON.parse(legRow(legIds[0]!).closeJson!).source).toBe('missed');
  });
});

describe('backfill', () => {
  /** A settled bet on a final game with no close (or a missed stamp). */
  function settled(close: LegClose | null = null) {
    const b = addBet([{ pick: RAMS, price: -150 }]);
    db.update(events).set({ status: 'final' }).run();
    db.update(legs)
      .set({ status: 'won', closeJson: close && JSON.stringify(close) })
      .run();
    db.update(bets).set({ status: 'won' }).run();
    clock = at(48 * HOUR);
    return b;
  }

  it('dry run: counts and cost, no calls', async () => {
    settled();
    const r = await tracker().backfillCloses({ dryRun: true });
    expect(calls).toEqual([]);
    // One window, h2h only: 10 x 1 market x 1 region.
    expect(r).toMatchObject({
      missingClose: 1,
      eligible: 1,
      windows: 1,
      estimatedCost: 10,
      planAvailable: null,
    });
  });

  it('on a plan without historical odds: nothing written, the count reported', async () => {
    const { legIds } = settled();
    const r = await tracker().backfillCloses();
    expect(r.planAvailable).toBe(false);
    expect(r.filled).toBe(0);
    expect(r.eligible).toBe(1);
    expect(legRow(legIds[0]!).closeJson).toBeNull();
  });

  it('with historical odds: fills, replaces a missed stamp, then has nothing left', async () => {
    const missed: LegClose = {
      p: null,
      price: null,
      line: null,
      source: 'missed',
      snapshotAt: START,
    };
    const { legIds } = settled(missed);
    historical = {
      status: 200,
      body: { timestamp: '2026-10-04T16:55:00Z', data: FIXTURE },
    };
    const r = await tracker().backfillCloses();
    expect(r).toMatchObject({ planAvailable: true, filled: 1, spent: 10 });
    expect(new URL(calls[0]!).searchParams.get('date')).toBe(
      '2026-10-04T16:55:00Z'
    );
    const close = JSON.parse(legRow(legIds[0]!).closeJson!) as LegClose;
    expect(close).toMatchObject({ source: 'exact', via: 'historical' });
    expect(legPriceClv(legRow(legIds[0]!))).toBeCloseTo(0.043807, 6);

    const again = await tracker().backfillCloses();
    expect(again.missingClose).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('leaves open legs, live bets and priced closes alone', async () => {
    addBet([{ pick: RAMS, price: -150 }]); // open
    const live = addBet([{ pick: BEARS, price: -130 }], { placedLive: true });
    db.update(legs)
      .set({ status: 'lost' })
      .where(eq(legs.betId, live.id))
      .run();
    const r = await tracker().backfillCloses({ dryRun: true });
    expect(r).toMatchObject({
      missingClose: 1,
      eligible: 0,
      skipped: { live: 1 },
    });
  });
});

describe('portfolio breakdowns', () => {
  async function slate() {
    // Early: Rams single, $10, 24 h before (+.043807).
    addBet([{ pick: RAMS, price: -150, rec: -140 }]);
    // Late: $20 two-leg parlay 1 h before; each leg weighs $10.
    addBet(
      [
        { pick: RAMS, price: -150 },
        { pick: BEARS, price: -130, rec: -120 },
      ],
      { stake: 20, placedAt: at(-1 * HOUR).toISOString(), origin: 'own' }
    );
    await tracker().tick();
  }

  it('byTiming and bySport: stake-weighted price CLV and share beating the close', async () => {
    await slate();
    const p = portfolio(db);
    expect(p.byTiming.map((g) => g.key)).toEqual(['>12h', '<2h']);
    const [early, late] = p.byTiming;
    expect(early).toMatchObject({ legCount: 1, clvCount: 1, pctBeatClose: 1 });
    expect(early!.avgClv).toBeCloseTo(0.0438, 4);
    // (.043807 x 10 + -.003053 x 10) / 20 = .020377
    expect(late).toMatchObject({ legCount: 2, clvCount: 2, pctBeatClose: 0.5 });
    expect(late!.avgClv).toBeCloseTo(0.0204, 4);
    // All three legs are NFL: (.043807 x 10 x 2 + -.003053 x 10) / 30 = .028187
    expect(p.bySport).toHaveLength(1);
    expect(p.bySport[0]).toMatchObject({
      key: 'nfl',
      legCount: 3,
      clvCount: 3,
    });
    expect(p.bySport[0]!.avgClv).toBeCloseTo(0.0282, 4);
    expect(p.bySport[0]!.pctBeatClose).toBeCloseTo(0.6667, 4);
  });

  it('price movement only over legs with a recommended price', async () => {
    await slate();
    const [early, late] = portfolio(db).byTiming;
    // Rams: rec -140 -> -150 = -.027778; -150 vs FD close -190 = +.091954.
    expect(early!.priceMove).toEqual({
      count: 1,
      recToPlaced: -0.0278,
      closeCount: 1,
      placedToClose: 0.092,
    });
    // Bears only: rec -120 (1.833333) -> -130 (1.769231) = -.034965;
    // -130 vs FD -142 (1.704225) = +.038144.
    expect(late!.priceMove).toEqual({
      count: 1,
      recToPlaced: -0.035,
      closeCount: 1,
      placedToClose: 0.0381,
    });
  });

  it('filters by timing bucket and sport', async () => {
    await slate();
    const late = portfolio(db, { timing: '<2h' });
    expect(late.timing).toBe('<2h');
    expect(late.open.count).toBe(1);
    expect(late.byTiming.map((g) => g.key)).toEqual(['<2h']);
    expect(late.byOrigin.map((o) => o.origin)).toEqual(['own']);
    expect(portfolio(db, { sport: 'nba' })).toMatchObject({
      open: { count: 0 },
      byTiming: [],
      bySport: [],
    });
    // The old positional origin argument still works.
    expect(portfolio(db, 'recommended').open.count).toBe(1);
  });
});

describe('recommendation fields', () => {
  it('add_bet stores recommendedAt and per-leg recommendedPrice; update_* edit them', () => {
    const { id, legIds } = addBet([{ pick: RAMS, price: -150, rec: -140 }], {
      recommendedAt: '2026-10-03T12:00:00-05:00',
    });
    let v = view(id);
    expect(v.recommendedAt).toBe('2026-10-03T17:00:00.000Z');
    expect(v.legs[0]!.recommendedPrice).toBe(-140);
    updateLeg(db, legIds[0]!, { recommendedPrice: -145 });
    updateBet(db, id, { recommendedAt: null });
    v = view(id);
    expect(v.legs[0]!.recommendedPrice).toBe(-145);
    expect(v.recommendedAt).toBeNull();
    // Validated like a price.
    expect(() => updateLeg(db, legIds[0]!, { recommendedPrice: 50 })).toThrow();
  });
});
