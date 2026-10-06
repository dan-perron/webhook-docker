import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import { createProviders } from '../src/gamestate/registry.js';
import { matchLegs } from '../src/matching/service.js';
import { createMcpServer, type Services } from '../src/mcp/server.js';
import { OddsApiClient, type OddsFetch } from '../src/odds/oddsApi.js';
import { loadSeed } from '../src/seed/load.js';
import { Tracker } from '../src/tracker/tracker.js';
import type { BetView, Portfolio } from '../src/tracker/views.js';
import { fakeFetcher, fixture, SEED_ROUTES } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

const ROUTES = {
  'college-football/summary?event=401856819':
    'espn/summary-ncaaf-401856819-live.json',
  'college-football/summary?event=401858474':
    'espn/summary-ncaaf-401858474-final.json',
  'baseball/mlb/summary?event=401907990':
    'espn/summary-mlb-401907990-live.json',
  'soccer/uefa.nations/summary?event=401861126':
    'espn/summary-soccer-401861126-pre.json',
  'baseball/mlb/scoreboard?dates=20261003': 'espn/mlb-20261003-top8.json',
  'statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=':
    'mlb/schedule-20261003.json',
  'hockey/nhl/scoreboard?dates=20261006': 'espn/nhl-20261006-pre.json',
  'basketball/wnba/scoreboard?dates=20261007': 'espn/wnba-20261007-pre.json',
  ...SEED_ROUTES,
};

let client: Client;
let oddsUrls: string[];

beforeEach(async () => {
  const db = openDb(':memory:');
  loadSeed(db);
  const providers = createProviders(fakeFetcher(ROUTES).fetcher);
  await matchLegs(db, providers);
  oddsUrls = [];
  const oddsFetch: OddsFetch = async (url) => {
    oddsUrls.push(url);
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) =>
          ({
            'x-requests-remaining': '497',
            'x-requests-used': '3',
            'x-requests-last': '3',
          })[h] ?? null,
      },
      json: async () => fixture('oddsapi/nfl-lar-phi-constructed.json'),
    };
  };
  const now = () => new Date('2026-10-03T19:40:00.000Z');
  const services: Services = {
    db,
    providers,
    tracker: new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now,
    }),
    odds: new OddsApiClient(db, {
      apiKey: 'k',
      baseUrl: 'https://api.the-odds-api.com/v4',
      regions: 'us',
      cacheSeconds: 60,
      fetch: oddsFetch,
    }),
    confirmAboveCost: 3,
  };
  await services.tracker.tick();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(services).connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});

async function call<T = unknown>(
  name: string,
  args: Record<string, unknown> = {}
) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  return {
    isError: !!r.isError,
    text,
    data: (r.isError ? null : JSON.parse(text)) as T,
  };
}

