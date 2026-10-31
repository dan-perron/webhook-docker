import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet, updateBet, updateLeg } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { events, legs, meta, type LegRow } from '../src/db/schema.js';
import type { BetInput } from '../src/domain/betInput.js';
import type { BET_SPORTS, Sport } from '../src/domain/types.js';
import { createProviders } from '../src/gamestate/registry.js';
import {
  OddsApiClient,
  type OddsEvent,
  type OddsFetch,
} from '../src/odds/oddsApi.js';
import { closeWindows, quotaBelowFloor } from '../src/tracker/clv.js';
import { preState, Tracker } from '../src/tracker/tracker.js';
import { betViewById, portfolio } from '../src/tracker/views.js';
import { BetCard, ClvTable } from '../src/web/page.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

// Closing line value. Consensus numbers are hand-computed from the constructed
// fixture (see test/fixtures/oddsapi/README.md):
//   Rams  -190/+160 -> .630102, -185/+154 -> .622467; mean .626284
//   Bears -142/+120 -> .586777/.454545; .586777 / 1.041322 = .563492
//   Eagles +3.5: FD -110/-110 -> .5; DK -115/-105 -> .534884 / (.534884+.512195) = .510840; mean .505420
const FIXTURE = fixture<OddsEvent[]>('oddsapi/nfl-lar-phi-constructed.json');
const START = '2026-10-04T17:00:00.000Z';
const PACKERS: OddsEvent = {
  id: 'gb-min',
  sport_key: 'americanfootball_nfl',
  commence_time: '2026-10-04T17:00:00Z',
  home_team: 'Green Bay Packers',
  away_team: 'Minnesota Vikings',
  bookmakers: [
    {
      key: 'fanduel',
      title: 'FanDuel',
      last_update: START,
      markets: [
        {
          key: 'h2h',
          outcomes: [
            { name: 'Green Bay Packers', price: -110 },
            { name: 'Minnesota Vikings', price: -110 },
          ],
        },
      ],
    },
  ],
};
const ODDS = [...FIXTURE, PACKERS];
/** NBA: main spread home -3.5 at -110/-110 (fair 50/50), total 220.5. */
const NBA_ODDS: OddsEvent[] = [
  {
    id: 'bos-nyk',
    sport_key: 'basketball_nba',
    commence_time: START,
    home_team: 'Boston Celtics',
    away_team: 'New York Knicks',
    bookmakers: [
      {
        key: 'fanduel',
        title: 'FanDuel',
        last_update: START,
        markets: [
          {
            key: 'spreads',
            outcomes: [
              { name: 'Boston Celtics', price: -110, point: -3.5 },
              { name: 'New York Knicks', price: -110, point: 3.5 },
            ],
          },
        ],
      },
    ],
  },
];

let db: Db;
let clock: Date;
let calls: string[];
let served: OddsEvent[];
let failures: number;
let remaining: number;

const fetchOdds: OddsFetch = async (url) => {
  calls.push(url);
  const headers = new Map([
    ['x-requests-remaining', String(remaining)],
    ['x-requests-used', '10'],
    ['x-requests-last', '1'],
  ]);
  const ok = failures <= 0;
  failures -= 1;
  return {
    ok,
    status: ok ? 200 : 500,
    headers: { get: (h) => headers.get(h) ?? null },
    json: async () => served,
  };
};

function tracker(): { t: Tracker; client: OddsApiClient } {
  const client = new OddsApiClient(db, {
    apiKey: 'k',
    baseUrl: 'http://odds',
    regions: 'us',
    cacheSeconds: 0,
    fetch: fetchOdds,
    now: () => clock.getTime(),
  });
  const t = new Tracker(
    db,
    createProviders(async () => ({ events: [] })),
    {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => clock,
      clv: {
        client,
        enabled: true,
        leadMinutes: 3,
        windowMinutes: 15,
        retrySeconds: 60,
        quotaFloor: 40,
      },
    }
  );
  return { t, client };
}

/** An event already polled, so the tracker only does CLV work on it. */
function addEvent(
  home: string,
  away: string,
  startTime = START,
  sport: Sport = 'nfl'
): string {
  const id = `espn:${sport}:${home}`;
  const row = {
    id,
    sport,
    provider: 'espn',
    providerEventId: home,
    startTime,
    homeName: home,
    awayName: away,
    status: 'pre' as const,
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
          updatedAt: startTime,
        } as never)
      ),
    })
    .run();
  return id;
}

