import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/client.js';
import {
  filterEvents,
  linesFromOdds,
  oddsView,
  summarizeEvent,
} from '../src/odds/consensus.js';
import {
  OddsApiClient,
  requestCost,
  sportKey,
  type OddsEvent,
  type OddsFetch,
} from '../src/odds/oddsApi.js';
import { fixture } from './helpers/fixtures.js';

// Constructed fixture (see test/fixtures/oddsapi/README.md); numbers below
// are hand-computed from its prices.
const EVENTS = fixture<OddsEvent[]>('oddsapi/nfl-lar-phi-constructed.json');

/** Fake fetch returning the fixture with quota headers; records URLs. */
function fakeOddsFetch(remaining = 480, used = 20, last = 3) {
  const urls: string[] = [];
  const f: OddsFetch = async (url) => {
    urls.push(url);
    const headers = new Map([
      ['x-requests-remaining', String(remaining)],
      ['x-requests-used', String(used)],
      ['x-requests-last', String(last)],
    ]);
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => headers.get(h) ?? null },
      json: async () => EVENTS,
    };
  };
  return { f, urls };
}

describe('request cost and sport keys', () => {
  it('cost = markets x regions; bookmakers count per 10 as a region', () => {
    expect(requestCost(3, 1)).toBe(3);
    expect(requestCost(1, 2)).toBe(2);
    expect(requestCost(3, 1, 4)).toBe(3);
    expect(requestCost(3, 1, 11)).toBe(6);
  });

  it('maps sports, ESPN soccer leagues and raw keys', () => {
    expect(sportKey('nfl')).toBe('americanfootball_nfl');
    expect(sportKey('soccer', 'uefa.nations')).toBe(
      'soccer_uefa_nations_league'
    );
    expect(sportKey('eng.1')).toBe('soccer_epl');
    expect(sportKey('soccer', 'bra.1')).toBe('soccer_brazil_campeonato');
    expect(sportKey('soccer', 'arg.1')).toBe(
      'soccer_argentina_primera_division'
    );
    expect(sportKey('soccer', 'eng.3')).toBe('soccer_england_league1');
    expect(sportKey('soccer', 'eng.4')).toBe('soccer_england_league2');
    expect(sportKey('soccer_epl')).toBe('soccer_epl');
    expect(() => sportKey('soccer')).toThrow(/league/);
    expect(() => sportKey('curling')).toThrow(/Unknown/);
  });
});

describe('summarizeEvent', () => {
  const e = summarizeEvent(EVENTS[0]!);

  it('de-vigs each book: FanDuel -190/+160 -> 0.630102 / 0.369898, hold 3.98%', () => {
    const h2h = e.markets.find((m) => m.market === 'h2h')!;
    const fd = h2h.books.find((b) => b.book === 'fanduel')!;
    expect(fd.fair['Los Angeles Rams']).toBeCloseTo(0.630102, 6);
    expect(fd.fair['Philadelphia Eagles']).toBeCloseTo(0.369898, 6);
    expect(fd.hold).toBeCloseTo(0.039788, 6);
  });

  it('consensus averages fair probabilities; best price per side', () => {
    const h2h = e.markets.find((m) => m.market === 'h2h')!;
    // (0.630102 + 0.622467) / 2
    expect(h2h.consensus['Los Angeles Rams']).toBeCloseTo(0.626284, 6);
    expect(h2h.bestPrice['Los Angeles Rams']).toEqual({
      price: -185,
      book: 'DraftKings',
    });
    expect(h2h.bestPrice['Philadelphia Eagles']).toEqual({
      price: 160,
      book: 'FanDuel',
    });
  });

  it('groups spreads by the home point and totals by line', () => {
    const spreads = e.markets.filter((m) => m.market === 'spreads');
    expect(spreads).toHaveLength(1);
    expect(spreads[0]!.point).toBe(3.5);
    expect(spreads[0]!.books).toHaveLength(2);
    const totals = e.markets.filter((m) => m.market === 'totals');
    expect(totals.map((t) => t.point).sort()).toEqual([42.5, 43.5]);
  });

  it('reduces to vig-free prior lines', () => {
    // consensus PHI 0.373716 -> decimal 2.675831 -> +168; LAR -> -168.
    // Spread: FD -110/-110 -> 0.5, DK PHI -115/LAR -105 -> 0.510834; mean
    // 0.505417 -> -102 / +102. Total 42.5 (FanDuel only, -110/-110) -> +100 each.
    expect(linesFromOdds(e)).toEqual({
      homeMoneyline: 168,
      awayMoneyline: -168,
      drawMoneyline: null,
      spreadHome: 3.5,
      spreadHomePrice: -102,
      spreadAwayPrice: 102,
      total: 42.5,
      overPrice: 100,
      underPrice: 100,
    });
  });
});