describe('MCP tools', () => {
  it('lists the tools with units in their descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_bet',
      'check_odds',
      'confirm_match',
      'get_bet',
      'list_bets',
      'portfolio',
      'remove_bet',
      'settle_bet',
      'update_bet',
    ]);
    for (const name of [
      'check_odds',
      'add_bet',
      'list_bets',
      'get_bet',
      'portfolio',
    ]) {
      const d = tools.find((t) => t.name === name)!.description!;
      expect(d).toMatch(/US dollars/);
      expect(d).toMatch(/American odds/);
    }
  });

  it('list_bets: dollars, statuses and model values', async () => {
    const { data } = await call<BetView[]>('list_bets');
    expect(data).toHaveLength(10);
    const minn = data.find((b) => b.label === 'Minnesota ML')!;
    expect(minn).toMatchObject({
      status: 'won',
      stake: 10,
      payout: 34,
      now: { value: 34, ev: 24 },
    });
    const open = await call<BetView[]>('list_bets', { status: 'open' });
    expect(open.data.every((b) => b.status === 'open')).toBe(true);
  });

  it('get_bet: live state, model inputs and prior', async () => {
    const list = (await call<BetView[]>('list_bets')).data;
    const id = list.find((b) => b.label === 'Chicago White Sox ML')!.id;
    const { data } = await call<BetView>('get_bet', { id });
    const leg = data.legs[0]!;
    expect(leg.live).toMatchObject({
      status: 'in',
      score: 'Chicago White Sox 3 @ Cleveland Guardians 0',
    });
    expect(leg.prior).toMatchObject({
      source: 'espn_lines',
      totalLine: { line: 6.5 },
    });
    expect(leg.model).toBe('mlb_exact');
    expect(leg.modelInputs).toHaveProperty('dispersion');
    expect((await call('get_bet', { id: 999 })).isError).toBe(true);
  });

  it('add_bet matches the leg and returns model P(win)', async () => {
    const { data } = await call<{ bet: BetView; matching: unknown }>(
      'add_bet',
      {
        book: 'FanDuel',
        stake: 20,
        price: -142,
        legs: [
          {
            sport: 'nfl',
            eventDate: '2026-10-04',
            participants: ['Chicago Bears', 'New York Jets'],
            market: 'moneyline',
            selection: { kind: 'team', team: 'Chicago Bears' },
            price: -142,
          },
        ],
      }
    );
    expect(data.matching).toBe('all legs matched');
    expect(data.bet.legs[0]!.match).toMatchObject({
      status: 'matched',
      eventId: 'espn:nfl:401872972',
    });
    expect(data.bet.legs[0]!.side).toBe('home');
    expect(data.bet.legs[0]!.pWin).toBeGreaterThan(0);
    // $20 at -142 pays 20 x (1 + 100/142)
    expect(data.bet.payout).toBeCloseTo(34.08, 2);
  });

  it('add_bet reports legs it could not match instead of guessing', async () => {
    const { data } = await call<{
      matching: { needsAttention: { status: string }[] };
    }>('add_bet', {
      book: 'FanDuel',
      stake: 5,
      price: 150,
      legs: [
        {
          sport: 'nfl',
          eventDate: '2026-10-04',
          participants: ['Zzyzx Rockets', 'Qwerty Owls'],
          market: 'moneyline',
          selection: { kind: 'team', team: 'Zzyzx Rockets' },
          price: 150,
        },
      ],
    });
    expect(data.matching.needsAttention[0]!.status).toBe('unmatched');
  });

  it('add_bet rejects invalid input with a readable error', async () => {
    const r = await call('add_bet', {
      book: 'FanDuel',
      stake: 5,
      price: 50,
      legs: [],
    });
    expect(r.isError).toBe(true);
  });

  it('check_odds: filters, de-vigs and reports quota', async () => {
    const { data } = await call<{
      eventCount: number;
      quota: { remaining: number };
      events: {
        markets: { market: string; consensus: Record<string, number> }[];
      }[];
    }>('check_odds', { sport: 'nfl', teams_or_event: 'Rams @ Eagles' });
    expect(data.eventCount).toBe(1);
    expect(data.quota.remaining).toBe(497);
    const h2h = data.events[0]!.markets.find((m) => m.market === 'h2h')!;
    expect(h2h.consensus['Los Angeles Rams']).toBeCloseTo(0.626284, 6);
    expect(oddsUrls).toHaveLength(1);
  });

  it('check_odds: asks for confirmation above 3 requests', async () => {
    const books = Array.from({ length: 11 }, (_, i) => `book${i}`);
    const { data } = await call<{
      requiresConfirmation: boolean;
      cost: number;
    }>('check_odds', { sport: 'nfl', books });
    expect(data).toMatchObject({ requiresConfirmation: true, cost: 6 });
    expect(oddsUrls).toHaveLength(0);
    await call('check_odds', { sport: 'nfl', books, confirm: true });
    expect(oddsUrls).toHaveLength(1);
  });

  it('portfolio: totals and the SD @ MIL exposure grid', async () => {
    const { data } = await call<Portfolio>('portfolio');
    // Recording: CWS @ CLE still in the 8th, so #1/#2 are open; #6 won, #7 and #10 lost.
    expect(data.open.count).toBe(7);
    expect(data.settled).toMatchObject({
      count: 3,
      staked: 30,
      returned: 34,
      profit: 4,
    });
    const sdMil = data.exposure.find((e) => e.eventId === 'mlb:849830')!;
    expect(sdMil.outcomes.map((o) => o.key)).toEqual(['home', 'away']);
    const padres = sdMil.rows.find((r) => r.label === 'San Diego Padres ML')!;
    // Exact for a moneyline single: +$24.60 if SD wins, -$10 if MIL wins.
    expect(padres.pnl).toEqual({ home: -10, away: 24.6 });
    const parlay = sdMil.rows.find((r) => r.label === '3-leg parlay')!;
    expect(parlay.pnl.away).toBe(-10);
    expect(parlay.pnl.home).toBeGreaterThan(-10);
    expect(sdMil.net.away).toBeCloseTo(14.6, 2);
  });

  it('update_bet, settle_bet and remove_bet', async () => {
    const id = (await call<BetView[]>('list_bets', { status: 'open' })).data[0]!
      .id;
    const upd = await call<BetView>('update_bet', {
      id,
      fields: { notes: 'cashed out?', stake: 12 },
    });
    expect(upd.data).toMatchObject({ notes: 'cashed out?', stake: 12 });
    const settled = await call<BetView>('settle_bet', { id, result: 'void' });
    expect(settled.data).toMatchObject({
      status: 'void',
      now: { value: 12, ev: 0 },
    });
    expect((await call('remove_bet', { id })).data).toEqual({ removed: id });
    expect((await call('get_bet', { id })).isError).toBe(true);
  });
});