type LegSpec = {
  event: string;
  home: string;
  away: string;
  market?: 'moneyline' | 'spread' | 'total';
  side?: 'home' | 'away';
  kind?: 'team' | 'over' | 'under';
  line?: number;
  placement: number;
  push?: number;
  sport?: (typeof BET_SPORTS)[number];
};

/** A bet with its legs matched and placement probabilities set directly. */
function addBet(
  specs: LegSpec[],
  over: Partial<BetInput> = {}
): { id: number; legIds: number[] } {
  const { bet, legs: rows } = createBet(db, {
    book: 'FanDuel',
    stake: 10,
    price: 150,
    statedPayout: 40,
    origin: 'recommended',
    legs: specs.map((s) => ({
      sport: s.sport ?? 'nfl',
      eventDate: '2026-10-04',
      participants: [s.home, s.away] as [string, string],
      market: s.market ?? 'moneyline',
      selection:
        s.kind === 'over' || s.kind === 'under'
          ? { kind: s.kind }
          : {
              kind: 'team' as const,
              team: s.side === 'away' ? s.away : s.home,
            },
      ...(s.line != null ? { line: s.line } : {}),
      price: 150,
    })),
    ...over,
  });
  rows.forEach((l, i) => {
    const s = specs[i]!;
    db.update(legs)
      .set({
        eventId: s.event,
        matchStatus: 'matched',
        side:
          s.kind === 'over' || s.kind === 'under' ? null : (s.side ?? 'home'),
        pWin: s.placement,
        pPush: s.push ?? 0,
        pWinPlacement: s.placement,
        pPushPlacement: s.push ?? 0,
        evaluatedAt: START,
      })
      .where(eq(legs.id, l.id))
      .run();
  });
  return { id: bet.id, legIds: rows.map((l) => l.id) };
}

const view = (id: number) => betViewById(db, getBet(db, id)!);
const rams = (placement: number) => ({
  event: addEvent('Philadelphia Eagles', 'Los Angeles Rams'),
  home: 'Philadelphia Eagles',
  away: 'Los Angeles Rams',
  side: 'away' as const,
  placement,
});

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date('2026-10-04T16:57:00.000Z'); // 3 minutes before kickoff
  calls = [];
  served = ODDS;
  failures = 0;
  remaining = 400;
});

describe('closeWindows', () => {
  const at = (key: string, min: number, market = 'h2h' as const) => ({
    key,
    start: min * 60_000,
    market,
    item: `${key}${min}`,
  });
  it('one window per sport, starts within the width of the earliest', () => {
    const w = closeWindows(
      [at('nfl', 0), at('nfl', 5), at('nfl', 15), at('nfl', 16), at('nba', 5)],
      15 * 60_000
    );
    expect(w.map((x) => [x.key, x.items])).toEqual([
      ['nfl', ['nfl0', 'nfl5', 'nfl15']],
      ['nba', ['nba5']],
      ['nfl', ['nfl16']],
    ]);
  });

  it('asks only for the markets its legs need', () => {
    const w = closeWindows(
      [
        at('nfl', 0),
        { ...at('nfl', 1), market: 'totals' as const },
        at('nfl', 2),
      ],
      15 * 60_000
    );
    expect(w[0]!.markets).toEqual(['h2h', 'totals']);
  });
});

describe('snapshot scheduling', () => {
  it('waits for the window: nothing more than 3 minutes before the start', async () => {
    addBet([rams(0.6)]);
    clock = new Date('2026-10-04T16:56:59.000Z');
    await tracker().t.tick();
    expect(calls).toEqual([]);
    expect(view(1).legs[0]!.close).toBeNull();
  });

  it('fetches a sport once per window, for every leg, and only needed markets', async () => {
    addBet([rams(0.6)]);
    addBet(
      [
        {
          event: addEvent('Chicago Bears', 'New York Jets'),
          home: 'Chicago Bears',
          away: 'New York Jets',
          placement: 0.55,
        },
      ],
      { origin: 'own' }
    );
    await tracker().t.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/sports/americanfootball_nfl/odds');
    expect(new URL(calls[0]!).searchParams.get('markets')).toBe('h2h');
    expect(view(2).legs[0]!.close!.source).toBe('exact');
    // Resolved: no more calls.
    await tracker().t.tick();
    expect(calls).toHaveLength(1);
  });

  it('never fetches after the start', async () => {
    addBet([rams(0.6)]);
    clock = new Date('2026-10-04T17:00:00.000Z');
    await tracker().t.tick();
    expect(calls).toEqual([]);
    expect(view(1).legs[0]!.close!.source).toBe('missed');
  });
});

