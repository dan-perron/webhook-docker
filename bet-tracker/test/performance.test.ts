import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { bets, legs } from '../src/db/schema.js';
import type { BetOrigin, BetStatus } from '../src/domain/types.js';
import { createProviders } from '../src/gamestate/registry.js';
import { createMcpServer, type Services } from '../src/mcp/server.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { performanceSeries } from '../src/tracker/performance.js';
import { Tracker } from '../src/tracker/tracker.js';
import { portfolio } from '../src/tracker/views.js';
import { fakeFetcher } from './helpers/fixtures.js';
import { scoreService } from './helpers/scores.js';
import { PARAMS } from './helpers/states.js';

// Cumulative profit vs. EV at placement by settlement day (America/Chicago).
// Hand-derived profits (returned - cash stake):
//   A won  $10 at +100            -> +10.00   (11-20 10:00 CST)
//   B lost $20 at -110            -> -20.00   (11-20 20:00 CST)
//   C push $10 at -110            ->   0.00   (11-21 05:30Z = 11-20 23:30 CST)
//   D won  $25 bonus bet at +150  -> +37.50   (payout = profit only)
//   E void, F open                -> left out
// Day totals: 11-20 = 10 - 20 + 0 = -10.00 (3 bets); 11-22 = +27.50 (1).

let db: Db;

function bet(o: {
  stake: number;
  price: number;
  status: BetStatus;
  settledAt?: string;
  pWin?: number;
  origin?: BetOrigin;
  bonusBet?: boolean;
  sport?: 'nba' | 'nfl';
}): number {
  const { bet: b, legs: rows } = createBet(db, {
    book: 'DraftKings',
    stake: o.stake,
    price: o.price,
    ...(o.bonusBet ? { bonusBet: true } : {}),
    ...(o.origin ? { origin: o.origin } : {}),
    legs: [
      {
        sport: o.sport ?? 'nba',
        eventDate: '2026-11-20',
        participants: ['LA Clippers', 'Dallas Mavericks'],
        market: 'moneyline',
        selection: { kind: 'team', team: 'Dallas Mavericks' },
        price: o.price,
      },
    ],
  });
  const legStatus = o.status === 'open' ? 'open' : o.status;
  db.update(legs)
    .set({
      status: legStatus,
      ...(o.pWin != null ? { pWinPlacement: o.pWin, pPushPlacement: 0 } : {}),
    })
    .where(eq(legs.id, rows[0]!.id))
    .run();
  db.update(bets)
    .set({ status: o.status, settledAt: o.settledAt ?? null })
    .where(eq(bets.id, b.id))
    .run();
  return b.id;
}

function seed() {
  bet({
    stake: 10,
    price: 100,
    status: 'won',
    settledAt: '2026-11-20T16:00:00Z',
    pWin: 0.55,
    origin: 'recommended',
  });
  bet({
    stake: 20,
    price: -110,
    status: 'lost',
    settledAt: '2026-11-21T02:00:00Z',
    pWin: 0.56,
    origin: 'recommended',
  });
  bet({
    stake: 10,
    price: -110,
    status: 'push',
    settledAt: '2026-11-21T05:30:00Z',
    pWin: 0.5,
    origin: 'own',
    sport: 'nfl',
  });
  bet({
    stake: 25,
    price: 150,
    status: 'won',
    settledAt: '2026-11-22T18:00:00Z',
    pWin: 0.45,
    origin: 'recommended',
    bonusBet: true,
  });
  // Void: no EV at placement, so portfolio's EV sum (which counts voids) agrees.
  bet({
    stake: 10,
    price: -110,
    status: 'void',
    settledAt: '2026-11-22T19:00:00Z',
    origin: 'own',
  });
  bet({ stake: 10, price: -110, status: 'open', pWin: 0.6, origin: 'own' });
}

beforeEach(() => {
  db = openDb(':memory:');
  seed();
});