describe("Dan's NHL and WNBA parlays (FanDuel, 10/6-10/7)", () => {
  const nhl = (
    a: string,
    b: string,
    team: string,
    market: 'moneyline' | 'spread',
    price: number,
    line?: number
  ) => ({
    sport: 'nhl',
    eventDate: '2026-10-06',
    participants: [a, b],
    market,
    selection: { kind: 'team', team },
    ...(line != null ? { line } : {}),
    price,
  });

  it('3-leg NHL parlay: matched, main lines at the market, P(win) = product', async () => {
    const { data } = await call<{ bet: BetView; matching: unknown }>(
      'add_bet',
      {
        book: 'FanDuel',
        externalBetId: 'us-il:01m48tzbdsf0hap91tnjj4kvts',
        stake: 10,
        price: 1611,
        boostPct: 30,
        boostKind: 'profit_boost',
        boostedPrice: 2094,
        statedPayout: 219.45,
        legs: [
          nhl(
            'Buffalo Sabres',
            'Minnesota Wild',
            'Buffalo Sabres',
            'moneyline',
            -104
          ),
          nhl(
            'Carolina Hurricanes',
            'Montreal Canadiens',
            'Carolina Hurricanes',
            'spread',
            205,
            -1.5
          ),
          nhl(
            'New Jersey Devils',
            'Utah Mammoth',
            'New Jersey Devils',
            'spread',
            190,
            -1.5
          ),
        ],
      }
    );
    expect(data.matching).toBe('all legs matched');
    const [sabres, canes, devils] = data.bet.legs;
    expect(sabres!.side).toBe('home');
    expect(canes!.side).toBe('away');
    expect(devils!.side).toBe('home');
    // Hurricanes -1.5 is DraftKings' main puck line (+205 / MTL +1.5 -250):
    // the pregame model reproduces its fair price without an anchor.
    expect(canes!.pWin!).toBeCloseTo(0.3146, 2);
    expect(data.bet.payout).toBe(219.45);
    const product = data.bet.legs.reduce((a, l) => a * l.pWin!, 1);
    expect(data.bet.now.pWin).toBeCloseTo(product, 3);
    expect(data.bet.now.source).toBe('model');
  });

  it('2-leg WNBA parlay across two games: P(win) = product', async () => {
    const { data } = await call<{ bet: BetView; matching: unknown }>(
      'add_bet',
      {
        book: 'FanDuel',
        externalBetId: 'us-il:01m48v0ajhey58cty9vw2mpxpc',
        stake: 10,
        price: 274,
        boostPct: 25,
        boostKind: 'profit_boost',
        boostedPrice: 342,
        statedPayout: 44.29,
        legs: [
          {
            sport: 'wnba',
            eventDate: '2026-10-07',
            participants: ['New York Liberty', 'Atlanta Dream'],
            market: 'total',
            selection: { kind: 'over' },
            line: 170.5,
            price: -105,
          },
          {
            sport: 'wnba',
            eventDate: '2026-10-07',
            participants: ['Golden State Valkyries', 'Las Vegas Aces'],
            market: 'spread',
            selection: { kind: 'team', team: 'Golden State Valkyries' },
            line: -1.5,
            price: -108,
          },
        ],
      }
    );
    expect(data.matching).toBe('all legs matched');
    const [over, gsv] = data.bet.legs;
    // DraftKings: o170.5 -110/-110 -> 50%; GSV -1.5 -110/-110 -> 50%.
    expect(over!.pWin!).toBeCloseTo(0.5, 3);
    expect(gsv!.side).toBe('home');
    expect(gsv!.pWin!).toBeCloseTo(0.5, 3);
    expect(data.bet.now.pWin).toBeCloseTo(over!.pWin! * gsv!.pWin!, 3);
  });
});