describe('acceptance', () => {
  it('1. a pregame moneyline single: exact, with clv within 0.20', async () => {
    const { id } = addBet([rams(0.6)]);
    await tracker().t.tick();
    const v = view(id);
    const leg = v.legs[0]!;
    expect(leg.close!.source).toBe('exact');
    expect(leg.close!.p).toBeCloseTo(0.626284, 4);
    // Fair price of .626284: -100 / (1/.626284 - 1) = -168.
    expect(leg.close!.price).toBe(-168);
    expect(leg.close!.snapshotAt).toBe(clock.toISOString());
    expect(leg.clv).toBeCloseTo(0.026284, 4);
    expect(Math.abs(leg.clv!)).toBeLessThan(0.2);
    expect(leg.clvPct).toBeCloseTo(0.626284 / 0.6 - 1, 3);
    expect(v.atClose!.source).toBe('exact');
    // .626284 x $40 stated payout - $10.
    expect(v.atClose!.ev).toBeCloseTo(15.05, 2);
    expect(v.clv).toBeCloseTo(0.626284 / 0.6 - 1, 3);
  });

  it('2. a 3-leg cross-game parlay: atClose.pWin = product of the closes', async () => {
    const { id } = addBet([
      rams(0.6),
      {
        event: addEvent('Chicago Bears', 'New York Jets'),
        home: 'Chicago Bears',
        away: 'New York Jets',
        placement: 0.5,
      },
      {
        event: addEvent('Green Bay Packers', 'Minnesota Vikings'),
        home: 'Green Bay Packers',
        away: 'Minnesota Vikings',
        placement: 0.5,
      },
    ]);
    await tracker().t.tick();
    const v = view(id);
    expect(v.legs.map((l) => l.close!.p)).toEqual([0.6263, 0.5635, 0.5]);
    // .626284 x .563492 x .5
    expect(v.atClose!.pWin).toBeCloseTo(0.176451, 4);
    // Against .6 x .5 x .5 = .15.
    expect(v.clv).toBeCloseTo(0.176451 / 0.15 - 1, 3);
    // $40 stated payout (boost included) x .176451 - $10.
    expect(v.atClose!.ev).toBeCloseTo(-2.94, 2);
  });

  it('3. a same-game parlay is unsupported, costs nothing and leaves totals intact', async () => {
    const event = addEvent('Philadelphia Eagles', 'Los Angeles Rams');
    const game = {
      event,
      home: 'Philadelphia Eagles',
      away: 'Los Angeles Rams',
      placement: 0.5,
    };
    const { id } = addBet([
      { ...game, side: 'away' },
      { ...game, market: 'total', kind: 'over', line: 42.5 },
    ]);
    await tracker().t.tick();
    expect(calls).toEqual([]);
    const v = view(id);
    expect(v.atClose).toEqual({
      pWin: null,
      value: null,
      ev: null,
      source: 'unsupported',
    });
    expect(v.clv).toBeNull();
    const o = portfolio(db).byOrigin[0]!;
    expect(o.clvCount).toBe(0);
    expect(o.avgClv).toBeNull();
    expect(o.pctBeatClose).toBeNull();
    expect(o.evAtClose).toBe(0);
    expect(o.count).toBe(1);
  });

  it('4. below the floor: no calls, logged once, legs end up missed', async () => {
    addBet([rams(0.6)]);
    const { t } = tracker();
    db.insert(meta)
      .values({
        key: 'odds_api_quota',
        value: JSON.stringify({
          remaining: 39,
          used: 461,
          last: 1,
          updatedAt: '2026-10-04T10:00:00.000Z',
        }),
      })
      .run();
    const first = await t.tick();
    const second = await t.tick();
    expect(calls).toEqual([]);
    expect(first.errors.join()).toMatch(/39 left, below the floor of 40/);
    expect(second.errors).toEqual([]);
    clock = new Date(START);
    await t.tick();
    expect(view(1).legs[0]!.close!.source).toBe('missed');
    expect(calls).toEqual([]);
  });

  it('5. a failed snapshot retries once, then is missed, not 0', async () => {
    const { id } = addBet([rams(0.6)]);
    const { t } = tracker();
    failures = 2;
    const first = await t.tick();
    expect(first.errors.join()).toMatch(/HTTP 500/);
    expect(view(id).legs[0]!.close).toBeNull();
    // Inside the retry delay: nothing.
    await t.tick();
    expect(calls).toHaveLength(1);
    clock = new Date(clock.getTime() + 60_000);
    await t.tick();
    expect(calls).toHaveLength(2);
    const v = view(id);
    expect(v.legs[0]!.close).toMatchObject({ source: 'missed', p: null });
    expect(v.legs[0]!.clv).toBeNull();
    expect(v.atClose).toMatchObject({ source: 'missed', ev: null });
    // Given up: no third call.
    clock = new Date(clock.getTime() + 60_000);
    await t.tick();
    expect(calls).toHaveLength(2);
  });

  it('a retry that succeeds records the close', async () => {
    const { id } = addBet([rams(0.6)]);
    const { t } = tracker();
    failures = 1;
    await t.tick();
    clock = new Date(clock.getTime() + 60_000);
    await t.tick();
    expect(view(id).legs[0]!.close!.source).toBe('exact');
  });
});