describe('performanceSeries', () => {
  it('cumulative profit by Chicago settlement day, voids and open left out', () => {
    const s = performanceSeries(db);
    expect(s.count).toBe(4);
    expect(s.excluded).toEqual({ void: 1, noSettledAt: 0 });
    expect(s.unitDollars).toBe(10);
    expect(
      s.points.map(({ date, actual, betsSettled }) => ({
        date,
        actual,
        betsSettled,
      }))
    ).toEqual([
      { date: '2026-11-20', actual: -10, betsSettled: 3 },
      { date: '2026-11-22', actual: 27.5, betsSettled: 1 },
    ]);
    // Expected only ever adds EV at placement; it is cumulative too.
    expect(s.points[1]!.expected).not.toBe(s.points[0]!.expected);
  });

  it.each([
    [{}],
    [{ origin: 'recommended' as const }],
    [{ origin: 'own' as const }],
    [{ origin: 'untagged' as const }],
    [{ sport: 'nfl' as const }],
  ])(
    'ends at portfolio settled.profit and byOrigin EV at placement (%o)',
    (f) => {
      const s = performanceSeries(db, f);
      const p = portfolio(db, f);
      const last = s.points.at(-1) ?? { actual: 0, expected: 0 };
      const ev = p.byOrigin.reduce((a, o) => a + o.settled.evAtPlacement, 0);
      expect(last.actual).toBeCloseTo(p.settled.profit, 9);
      expect(last.expected).toBeCloseTo(Math.round(ev * 100) / 100, 9);
    }
  );

  it('filters like portfolio', () => {
    expect(performanceSeries(db, { origin: 'own' }).count).toBe(1);
    expect(performanceSeries(db, { origin: 'recommended' }).count).toBe(3);
    expect(performanceSeries(db, { sport: 'nfl' }).points).toEqual([
      {
        date: '2026-11-20',
        actual: 0,
        expected: expect.any(Number),
        betsSettled: 1,
      },
    ]);
  });
});

describe('endpoint and MCP tool', () => {
  function services(): Services {
    const providers = createProviders(fakeFetcher({}).fetcher);
    const tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
    });
    return {
      db,
      providers,
      tracker,
      scores: scoreService(db, providers, tracker),
      odds: new OddsApiClient(db, {
        apiKey: '',
        baseUrl: 'x',
        regions: 'us',
        cacheSeconds: 60,
      }),
      confirmAboveCost: 3,
    };
  }

  it('GET /api/performance-series needs a session, then returns the series', async () => {
    const app = createApp(services(), {
      appToken: 't',
      publicOrigin: 'https://djperron.com',
    });
    const anon = await app.request('/api/performance-series');
    expect(anon.status).toBe(302);
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app_token: 't' }).toString(),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const res = await app.request(
      '/api/performance-series?origin=recommended',
      {
        headers: { cookie },
      }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      JSON.parse(
        JSON.stringify(performanceSeries(db, { origin: 'recommended' }))
      )
    );
    const bad = await app.request('/api/performance-series?timing=soon', {
      headers: { cookie },
    });
    expect(bad.status).toBe(400);
    // History carries the chart and its scripts; the open-bets page doesn't.
    const page = async (q: string) =>
      (await app.request(`/${q}`, { headers: { cookie } })).text();
    const history = await page('?tab=settled');
    expect(history).toContain('id="perf-chart"');
    expect(history).toContain('/static/vendor/chart.umd.min.js');
    const bets = await page('');
    expect(bets).not.toContain('id="perf-chart"');
    expect(bets).not.toContain('chart.umd.min.js');
    const js = await app.request('/static/vendor/chart.umd.min.js');
    expect(js.status).toBe(200);
    expect(await js.text()).toMatch(/Chart/);
  });

  it('performance_series returns the same data', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(services()).connect(a);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
    const r = await client.callTool({
      name: 'performance_series',
      arguments: { origin: 'own' },
    });
    const data = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(data).toEqual(
      JSON.parse(JSON.stringify(performanceSeries(db, { origin: 'own' })))
    );
  });
});
