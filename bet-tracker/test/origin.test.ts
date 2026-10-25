import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  createBet,
  getBet,
  listBets,
  settleBet,
  updateBet,
} from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import type { BetInput } from '../src/domain/betInput.js';
import { createProviders } from '../src/gamestate/registry.js';
import { createMcpServer, type Services } from '../src/mcp/server.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { Tracker } from '../src/tracker/tracker.js';
import {
  betViews,
  portfolio,
  type BetView,
  type Portfolio,
} from '../src/tracker/views.js';
import { fakeFetcher } from './helpers/fixtures.js';
import { scoreService } from './helpers/scores.js';
import { PARAMS } from './helpers/states.js';

// Bet origin: Claude's recommended +EV picks vs Dan's own one-offs. Bets
// here stay unmatched (no fixtures), so their placement value is the
// entered price de-vigged at the default 4.5% two-way hold.

const ml = (
  team: string,
  price: number,
  over: Partial<BetInput> = {}
): BetInput => ({
  book: 'FanDuel',
  stake: 10,
  price,
  legs: [
    {
      sport: 'nba',
      eventDate: '2026-10-20',
      participants: ['Chicago Bulls', 'Detroit Pistons'],
      market: 'moneyline',
      selection: { kind: 'team', team },
      price,
    },
  ],
  ...over,
});

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('origin on bets', () => {
  it('is set on add, editable, and null when not given', () => {
    const a = createBet(
      db,
      ml('Chicago Bulls', 150, { origin: 'recommended' })
    );
    const b = createBet(db, ml('Detroit Pistons', -110, { origin: 'own' }));
    const c = createBet(db, ml('Chicago Bulls', 120));
    expect([a.bet.origin, b.bet.origin, c.bet.origin]).toEqual([
      'recommended',
      'own',
      null,
    ]);
    expect(updateBet(db, c.bet.id, { origin: 'own' })!.bet.origin).toBe('own');
    expect(updateBet(db, c.bet.id, { origin: null })!.bet.origin).toBeNull();
  });

  it('lists by origin, untagged = no origin', () => {
    createBet(db, ml('Chicago Bulls', 150, { origin: 'recommended' }));
    createBet(db, ml('Detroit Pistons', -110, { origin: 'own' }));
    createBet(db, ml('Chicago Bulls', 120));
    const ids = (o?: Parameters<typeof listBets>[2]) =>
      listBets(db, undefined, o).map((b) => b.bet.id);
    expect(ids()).toEqual([1, 2, 3]);
    expect(ids('recommended')).toEqual([1]);
    expect(ids('own')).toEqual([2]);
    expect(ids('untagged')).toEqual([3]);
    expect(betViews(db, 'open', 'own').map((v) => v.origin)).toEqual(['own']);
  });

  it('portfolio by origin: stake, P/L, ROI, EV at placement vs realized', () => {
    // Recommended: +150 won (+$15), -110 lost (-$10).
    const a = createBet(
      db,
      ml('Chicago Bulls', 150, { origin: 'recommended' })
    );
    const b = createBet(
      db,
      ml('Detroit Pistons', -110, { origin: 'recommended' })
    );
    // Own: +200 lost (-$5 on $5); one open.
    const c = createBet(
      db,
      ml('Chicago Bulls', 200, { origin: 'own', stake: 5 })
    );
    createBet(db, ml('Detroit Pistons', 130, { origin: 'own' }));
    settleBet(db, a.bet.id, 'won');
    settleBet(db, b.bet.id, 'lost');
    settleBet(db, c.bet.id, 'lost');

    const p = portfolio(db);
    const rec = p.byOrigin.find((r) => r.origin === 'recommended')!;
    // EV at placement: +150 -> p = 0.4/1.045, payout $25:
    //   0.382775 x 25 - 10 = -0.430622
    // -110 -> p = (110/210)/1.045, payout $19.09: 0.501253 x 19.09 - 10 = -0.431078
    const evA = (0.4 / 1.045) * 25 - 10;
    const evB = (110 / 210 / 1.045) * 19.09 - 10;
    expect(rec).toMatchObject({
      count: 2,
      staked: 20,
      open: { count: 0, staked: 0, ev: 0 },
      settled: {
        count: 2,
        staked: 20,
        returned: 25,
        profit: 5,
        roi: 0.25,
        withoutPlacement: 0,
      },
    });
    expect(rec.settled.evAtPlacement).toBeCloseTo(evA + evB, 2);
    expect(rec.settled.expectedRoi).toBeCloseTo((evA + evB) / 20, 3);
    expect(rec.settled.realizedVsExpected).toBeCloseTo(5 - (evA + evB), 2);
    const own = p.byOrigin.find((r) => r.origin === 'own')!;
    expect(own).toMatchObject({
      count: 2,
      staked: 15,
      open: { count: 1, staked: 10 },
      settled: { count: 1, staked: 5, profit: -5, roi: -1 },
    });
    // No untagged bets: no row.
    expect(p.byOrigin.map((r) => r.origin)).toEqual(['recommended', 'own']);

    // Filtered: totals and breakdown for one origin only.
    const f = portfolio(db, 'own');
    expect(f).toMatchObject({
      origin: 'own',
      open: { count: 1, staked: 10 },
      settled: { count: 1, staked: 5, profit: -5 },
    });
    expect(f.byOrigin.map((r) => r.origin)).toEqual(['own']);
  });
});