describe('quota floor', () => {
  const q = (remaining: number | null, updatedAt: string | null) => ({
    remaining,
    used: null,
    last: null,
    updatedAt,
  });
  const now = new Date('2026-11-01T00:30:00.000Z');
  it('holds within the month and at the boundary value', () => {
    expect(quotaBelowFloor(q(39, '2026-11-01T00:10:00Z'), 40, now)).toBe(true);
    expect(quotaBelowFloor(q(40, '2026-11-01T00:10:00Z'), 40, now)).toBe(false);
    expect(quotaBelowFloor(q(null, null), 40, now)).toBe(false);
  });
  it("lifts on the 1st: last month's reading doesn't hold", () => {
    expect(quotaBelowFloor(q(5, '2026-10-31T23:00:00Z'), 40, now)).toBe(false);
  });
});

describe('legs without a price to fetch', () => {
  it('live bets are skipped as live, with no call', async () => {
    const { id } = addBet([rams(0.6)], { placedLive: true });
    await tracker().t.tick();
    expect(calls).toEqual([]);
    expect(view(id).legs[0]!.close!.source).toBe('live');
    expect(view(id).atClose!.source).toBe('live');
  });

  it('a prop in a parlay is unsupported but the other leg still gets its close', async () => {
    const event = addEvent('Chicago Bears', 'New York Jets');
    const { id, legIds } = addBet([
      rams(0.6),
      {
        event,
        home: 'Chicago Bears',
        away: 'New York Jets',
        placement: 0.3,
      },
    ]);
    db.update(legs)
      .set({
        market: 'player_prop',
        propType: 'anytime_td',
        playerName: 'Someone',
        selectionKind: 'yes',
      })
      .where(eq(legs.id, legIds[1]!))
      .run();
    await tracker().t.tick();
    const v = view(id);
    expect(v.legs[0]!.close!.source).toBe('exact');
    expect(v.legs[1]!.close!.source).toBe('unsupported');
    expect(v.atClose!.source).toBe('unsupported');
    expect(v.clv).toBeNull();
    // The priced leg still counts toward beating the close.
    expect(portfolio(db).byOrigin[0]!.clvLegCount).toBe(1);
  });

  it('a game the API does not list is unsupported', async () => {
    const { id } = addBet([
      {
        event: addEvent('Dallas Cowboys', 'Arizona Cardinals'),
        home: 'Dallas Cowboys',
        away: 'Arizona Cardinals',
        placement: 0.5,
      },
    ]);
    await tracker().t.tick();
    expect(calls).toHaveLength(1);
    expect(view(id).legs[0]!.close!.source).toBe('unsupported');
  });

  it('an unmatched leg waits, then is missed once its day has passed', async () => {
    const { bet } = createBet(db, {
      book: 'FanDuel',
      stake: 10,
      price: 150,
      legs: [
        {
          sport: 'nfl',
          eventDate: '2026-10-04',
          participants: ['Team A', 'Team B'],
          market: 'moneyline',
          selection: { kind: 'team', team: 'Team A' },
          price: 150,
        },
      ],
    });
    db.update(legs)
      .set({ matchStatus: 'needs_confirmation' })
      .where(eq(legs.betId, bet.id))
      .run();
    const { t } = tracker();
    await t.tick();
    expect(view(bet.id).legs[0]!.close).toBeNull();
    clock = new Date('2026-10-05T12:01:00.000Z');
    await t.tick();
    expect(view(bet.id).legs[0]!.close!.source).toBe('missed');
  });

  it('settled legs from before CLV are left alone (no backfill)', async () => {
    const { id, legIds } = addBet([rams(0.6)]);
    db.update(legs).set({ status: 'won' }).where(eq(legs.id, legIds[0]!)).run();
    await tracker().t.tick();
    expect(calls).toEqual([]);
    expect(view(id).legs[0]!.close).toBeNull();
    expect(view(id).atClose).toBeNull();
  });
});

