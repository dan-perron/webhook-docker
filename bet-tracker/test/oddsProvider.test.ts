import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { events, legs } from '../src/db/schema.js';
import { createProviders } from '../src/gamestate/registry.js';
import { createMcpServer, type Services } from '../src/mcp/server.js';
import { mergeEvents, mergedView } from '../src/odds/merge.js';
import {
  OddsApiClient,
  type OddsEvent,
  type OddsFetch,
} from '../src/odds/oddsApi.js';
import {
  OddsPapiClient,
  type PapiFixture,
  type PapiHistorical,
  type PapiOddsFixture,
} from '../src/odds/oddsPapi.js';
import { summarizeHistory } from '../src/odds/papiHistory.js';
import {
  compactMarkets,
  defKey,
  PapiLookups,
  staticCatalog,
} from '../src/odds/papiLookups.js';
import {
  linkFixture,
  normalizeOddsApi,
  normalizePapi,
  OddsPapiProvider,
  storedFixture,
  type NormEvent,
} from '../src/odds/provider.js';
import { Tracker } from '../src/tracker/tracker.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { scoreService } from './helpers/scores.js';
import { PARAMS } from './helpers/states.js';
import { eq } from 'drizzle-orm';

// OddsPapi as a second live source. Responses: test/fixtures/oddspapi (the
// fixtures list and history are trimmed real responses; /v4/odds and
// /v4/markets are hand-built in the documented shapes, see its README). No
// test calls the real API.
//
// Hand-derived numbers:
//   Pinnacle ML no-vig: 1/1.52 = .657895, 1/2.75 = .363636, sum 1.021531
//     -> Dallas .644030 (fair), Clippers .355970; American -100 * .644030 /
//     .355970 = -180.9 -> -181.
//   DK history close (last price at or before 01:00Z): Dallas 1.524,
//     Clippers 2.6 -> 1/1.524 = .656168, 1/2.6 = .384615, sum 1.040783
//     -> Dallas .630460.
//   DK open: Dallas 1.51, Clippers 2.64 (19:26Z); at a 20:00Z bet the same.

const FIXTURES = fixture<PapiFixture[]>(
  'oddspapi/nba-2026-11-22-fixtures.json'
);
const ODDS = fixture<PapiOddsFixture>('oddspapi/nba-dal-lac-odds.json');
const HIST = fixture<PapiHistorical>('oddspapi/nba-dal-lac-historical.json');
const RAW_MARKETS = fixture<unknown[]>('oddspapi/markets-sample.json');
const START = '2026-11-22T01:00:00.000Z';
const FIXTURE_ID = 'id1100013273719724';
const KEY = 'secret-papi-key';
const CATALOG = new Map(
  compactMarkets(RAW_MARKETS as never).map((d) => [
    defKey(d.sportId, d.marketId),
    d,
  ])
);
const NBA = {
  sportId: 11,
  league: 'basketball_nba',
  markets: ['h2h', 'spreads', 'totals', 'player_prop'] as const,
};

const price = (e: NormEvent, book: string, market: string, outcome: string) =>
  e.prices.find(
    (p) => p.book === book && p.market === market && p.outcome === outcome
  );

describe('market catalogue', () => {
  it('keeps full-game lines and over/under props, drops the rest', () => {
    const ids = [...CATALOG.values()].map((d) => d.marketId).sort();
    expect(ids).toEqual([111, 11264, 11266, 11434, 11438, 111678].sort());
    expect(CATALOG.get(defKey(11, 111678))).toMatchObject({
      market: 'player_prop',
      propType: 'playertotals-points',
      handicap: 28.5,
    });
  });

  it('the checked-in table agrees with the API shape', () => {
    const st = new Map(
      staticCatalog().map((d) => [defKey(d.sportId, d.marketId), d])
    );
    for (const id of [111, 11438, 11266])
      expect(st.get(defKey(11, id))).toEqual(CATALOG.get(defKey(11, id)));
  });
});

