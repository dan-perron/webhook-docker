import { beforeEach, describe, expect, it } from 'vitest';
import { getBet, listBets } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { events, predictionSnapshots } from '../src/db/schema.js';
import { createProviders } from '../src/gamestate/registry.js';
import { matchLegs } from '../src/matching/service.js';
import { seededRng } from '../src/models/stats.js';
import { loadSeed } from '../src/seed/load.js';
import { Tracker, type TickResult } from '../src/tracker/tracker.js';
import { valueBetRow } from '../src/tracker/valuation.js';
import { devig } from '../src/odds/math.js';
import { fakeFetcher, SEED_ROUTES } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

// Replays the recorded 10/3 afternoon: CWS 3 @ CLE 0 (top 8th), most NCAAF
// finals in, UCF @ Houston late 4th, UFC/NFL/soccer still to come.
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
  ...SEED_ROUTES,
};
const NOW = new Date('2026-10-03T19:40:00.000Z');

let db: Db;
let clock: Date;
let tracker: Tracker;
let requested: string[];

beforeEach(async () => {
  db = openDb(':memory:');
  loadSeed(db);
  const fake = fakeFetcher(ROUTES);
  requested = fake.requested;
  const providers = createProviders(fake.fetcher);
  await matchLegs(db, providers);
  clock = NOW;
  tracker = new Tracker(db, providers, {
    params: { ...PARAMS, mlb: { simulations: 4000 } },
    polling: { liveSeconds: 30, scheduledSeconds: 600 },
    now: () => clock,
    rng: seededRng(11),
  });
  requested.length = 0;
});

const betWith = (team: string) =>
  listBets(db).find((b) => b.legs.some((l) => l.selectionTeam === team))!;

describe('Tracker.tick', () => {
  it('settles finished games: Minnesota ML won, Miss State +5.5 lost, 11-leg parlay lost', async () => {
    await tracker.tick();
    expect(betWith('Minnesota').bet.status).toBe('won');
    expect(betWith('Mississippi State').bet.status).toBe('lost');
    const big = listBets(db).find((b) => b.legs.length === 11)!;
    expect(big.bet.status).toBe('lost');
    // UCF +10.5 still live in this recording.
    expect(big.legs.find((l) => l.selectionTeam === 'UCF')!.status).toBe(
      'open'
    );
    const minn = betWith('Minnesota');
    expect(valueBetRow(minn.bet, minn.legs).now).toMatchObject({
      status: 'won',
      valueCents: 3400,
      evCents: 2400,
    });
  });

  it('uses ESPN closing lines as the prior for a game already under way', async () => {
    await tracker.tick();
    const cws = betWith('Chicago White Sox').legs[0]!;
    expect(cws.priorSource).toBe('espn_lines');
    const prior = JSON.parse(cws.priorJson!);
    // DraftKings close: CLE -149 / CWS +124, total 6.5
    expect(prior.homeWin).toBeCloseTo(devig([-149, 124]).fair[0]!, 10);
    expect(prior.expectedTotal).toBe(6.5);
    expect(prior.detail).toBe('DraftKings via ESPN: ML -149/+124, o/u 6.5');
    expect(cws.model).toBe('mlb_monte_carlo');
    // Up 3-0 in the 8th: White Sox heavy favorites; the two sides sum to 1.
    const cle = betWith('Cleveland Guardians').legs[0]!;
    expect(cws.pWin!).toBeGreaterThan(0.85);
    expect(cws.pWin! + cle.pWin!).toBeCloseTo(1, 10);
  });

  it('placement: prior for pregame bets, de-vigged entered price for live bets', async () => {
    await tracker.tick();
    const cle = betWith('Cleveland Guardians').legs[0]!;
    // live +200: (1/3) / 1.045
    expect(cle.pWinPlacement).toBeCloseTo(1 / 3 / 1.045, 10);
    const cws = betWith('Chicago White Sox').legs[0]!;
    const fairCws = devig([-149, 124]).fair[1]!;
    expect(Math.abs(cws.pWinPlacement! - fairCws)).toBeLessThan(0.03);
  });

  it('schedules polls: 30 s live, 10 min pregame, none once final', async () => {
    await tracker.tick();
    const ev = (id: string) =>
      db
        .select()
        .from(events)
        .all()
        .find((e) => e.id === id)!;
    expect(ev('mlb:849829').nextPollAt).toBe('2026-10-03T19:40:30.000Z');
    expect(ev('espn:nfl:401872970').nextPollAt).toBe(
      '2026-10-03T19:50:00.000Z'
    );
    expect(ev('espn:ncaaf:401858474')).toMatchObject({
      status: 'final',
      nextPollAt: null,
    });
  });

  it('batches requests and does nothing until the next poll is due', async () => {
    await tracker.tick();
    const scoreboards = requested.filter((u) => u.includes('/scoreboard?'));
    // One per sport/league/date polled; no per-game state calls.
    expect(
      scoreboards.filter((u) => u.includes('college-football'))
    ).toHaveLength(1);
    expect(requested.filter((u) => u.includes('gamePks='))).toHaveLength(1);

    requested.length = 0;
    clock = new Date(NOW.getTime() + 10_000);
    const r = await tracker.tick();
    expect(r.polled).toEqual([]);
    expect(requested).toEqual([]);

    clock = new Date(NOW.getTime() + 31_000);
    const r2 = await tracker.tick();
    // Every live game with an open leg, including UCF @ HOU, Syracuse @ UConn
    // and Vandy @ UGA whose only bet (the 11-leg parlay) already lost.
    expect(r2.polled.sort()).toEqual([
      'espn:ncaaf:401856705',
      'espn:ncaaf:401856819',
      'espn:ncaaf:401858252',
      'mlb:849829',
    ]);
  });

  it('logs calibration snapshots for open legs, throttled to one per 5 minutes', async () => {
    await tracker.tick();
    const count = () => db.select().from(predictionSnapshots).all().length;
    const first = count();
    expect(first).toBeGreaterThan(0);
    clock = new Date(NOW.getTime() + 60_000);
    await tracker.tick();
    expect(count()).toBe(first);
    clock = new Date(NOW.getTime() + 6 * 60_000);
    await tracker.tick();
    expect(count()).toBeGreaterThan(first);
  });

  it("emits 'change' with the affected bets", async () => {
    const seen: TickResult[] = [];
    tracker.on('change', (r: TickResult) => seen.push(r));
    await tracker.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.changedBets).toContain(betWith('Minnesota').bet.id);
  });

  it('flags the same-game exposure inside bets (none in a single)', async () => {
    await tracker.tick();
    const b = getBet(db, betWith('Chicago White Sox').bet.id)!;
    expect(valueBetRow(b.bet, b.legs).now.sameGameEventIds).toEqual([]);
  });
});

describe('matching bets added while running', () => {
  it('matches bets seeded after an empty first tick on the next tick', async () => {
    // A server that started before any bets existed.
    const empty = openDb(':memory:');
    const providers = createProviders(fakeFetcher(ROUTES).fetcher);
    const t = new Tracker(empty, providers, {
      params: { ...PARAMS, mlb: { simulations: 1000 } },
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => NOW,
      rng: seededRng(2),
    });
    await t.tick();
    loadSeed(empty);
    await t.tick();
    const legs = listBets(empty).flatMap((b) => b.legs);
    expect(legs.every((l) => l.matchStatus === 'matched')).toBe(true);
    expect(
      listBets(empty).find((b) =>
        b.legs.some((l) => l.selectionTeam === 'Minnesota')
      )!.bet.status
    ).toBe('won');
  });
});