describe('lines', () => {
  const eagles = () => ({
    event: addEvent('Philadelphia Eagles', 'Los Angeles Rams'),
    home: 'Philadelphia Eagles',
    away: 'Los Angeles Rams',
  });

  it('a spread on the closing line is exact, from either side', async () => {
    const a = addBet([
      {
        ...eagles(),
        market: 'spread',
        side: 'home',
        line: 3.5,
        placement: 0.48,
      },
    ]);
    await tracker().t.tick();
    const c = view(a.id).legs[0]!.close!;
    expect(c.source).toBe('exact');
    expect(c.p).toBeCloseTo(0.50542, 4);
    expect(c.line).toBe(3.5);
    expect(new URL(calls[0]!).searchParams.get('markets')).toBe('spreads');
  });

  it('the away side of the same spread takes the other share', async () => {
    const a = addBet([
      {
        ...eagles(),
        market: 'spread',
        side: 'away',
        line: -3.5,
        placement: 0.48,
      },
    ]);
    await tracker().t.tick();
    expect(view(a.id).legs[0]!.close!.p).toBeCloseTo(1 - 0.50542, 4);
  });

  it('an integer line scales to P(win) with the push at placement', async () => {
    served = [
      {
        ...NBA_ODDS[0]!,
        bookmakers: [
          {
            ...NBA_ODDS[0]!.bookmakers[0]!,
            markets: [
              {
                key: 'spreads',
                outcomes: [
                  { name: 'Boston Celtics', price: -110, point: -3 },
                  { name: 'New York Knicks', price: -110, point: 3 },
                ],
              },
            ],
          },
        ],
      },
    ];
    const a = addBet([
      {
        event: addEvent('Boston Celtics', 'New York Knicks', START, 'nba'),
        home: 'Boston Celtics',
        away: 'New York Knicks',
        sport: 'nba',
        market: 'spread',
        side: 'home',
        line: -3,
        placement: 0.47,
        push: 0.06,
      },
    ]);
    await tracker().t.tick();
    const v = view(a.id);
    // Fair .5 given no push x (1 - .06): flat against placement's .47.
    expect(v.legs[0]!.close!.p).toBeCloseTo(0.47, 6);
    expect(v.legs[0]!.clv).toBeCloseTo(0, 6);
    expect(v.clv).toBeCloseTo(0, 6);
    // .47 x $40 + .06 x $10 refund - $10: the push refund still counts.
    expect(v.atClose!.ev).toBeCloseTo(9.4, 2);
  });

  it('off the closing line, a margin sport interpolates from the fitted model', async () => {
    served = NBA_ODDS;
    const a = addBet([
      {
        event: addEvent('Boston Celtics', 'New York Knicks', START, 'nba'),
        home: 'Boston Celtics',
        away: 'New York Knicks',
        sport: 'nba',
        market: 'spread',
        side: 'home',
        line: -5.5,
        placement: 0.45,
      },
    ]);
    await tracker().t.tick();
    const c = view(a.id).legs[0]!.close!;
    expect(c.source).toBe('interpolated');
    // Main line -3.5 at 50/50 puts the mean margin at 3.5; league σ 13:
    // P(margin > 5.5) = 1 - Φ(2 / 13) = 1 - Φ(.1538) = .4389.
    expect(c.p!).toBeCloseTo(0.4389, 2);
    expect(c.line).toBe(-3.5);
    expect(view(a.id).atClose!.source).toBe('interpolated');
  });

  it('off the closing line, other sports are unsupported', async () => {
    served = [
      {
        ...NBA_ODDS[0]!,
        home_team: 'Chicago Cubs',
        away_team: 'St. Louis Cardinals',
        bookmakers: [
          {
            ...NBA_ODDS[0]!.bookmakers[0]!,
            markets: [
              {
                key: 'totals',
                outcomes: [
                  { name: 'Over', price: -110, point: 9 },
                  { name: 'Under', price: -110, point: 9 },
                ],
              },
            ],
          },
        ],
      },
    ];
    const a = addBet([
      {
        event: addEvent('Chicago Cubs', 'St. Louis Cardinals', START, 'mlb'),
        home: 'Chicago Cubs',
        away: 'St. Louis Cardinals',
        sport: 'mlb',
        market: 'total',
        kind: 'over',
        line: 8.5,
        placement: 0.5,
      },
    ]);
    await tracker().t.tick();
    expect(view(a.id).legs[0]!.close).toMatchObject({
      source: 'unsupported',
      p: null,
    });
  });
});