describe('normalizePapi', () => {
  const e = normalizePapi(ODDS, CATALOG, {
    ...NBA,
    markets: [...NBA.markets],
    homeIsFirst: true,
    homeAwayFrom: 'espn',
  });

  it("uses the API's decimal and American prices as sent", () => {
    expect(price(e, 'draftkings', 'h2h', 'home')).toMatchObject({
      provider: 'oddspapi',
      american: -191,
      decimal: 1.524,
      line: null,
      lastUpdated: '2026-11-21T22:36:49.924Z',
      mainLine: true,
    });
    // 1.52 would round to -192: the API's -193 is kept.
    expect(price(e, 'pinnacle', 'h2h', 'home')).toMatchObject({
      american: -193,
      decimal: 1.52,
    });
    expect(price(e, 'pinnacle', 'h2h', 'home')!.derived).toBeUndefined();
  });

  it('maps book slugs, drops inactive books/prices and unknown markets', () => {
    expect(price(e, 'williamhill_us', 'h2h', 'away')!.american).toBe(165);
    expect(e.prices.some((p) => p.book === 'betrivers')).toBe(false);
    expect(
      e.prices.filter((p) => p.book === 'pinnacle' && p.market === 'totals')
    ).toHaveLength(1);
    expect(
      e.prices.some((p) => p.decimal === 1.9 && p.book === 'draftkings')
    ).toBe(false);
  });

  it('spreads: participant1 has the handicap, participant2 its negative', () => {
    expect(price(e, 'draftkings', 'spreads', 'home')!.line).toBe(-4.5);
    expect(price(e, 'draftkings', 'spreads', 'away')!.line).toBe(4.5);
    const flipped = normalizePapi(ODDS, CATALOG, {
      ...NBA,
      markets: ['spreads'],
      homeIsFirst: false,
      homeAwayFrom: 'espn',
    });
    expect(flipped.homeTeam).toBe('LA Clippers');
    expect(price(flipped, 'draftkings', 'spreads', 'home')).toMatchObject({
      line: 4.5,
      american: -107,
    });
  });

  it('props carry the player, line and prop type; filter by player', () => {
    expect(price(e, 'draftkings', 'player_prop', 'over')).toMatchObject({
      player: 'Cooper Flagg',
      propType: 'playertotals-points',
      line: 28.5,
      american: -115,
    });
    const none = normalizePapi(ODDS, CATALOG, {
      ...NBA,
      markets: ['player_prop'],
      homeIsFirst: true,
      homeAwayFrom: 'espn',
      player: 'Kyrie',
    });
    expect(none.prices).toEqual([]);
  });
});

describe('normalizeOddsApi', () => {
  it('keeps American as sent and marks the decimal derived', () => {
    const ev: OddsEvent = {
      id: 'oa1',
      sport_key: 'basketball_nba',
      commence_time: START,
      home_team: 'Dallas Mavericks',
      away_team: 'Los Angeles Clippers',
      bookmakers: [
        {
          key: 'draftkings',
          title: 'DraftKings',
          last_update: '2026-11-21T23:00:00Z',
          markets: [
            {
              key: 'h2h',
              outcomes: [
                { name: 'Dallas Mavericks', price: -190 },
                { name: 'Los Angeles Clippers', price: 158 },
              ],
            },
          ],
        },
      ],
    };
    const n = normalizeOddsApi(ev, 'basketball_nba');
    expect(n.prices[0]).toMatchObject({
      provider: 'oddsapi',
      outcome: 'home',
      american: -190,
      decimal: 1.5263,
      derived: 'decimal',
    });
  });
});