describe('migration: existing bets keep working, untagged', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  it('a database from before 0010 migrates; its bets get a null origin', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = path.resolve(here, '../drizzle');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mig-'));
    dirs.push(tmp);
    // The migrations as they were before this change.
    const old = path.join(tmp, 'drizzle');
    fs.cpSync(src, old, { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync(path.join(old, 'meta/_journal.json'), 'utf8')
    );
    journal.entries = journal.entries.filter(
      (e: { tag: string }) => e.tag < '0010'
    );
    fs.writeFileSync(
      path.join(old, 'meta/_journal.json'),
      JSON.stringify(journal)
    );
    const file = path.join(tmp, 'bets.sqlite');
    const sqlite = new Database(file);
    migrate(drizzle(sqlite), { migrationsFolder: old });
    sqlite
      .prepare(
        `INSERT INTO bets (book, stake_cents, bet_type, price_american, status)
         VALUES ('FanDuel', 1000, 'single', 150, 'won')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO legs (bet_id, leg_index, sport, event_date, event_label,
           participant_a, participant_b, market, selection_kind, selection_team,
           price_american, status)
         VALUES (1, 0, 'nfl', '2026-10-04', 'DET v CAR', 'Detroit Lions',
           'Carolina Panthers', 'moneyline', 'team', 'Detroit Lions', 150, 'won')`
      )
      .run();
    sqlite.close();

    const migrated = openDb(file);
    const b = getBet(migrated, 1)!;
    expect(b.bet).toMatchObject({ origin: null, status: 'won' });
    expect(b.legs[0]).toMatchObject({ seriesId: null, status: 'won' });
    expect(portfolio(migrated).byOrigin).toMatchObject([
      { origin: 'untagged', settled: { count: 1, profit: 15 } },
    ]);
    migrated.$client.close();
  });
});

// --- MCP and the web page -------------------------------------------------------

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

describe('MCP: origin', () => {
  let client: Client;
  beforeEach(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(services()).connect(a);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(b);
  });
  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    return {
      isError: !!r.isError,
      text,
      data: (r.isError ? null : JSON.parse(text)) as T,
    };
  };

  it('add_bet and update_bet set it; list_bets and portfolio filter by it', async () => {
    const added = await call<{ bet: BetView }>(
      'add_bet',
      ml('Chicago Bulls', 150, { origin: 'recommended' }) as unknown as Record<
        string,
        unknown
      >
    );
    expect(added.isError).toBe(false);
    expect(added.data.bet.origin).toBe('recommended');
    await call(
      'add_bet',
      ml('Detroit Pistons', -110) as unknown as Record<string, unknown>
    );

    const bad = await call('add_bet', {
      ...ml('Chicago Bulls', 150),
      origin: 'hunch',
    });
    expect(bad.isError).toBe(true);

    const untagged = await call<BetView[]>('list_bets', { origin: 'untagged' });
    expect(untagged.data.map((b) => b.id)).toEqual([2]);
    const upd = await call<BetView>('update_bet', {
      id: 2,
      fields: { origin: 'own' },
    });
    expect(upd.data.origin).toBe('own');
    const own = await call<BetView[]>('list_bets', { origin: 'own' });
    expect(own.data.map((b) => b.id)).toEqual([2]);

    const p = await call<Portfolio>('portfolio', { origin: 'recommended' });
    expect(p.data).toMatchObject({
      origin: 'recommended',
      open: { count: 1, staked: 10 },
    });
    expect(p.data.byOrigin.map((r) => r.origin)).toEqual(['recommended']);
  });

  it('tool schemas cover the new sports, markets, prop types and origin', async () => {
    const { tools } = await client.listTools();
    const tool = (n: string) => tools.find((t) => t.name === n)!;
    const add = JSON.stringify(tool('add_bet'));
    for (const word of [
      'nba',
      'series_spread',
      'series_winner',
      'pitcher_strikeouts',
      'pitcher_outs',
      'total_bases',
      'home_runs',
      'pra',
      'recommended',
    ])
      expect(add).toContain(word);
    expect(JSON.stringify(tool('update_bet').inputSchema)).toContain('origin');
    expect(JSON.stringify(tool('list_bets').inputSchema)).toContain('untagged');
    expect(JSON.stringify(tool('portfolio').inputSchema)).toContain('untagged');
  });
});

describe('web page: origin', () => {
  const login = async (app: ReturnType<typeof createApp>) => {
    const r = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app_token: 't' }).toString(),
    });
    return r.headers.get('set-cookie')!.split(';')[0]!;
  };

  it('shows the origin badge and filters by origin', async () => {
    createBet(
      db,
      ml('Chicago Bulls', 150, { origin: 'recommended', notes: 'rec-bet' })
    );
    createBet(
      db,
      ml('Detroit Pistons', -110, { origin: 'own', notes: 'own-bet' })
    );
    const app = createApp(services(), {
      appToken: 't',
      publicOrigin: 'https://djperron.com',
    });
    const cookie = await login(app);
    const all = await (await app.request('/', { headers: { cookie } })).text();
    expect(all).toContain(
      'class="origin-badge recommended">Recommended</span>'
    );
    expect(all).toContain('class="origin-badge own">Own</span>');
    expect(all).toContain('aria-label="Filter bets by origin"');
    expect(all).toContain('rec-bet');
    expect(all).toContain('own-bet');

    const rec = await (
      await app.request('/?origin=recommended', { headers: { cookie } })
    ).text();
    expect(rec).toContain('rec-bet');
    expect(rec).not.toContain('own-bet');
    // The live stream keeps the filter.
    expect(rec).toContain('/events?tab=open&amp;origin=recommended');

    // History: totals by origin.
    settleBet(db, 1, 'won');
    const hist = await (
      await app.request('/?tab=settled', { headers: { cookie } })
    ).text();
    expect(hist).toContain('class="origin-table"');
    // Recommended: $10 won at +150 = +$15, ROI +150%.
    expect(hist).toContain('+150.0%');
  });
});