describe('corrections and totals', () => {
  it('editing a leg line drops the close; editing only the price keeps it', async () => {
    const { id, legIds } = addBet([
      {
        event: addEvent('Philadelphia Eagles', 'Los Angeles Rams'),
        home: 'Philadelphia Eagles',
        away: 'Los Angeles Rams',
        market: 'spread',
        side: 'home',
        line: 3.5,
        placement: 0.5,
      },
    ]);
    await tracker().t.tick();
    updateLeg(db, legIds[0]!, { price: 120 });
    expect(view(id).legs[0]!.close).not.toBeNull();
    updateLeg(db, legIds[0]!, { line: 4.5 });
    expect(view(id).legs[0]!.close).toBeNull();
  });

  it('marking a bet live replaces its close', async () => {
    const { id } = addBet([rams(0.6)]);
    await tracker().t.tick();
    updateBet(db, id, { placedLive: true });
    const row = db.select().from(legs).get() as LegRow;
    expect(row.closeJson).toBeNull();
    expect(view(id).atClose!.source).toBe('live');
  });

  it('recompute keeps closes', async () => {
    const { id } = addBet([rams(0.6)]);
    const { t } = tracker();
    await t.tick();
    t.recomputeBet(id);
    expect(view(id).legs[0]!.close!.source).toBe('exact');
  });

  it('portfolio by origin: stake-weighted CLV, share of legs, EV beside placement', async () => {
    const rEvent = addEvent('Philadelphia Eagles', 'Los Angeles Rams');
    const base = {
      event: rEvent,
      home: 'Philadelphia Eagles',
      away: 'Los Angeles Rams',
      side: 'away' as const,
    };
    // Close .626284. Beat by 4.38% at $10, lost by 10.5% at $30.
    addBet([{ ...base, placement: 0.6 }], { stake: 10 });
    addBet([{ ...base, placement: 0.7 }], { stake: 30 });
    addBet([{ ...base, placement: 0.5 }], { origin: 'own' });
    await tracker().t.tick();
    const p = portfolio(db).byOrigin;
    const rec = p.find((o) => o.origin === 'recommended')!;
    expect(rec.clvCount).toBe(2);
    expect(rec.clvLegCount).toBe(2);
    expect(rec.pctBeatClose).toBe(0.5);
    // (10 x (.626284/.6 - 1) + 30 x (.626284/.7 - 1)) / 40
    expect(rec.avgClv).toBeCloseTo(
      (10 * (0.6263 / 0.6 - 1) + 30 * (0.6263 / 0.7 - 1)) / 40,
      3
    );
    // .626284 x $40 - $10 = 15.05; - $30 = -4.95.
    expect(rec.evAtClose).toBeCloseTo(10.1, 1);
    expect(rec.profitWithClv).toBe(0);
    const own = p.find((o) => o.origin === 'own')!;
    expect(own.pctBeatClose).toBe(1);
  });

  it('the page shows a CLV per bet and beat-the-close by origin', async () => {
    const { id } = addBet([rams(0.6)]);
    await tracker().t.tick();
    const b = view(id);
    const d = { timeZone: 'America/Chicago', now: clock } as never;
    const card = await BetCard({ b, d }).toString();
    expect(card).toContain('with-clv');
    expect(card).toMatch(/CLV/);
    expect(card).toContain('+4.4%');
    expect(card).toContain('EV at close +$15.05');
    const missed = await BetCard({
      b: {
        ...b,
        clv: null,
        atClose: { pWin: null, value: null, ev: null, source: 'missed' },
      },
      d,
    }).toString();
    expect(missed).toContain('Missed');
    expect(missed).not.toContain('EV at close');
    const untouched = await BetCard({
      b: { ...b, clv: null, atClose: null },
      d,
    }).toString();
    expect(untouched).not.toContain('with-clv');
    const table = await ClvTable({ rows: portfolio(db).byOrigin })!.toString();
    expect(table).toContain('Beat the close');
    expect(table).toContain('of 1 legs');
  });
});