describe('fixture <-> our game', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  const insert = (id: string, home: string, away: string, start = START) =>
    db
      .insert(events)
      .values({
        id,
        sport: 'nba',
        provider: 'espn',
        providerEventId: id,
        startTime: start,
        homeName: home,
        awayName: away,
      })
      .run();
  const f = FIXTURES.find((x) => x.fixtureId === FIXTURE_ID)!;

  it('matches by names either way round and stores the link', () => {
    insert('espn:nba:1', 'Dallas Mavericks', 'LA Clippers');
    expect(linkFixture(db, 'basketball_nba', f)).toEqual({
      eventId: 'espn:nba:1',
      homeIsFirst: true,
    });
    expect(storedFixture(db, 'espn:nba:1')).toEqual({
      fixtureId: FIXTURE_ID,
      homeIsFirst: true,
    });
  });

  it('a fixture listed the other way round is oriented by our names', () => {
    // ESPN has the Clippers at home (e.g. a neutral site listed that way).
    insert('espn:nba:2', 'LA Clippers', 'Dallas Mavericks');
    expect(linkFixture(db, 'basketball_nba', f)?.homeIsFirst).toBe(false);
  });

  it('needs the start within 3 hours, and picks the nearest', () => {
    insert(
      'espn:nba:3',
      'Dallas Mavericks',
      'LA Clippers',
      '2026-11-22T05:00:00.000Z'
    );
    expect(linkFixture(db, 'basketball_nba', f)).toBeNull();
    insert(
      'espn:nba:4',
      'Dallas Mavericks',
      'LA Clippers',
      '2026-11-22T02:30:00.000Z'
    );
    insert(
      'espn:nba:5',
      'Dallas Mavericks',
      'LA Clippers',
      '2026-11-22T00:30:00.000Z'
    );
    expect(linkFixture(db, 'basketball_nba', f)?.eventId).toBe('espn:nba:5');
  });

  it('other teams or another sport never match', () => {
    insert('espn:nba:6', 'Dallas Mavericks', 'Los Angeles Lakers');
    expect(linkFixture(db, 'basketball_nba', f)).toBeNull();
    expect(linkFixture(db, 'icehockey_nhl', f)).toBeNull();
  });
});

describe('merge across providers', () => {
  const oddsApi = normalizeOddsApi(
    {
      id: 'oa1',
      sport_key: 'basketball_nba',
      commence_time: START,
      home_team: 'Dallas Mavericks',
      away_team: 'Los Angeles Clippers',
      bookmakers: [
        {
          key: 'draftkings',
          title: 'DraftKings',
          last_update: '2026-11-21T23:00:00Z',
          markets: [
            {
              key: 'h2h',
              outcomes: [
                { name: 'Dallas Mavericks', price: -190 },
                { name: 'Los Angeles Clippers', price: 158 },
              ],
            },
          ],
        },
      ],
    },
    'basketball_nba'
  );
  // No event of ours: OddsPapi's participant1 is a guess, here the wrong one.
  const papi = normalizePapi(ODDS, CATALOG, {
    ...NBA,
    markets: ['h2h'],
    homeIsFirst: false,
    homeAwayFrom: 'participant1',
  });

  it('one event, oriented by the Odds API, each price labelled', () => {
    const [m] = mergeEvents([[oddsApi], [papi]]);
    expect(m).toMatchObject({
      homeTeam: 'Dallas Mavericks',
      ids: { oddsapi: 'oa1', oddspapi: FIXTURE_ID },
      homeAwayFrom: 'provider',
    });
    const v = mergedView(m!);
    const h2h = v.markets.find((x) => x.market === 'h2h')!;
    const dallas = h2h.outcomes.find((o) => o.outcome === 'home')!;
    expect(dallas.name).toBe('Dallas Mavericks');
    expect(
      dallas.books.map((b) => `${b.provider}:${b.book}:${b.american}`)
    ).toEqual([
      'oddsapi:draftkings:-190',
      'oddspapi:draftkings:-191',
      'oddspapi:fanduel:-204',
      'oddspapi:williamhill_us:-200',
      'oddspapi:pinnacle:-193',
    ]);
    // Pinnacle no-vig (see the header).
    expect(dallas.fair).toBe(0.644);
    expect(dallas.fairAmerican).toBe(-181);
    expect(dallas.best).toEqual({
      american: -190,
      book: 'draftkings',
      provider: 'oddsapi',
    });
  });

  it('no Pinnacle on a line: no fair field', () => {
    const [m] = mergeEvents([
      [
        normalizePapi(ODDS, CATALOG, {
          ...NBA,
          markets: ['spreads'],
          homeIsFirst: true,
          homeAwayFrom: 'espn',
        }),
      ],
    ]);
    const lines = mergedView(m!).markets;
    const fd = lines.find((x) => x.line === -5.5)!;
    expect(fd.outcomes[0]!.fair).toBeUndefined();
    const pin = lines.find((x) => x.line === -4.5)!;
    expect(pin.outcomes[0]!.fair).toBeDefined();
  });
});