describe('filterEvents', () => {
  it.each([
    ['Rams', 1],
    ['Rams @ Eagles', 1],
    ['Los Angeles Rams vs Philadelphia Eagles', 1],
    ['Bears', 1],
    ['Rams @ Bears', 0],
    ['', 2],
  ])('"%s" -> %i', (q, n) => {
    expect(filterEvents(EVENTS, q)).toHaveLength(n);
  });
});

describe('OddsApiClient', () => {
  let db: Db;
  let clock: number;
  beforeEach(() => {
    db = openDb(':memory:');
    clock = Date.parse('2026-10-03T20:15:00Z');
  });
  const client = (f: OddsFetch, apiKey = 'secret-key') =>
    new OddsApiClient(db, {
      apiKey,
      baseUrl: 'https://api.the-odds-api.com/v4',
      regions: 'us',
      cacheSeconds: 60,
      fetch: f,
      now: () => clock,
    });

  it('stores quota headers and serves repeats from a 60 s cache', async () => {
    const { f, urls } = fakeOddsFetch();
    const c = client(f);
    const req = {
      sportKey: 'americanfootball_nfl',
      markets: ['h2h', 'spreads', 'totals'] as const,
    };
    const r1 = await c.getOdds({ ...req, markets: [...req.markets] });
    expect(r1).toMatchObject({
      cost: 3,
      cached: false,
      quota: { remaining: 480, used: 20, last: 3 },
    });
    expect(urls[0]).toContain(
      '/sports/americanfootball_nfl/odds?markets=h2h%2Cspreads%2Ctotals'
    );
    expect(urls[0]).toContain('regions=us');
    expect(c.quota().remaining).toBe(480);

    clock += 30_000;
    const r2 = await c.getOdds({ ...req, markets: [...req.markets] });
    expect(r2).toMatchObject({ cached: true, cost: 0 });
    expect(urls).toHaveLength(1);

    clock += 31_000;
    await c.getOdds({ ...req, markets: [...req.markets] });
    expect(urls).toHaveLength(2);
  });

  it('uses bookmakers instead of regions when given', async () => {
    const { f, urls } = fakeOddsFetch();
    await client(f).getOdds({
      sportKey: 'americanfootball_nfl',
      markets: ['h2h'],
      books: ['fanduel', 'draftkings'],
    });
    expect(urls[0]).toContain('bookmakers=fanduel%2Cdraftkings');
    expect(urls[0]).not.toContain('regions=');
  });

  it('never puts the API key in an error', async () => {
    const f: OddsFetch = async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({}),
    });
    const err = await client(f)
      .getOdds({ sportKey: 'americanfootball_nfl', markets: ['h2h'] })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'Odds API americanfootball_nfl -> HTTP 401'
    );
    expect((err as Error).message).not.toContain('secret-key');
  });

  it('refuses to call without a key', async () => {
    const { f } = fakeOddsFetch();
    const c = client(f, '');
    expect(c.configured).toBe(false);
    await expect(
      c.getOdds({ sportKey: 'x_y', markets: ['h2h'] })
    ).rejects.toThrow(/ODDS_API_KEY/);
  });
});

describe('oddsView: per-outcome points', () => {
  it('MLB run line reads Brewers -1.5 +168 / Padres +1.5 -205', () => {
    const ev: OddsEvent = {
      id: 'x',
      sport_key: 'baseball_mlb',
      commence_time: '2026-10-08T02:00:00Z',
      home_team: 'San Diego Padres',
      away_team: 'Milwaukee Brewers',
      bookmakers: [
        {
          key: 'fanduel',
          title: 'FanDuel',
          last_update: '2026-10-07T20:00:00Z',
          markets: [
            {
              key: 'spreads',
              outcomes: [
                { name: 'Milwaukee Brewers', price: 168, point: -1.5 },
                { name: 'San Diego Padres', price: -205, point: 1.5 },
              ],
            },
            {
              key: 'totals',
              outcomes: [
                { name: 'Over', price: -110, point: 7.5 },
                { name: 'Under', price: -110, point: 7.5 },
              ],
            },
          ],
        },
      ],
    };
    const v = oddsView(summarizeEvent(ev));
    const rl = v.markets.find((m) => m.market === 'spreads')!;
    expect(
      rl.outcomes.map((o) => [o.name, o.point, o.books[0]!.price])
    ).toEqual([
      ['Milwaukee Brewers', -1.5, 168],
      ['San Diego Padres', 1.5, -205],
    ]);
    // De-vigged: 1/2.68 = 0.373134 and 205/305 = 0.672131 -> 0.357 / 0.643
    expect(rl.outcomes[0]!.fair).toBeCloseTo(0.357, 3);
    const tot = v.markets.find((m) => m.market === 'totals')!;
    expect(tot.outcomes.map((o) => [o.name, o.point])).toEqual([
      ['Over', 7.5],
      ['Under', 7.5],
    ]);
    // No single ambiguous point on the market.
    expect(rl).not.toHaveProperty('point');
  });
});