/** A fake OddsPapi on a fake clock; sleeping advances it. */
function fakePapi(opts: { fail?: 'odds' | 'all'; timeout?: boolean } = {}) {
  let clock = Date.parse('2026-11-21T23:00:00Z');
  const calls: {
    endpoint: string;
    at: number;
    url: string;
    headers: Record<string, string>;
  }[] = [];
  const fetchFn: OddsFetch = async (url, init) => {
    const endpoint = url.split('?')[0]!.split('/').pop()!;
    calls.push({ endpoint, at: clock, url, headers: init?.headers ?? {} });
    if (opts.timeout) {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    }
    if (opts.fail === 'all' || opts.fail === endpoint)
      return {
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: async () => ({ error: { code: 'INTERNAL_ERROR' } }),
      };
    const tagged = init?.headers?.['If-None-Match'] === '"h1"';
    const body =
      endpoint === 'fixtures'
        ? FIXTURES.map((f) => ({ ...f, statusId: 0 }))
        : endpoint === 'odds'
          ? ODDS
          : endpoint === 'markets'
            ? RAW_MARKETS
            : endpoint === 'historical-odds'
              ? HIST
              : endpoint === 'account'
                ? { subscriptions: [{ request_count: 17, request_limit: 250 }] }
                : [];
    return {
      ok: true,
      status: tagged ? 304 : 200,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'etag' && endpoint === 'historical-odds'
            ? '"h1"'
            : null,
      },
      json: async () => (tagged ? null : body),
    };
  };
  const client = new OddsPapiClient({
    apiKey: KEY,
    baseUrl: 'http://papi/v4',
    books: ['draftkings', 'fanduel', 'caesars'],
    fetch: fetchFn,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { client, calls, now: () => clock };
}

describe('OddsPapiClient', () => {
  it('spaces calls per endpoint, even when sent together', async () => {
    const { client, calls } = fakePapi();
    await Promise.all([
      client.odds(FIXTURE_ID, []),
      client.odds(FIXTURE_ID, []),
      client.historical(FIXTURE_ID, ['draftkings']),
      client.historical(FIXTURE_ID, ['fanduel']),
    ]);
    const at = (ep: string) =>
      calls.filter((c) => c.endpoint === ep).map((c) => c.at);
    const [o1, o2] = at('odds');
    expect(o2! - o1!).toBeGreaterThanOrEqual(500);
    const [h1, h2] = at('historical-odds');
    expect(h2! - h1!).toBeGreaterThanOrEqual(5000);
  });

  it('sends the ETag back and reuses the body on a 304', async () => {
    const { client, calls } = fakePapi();
    const a = await client.historical(FIXTURE_ID, ['draftkings']);
    const b = await client.historical(FIXTURE_ID, ['draftkings']);
    expect(calls[1]!.headers['If-None-Match']).toBe('"h1"');
    expect(b).toEqual(a);
    expect(Object.keys(b.bookmakers)).toContain('draftkings');
  });

  it('counts metered requests only; reads usage from /v4/account', async () => {
    const { client } = fakePapi();
    await client.odds(FIXTURE_ID, []);
    await client.historical(FIXTURE_ID, ['draftkings']);
    expect(client.meteredSent).toBe(1);
    expect(await client.usageNow()).toMatchObject({ used: 17, limit: 250 });
  });

  it('errors and timeouts never carry the key', async () => {
    for (const o of [{ fail: 'all' as const }, { timeout: true }]) {
      const { client } = fakePapi(o);
      const err = await client.odds(FIXTURE_ID, []).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/^OddsPapi odds -> /);
      expect((err as Error).message).not.toContain(KEY);
    }
  });
});

describe('PapiLookups', () => {
  it('caches each lookup for 24 h in the database', async () => {
    const db = openDb(':memory:');
    const { client, calls } = fakePapi();
    let now = Date.parse('2026-11-21T00:00:00Z');
    const lookups = new PapiLookups(db, client, () => now);
    await lookups.markets();
    now += 23 * 3600_000;
    // A new process (same database) still uses the stored copy.
    await new PapiLookups(db, client, () => now).markets();
    expect(calls.filter((c) => c.endpoint === 'markets')).toHaveLength(1);
    now += 2 * 3600_000;
    await lookups.markets();
    expect(calls.filter((c) => c.endpoint === 'markets')).toHaveLength(2);
  });

  it('falls back to the checked-in table when nothing was ever fetched', async () => {
    const db = openDb(':memory:');
    const { client } = fakePapi({ fail: 'all' });
    const m = await new PapiLookups(db, client).markets();
    expect(m.source).toBe('static');
    expect(m.byId.get(defKey(11, 111))?.market).toBe('h2h');
  });
});

describe('MCP: check_odds sources and get_historical_odds', () => {
  let db: Db;
  let client: Client;
  let oddsApiCalls: string[];
  let papi: ReturnType<typeof fakePapi>;

  const ODDS_API_EVENT: OddsEvent = {
    id: 'oa1',
    sport_key: 'basketball_nba',
    commence_time: START,
    home_team: 'Dallas Mavericks',
    away_team: 'Los Angeles Clippers',
    bookmakers: [
      {
        key: 'fanduel',
        title: 'FanDuel',
        last_update: '2026-11-21T23:00:00Z',
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'Dallas Mavericks', price: -205 },
              { name: 'Los Angeles Clippers', price: 170 },
            ],
          },
        ],
      },
    ],
  };

  async function connect(p: ReturnType<typeof fakePapi>) {
    papi = p;
    db = openDb(':memory:');
    db.insert(events)
      .values({
        id: 'espn:nba:401910025',
        sport: 'nba',
        provider: 'espn',
        providerEventId: '401910025',
        startTime: START,
        homeName: 'Dallas Mavericks',
        awayName: 'LA Clippers',
        status: 'final',
        nextPollAt: '2030-01-01T00:00:00.000Z',
      })
      .run();
    oddsApiCalls = [];
    const providers = createProviders(fakeFetcher({}).fetcher);
    const tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
    });
    const lookups = new PapiLookups(db, p.client, p.now);
    const services: Services = {
      db,
      providers,
      tracker,
      scores: scoreService(db, providers, tracker),
      odds: new OddsApiClient(db, {
        apiKey: 'oa',
        baseUrl: 'http://odds',
        regions: 'us',
        cacheSeconds: 0,
        fetch: async (url) => {
          oddsApiCalls.push(url);
          return {
            ok: true,
            status: 200,
            headers: {
              get: (h: string) =>
                ({
                  'x-requests-remaining': '480',
                  'x-requests-used': '20',
                  'x-requests-last': '1',
                })[h] ?? null,
            },
            json: async () => [ODDS_API_EVENT],
          };
        },
      }),
      confirmAboveCost: 3,
      papi: {
        client: p.client,
        lookups,
        provider: new OddsPapiProvider(db, p.client, lookups, { now: p.now }),
      },
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(services).connect(a);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
  }
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return {
      isError: !!r.isError,
      text,
      data: (r.isError ? null : JSON.parse(text)) as T,
    };
  };

  it('default source is the Odds API, unchanged, and never calls OddsPapi', async () => {
    await connect(fakePapi());
    const r = await call<Record<string, unknown>>('check_odds', {
      sport: 'nba',
      teams_or_event: 'Mavericks',
      markets: ['h2h'],
    });
    expect(Object.keys(r.data)).toEqual([
      'source',
      'sportKey',
      'cost',
      'cached',
      'quota',
      'eventCount',
      'events',
    ]);
    expect(r.data.source).toBe('The Odds API');
    expect(papi.calls).toEqual([]);
  });

  it('both: merged, labelled, Pinnacle fair, costs reported per provider', async () => {
    await connect(fakePapi());
    const r = await call<{
      cost: Record<string, number>;
      quota: Record<string, Record<string, unknown>>;
      events: ReturnType<typeof mergedView>[];
      warnings?: string[];
    }>('check_odds', {
      sport: 'nba',
      teams_or_event: 'Mavericks',
      markets: ['h2h'],
      source: 'both',
    });
    expect(r.isError).toBe(false);
    expect(r.data.cost).toEqual({ oddsapi: 1, oddspapi: 2 });
    expect(r.data.quota.oddspapi).toMatchObject({
      used: 17,
      limit: 250,
      remaining: 233,
    });
    expect(r.data.quota.oddsapi).toEqual({ remaining: 480, used: 20 });
    expect(r.data.events).toHaveLength(1);
    const ev = r.data.events[0]!;
    expect(ev).toMatchObject({
      eventId: 'espn:nba:401910025',
      ids: { oddsapi: 'oa1', oddspapi: FIXTURE_ID },
      homeAwayFrom: 'espn',
    });
    const dallas = ev.markets[0]!.outcomes[0]!;
    expect(dallas.fair).toBe(0.644);
    expect(new Set(dallas.books.map((b) => b.provider))).toEqual(
      new Set(['oddsapi', 'oddspapi'])
    );
    // The default books add Pinnacle; the key never leaves the client.
    const oddsCall = papi.calls.find((c) => c.endpoint === 'odds')!;
    expect(new URL(oddsCall.url).searchParams.get('bookmakers')).toBe(
      'draftkings,fanduel,caesars,pinnacle'
    );
    expect(r.text).not.toContain(KEY);
  });

  it('both: OddsPapi down -> Odds API data plus a warning', async () => {
    await connect(fakePapi({ timeout: true }));
    const r = await call<{ events: unknown[]; warnings: string[] }>(
      'check_odds',
      {
        sport: 'nba',
        teams_or_event: 'Mavericks',
        markets: ['h2h'],
        source: 'both',
      }
    );
    expect(r.isError).toBe(false);
    expect(r.data.events).toHaveLength(1);
    expect(r.data.warnings).toEqual([
      'oddspapi: OddsPapi fixtures -> timed out; showing Odds API data only',
    ]);
  });

  it('both: OddsPapi failing after the fixture list -> warning too', async () => {
    await connect(fakePapi({ fail: 'odds' }));
    const r = await call<{ warnings: string[]; events: unknown[] }>(
      'check_odds',
      {
        sport: 'nba',
        teams_or_event: 'Mavericks',
        markets: ['h2h'],
        source: 'both',
      }
    );
    expect(r.data.events).toHaveLength(1);
    expect(r.data.warnings[0]).toMatch(/^oddspapi: OddsPapi odds -> HTTP 500/);
  });

  it('oddspapi: errors fail the call; uncovered sports are refused', async () => {
    await connect(fakePapi({ timeout: true }));
    expect(
      (await call('check_odds', { sport: 'nba', source: 'oddspapi' })).isError
    ).toBe(true);
    const mma = await call('check_odds', { sport: 'mma', source: 'oddspapi' });
    expect(mma.text).toMatch(/does not cover mma_mixed_martial_arts/);
    expect(
      (await call('check_odds', { sport: 'nba', markets: ['player_prop'] }))
        .text
    ).toMatch(/source "oddspapi"/);
  });

  it('oddspapi without a filter needs confirm above the threshold', async () => {
    await connect(fakePapi());
    const r = await call<{
      requiresConfirmation: boolean;
      cost: Record<string, number>;
    }>('check_odds', { sport: 'nba', source: 'oddspapi' });
    // Fixtures list (1) + 3 games in the next day.
    expect(r.data).toMatchObject({
      requiresConfirmation: true,
      cost: { oddspapi: 4 },
    });
    expect(papi.calls.filter((c) => c.endpoint === 'odds')).toHaveLength(0);
  });

  it('oddspapi props: the main line per player', async () => {
    await connect(fakePapi());
    const r = await call<{ events: ReturnType<typeof mergedView>[] }>(
      'check_odds',
      {
        sport: 'nba',
        teams_or_event: 'Mavericks',
        markets: ['player_prop'],
        source: 'oddspapi',
      }
    );
    expect(r.data.events[0]!.markets).toMatchObject([
      {
        market: 'player_prop',
        propType: 'playertotals-points',
        player: 'Cooper Flagg',
        line: 28.5,
        outcomes: [
          { outcome: 'over', point: 28.5, books: [{ american: -115 }] },
          { outcome: 'under', books: [{ american: -105 }] },
        ],
      },
    ]);
  });

  it('get_historical_odds: open, close, at bet; link remembered', async () => {
    await connect(fakePapi());
    const bet = createBet(db, {
      book: 'DraftKings',
      stake: 10,
      price: -190,
      placedAt: '2026-11-21T20:00:00.000Z',
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
    const legId = bet.legs[0]!.id;
    db.update(legs)
      .set({
        eventId: 'espn:nba:401910025',
        matchStatus: 'matched',
        side: 'home',
      })
      .where(eq(legs.id, legId))
      .run();
    type Out = {
      fixtureId: string;
      leg: { side: string };
      books: {
        book: string;
        line?: number;
        fairClose: Record<string, number>;
        outcomes: {
          outcome: string;
          open: { decimal: number };
          close: { decimal: number; american: number };
          atBet: { decimal: number };
        }[];
      }[];
    };
    const r = await call<Out>('get_historical_odds', {
      legId,
      books: ['draftkings'],
    });
    expect(r.isError).toBe(false);
    expect(r.data.fixtureId).toBe(FIXTURE_ID);
    expect(r.data.leg.side).toBe('home');
    const dk = r.data.books[0]!;
    expect(dk.book).toBe('draftkings');
    expect(dk.outcomes[0]).toMatchObject({
      outcome: 'home',
      open: { decimal: 1.51 },
      close: { decimal: 1.524, american: -191 },
      atBet: { decimal: 1.51 },
    });
    expect(dk.outcomes[1]).toMatchObject({
      outcome: 'away',
      close: { decimal: 2.6 },
    });
    expect(dk.fairClose['Dallas Mavericks']).toBe(0.6305);
    expect(papi.calls.filter((c) => c.endpoint === 'fixtures')).toHaveLength(1);

    // Again by eventId, spreads: the stored link, no second fixtures lookup.
    const s = await call<Out>('get_historical_odds', {
      eventId: 'espn:nba:401910025',
      market: 'spreads',
      books: ['draftkings'],
    });
    expect(s.data.books[0]!.line).toBe(-4.5);
    expect(papi.calls.filter((c) => c.endpoint === 'fixtures')).toHaveLength(1);
  });
});

describe('summarizeHistory', () => {
  it('an exact line, from the home side, when the fixture is flipped', () => {
    const f = FIXTURES.find((x) => x.fixtureId === FIXTURE_ID)!;
    const [dk] = summarizeHistory(
      { ...HIST, bookmakers: { draftkings: HIST.bookmakers.draftkings! } },
      CATALOG,
      {
        // Pretend ESPN has the Clippers at home: participant1 is away.
        fixture: f,
        homeIsFirst: false,
        sportId: 11,
        market: 'spreads',
        line: 4.5,
      }
    );
    expect(dk).toMatchObject({ line: 4.5 });
    expect(dk!.outcomes[0]).toMatchObject({
      name: 'LA Clippers',
      outcome: 'home',
      point: 4.5,
    });
  });
});
