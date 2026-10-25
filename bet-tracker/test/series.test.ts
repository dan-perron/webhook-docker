import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { series as seriesTable } from '../src/db/schema.js';
import { betInputSchema, type BetInput } from '../src/domain/betInput.js';
import {
  parseSeries,
  seriesIdFor,
  type EspnTeamSchedule,
} from '../src/gamestate/espnSeries.js';
import { createProviders } from '../src/gamestate/registry.js';
import type { SeriesGame, SeriesState } from '../src/gamestate/types.js';
import { confirmLegMatch, matchLegs } from '../src/matching/service.js';
import {
  evaluateSeries,
  gameProbability,
  seriesJoint,
  seriesOutcome,
  seriesPmf,
  stateAsOf,
  strengthForPrice,
  strengthFromGame,
  type SeriesStrength,
} from '../src/models/series.js';
import type { ModelSelection } from '../src/models/types.js';
import { devig, devigSingle } from '../src/odds/math.js';
import { createApp } from '../src/app.js';
import type { Services } from '../src/mcp/server.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { Tracker } from '../src/tracker/tracker.js';
import { valueBetRow } from '../src/tracker/valuation.js';
import { betViewById } from '../src/tracker/views.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { scoreService } from './helpers/scores.js';
import { PARAMS } from './helpers/states.js';
import { eq } from 'drizzle-orm';

// Playoff series on the Brewers' recorded 2026 postseason schedule: NLDS
// v SD (3-1), NLCS v LAD (4-0), World Series v TB (MIL leads 1-0, Game 2
// tonight at MIL, DraftKings MIL -116 / TB +104).

const schedule = () =>
  fixture<EspnTeamSchedule>('espn/schedule-mlb-mil-post-2026.json');
const NOW = '2026-10-24T23:00:00.000Z';
const ws = () => parseSeries('mlb', schedule(), '8', '30', NOW)!;

const sel = (
  market: 'series_winner' | 'series_spread',
  side: 'home' | 'away',
  line: number | null = null
): ModelSelection => ({ market, kind: 'team', side, line });

/** Every game's own line at p (no home edge involved). */
const flat = (s: SeriesState, p: number): SeriesStrength => ({
  source: 'espn_lines',
  logit: 0,
  games: Object.fromEntries(s.games.map((g) => [g.id, p])),
  detail: 'test',
});

/** A best-of-7 with no games played yet, hosts 2-2-1-1-1. */
function fresh(wins: [number, number] = [0, 0]): SeriesState {
  const games: SeriesGame[] = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `g${n}`,
    number: n,
    startTime: `2026-10-${10 + n}T00:00:00.000Z`,
    homeTeamId: [1, 2, 5, 7].includes(n) ? 'H' : 'A',
    status: 'pre',
    cancelled: false,
    winnerTeamId: null,
    homeScore: null,
    awayScore: null,
    ifNecessary: n > 4,
    detail: '',
  }));
  let [h, a] = wins;
  for (const g of games) {
    if (h === 0 && a === 0) break;
    g.status = 'final';
    if (h > 0) {
      g.winnerTeamId = 'H';
      h--;
    } else {
      g.winnerTeamId = 'A';
      a--;
    }
  }
  return {
    seriesId: 'test',
    sport: 'mlb',
    title: 'Test Series',
    bestOf: 7,
    home: { id: 'H', name: 'Home', abbr: 'HOM', wins: wins[0] },
    away: { id: 'A', name: 'Away', abbr: 'AWY', wins: wins[1] },
    games,
    status: wins[0] + wins[1] ? 'in' : 'pre',
    winner: null,
    decidedAt: null,
    fetchedAt: NOW,
  };
}

/**
 * Independent check of the DP: enumerate every win/loss sequence of the
 * remaining games (stopping at 4 wins).
 */
function bruteForce(s: SeriesState, p: (n: number) => number) {
  const out = new Map<string, number>();
  const walk = (n: number, h: number, a: number, q: number) => {
    if (h === 4 || a === 4) {
      out.set(`${h}-${a}`, (out.get(`${h}-${a}`) ?? 0) + q);
      return;
    }
    walk(n + 1, h + 1, a, q * p(n));
    walk(n + 1, h, a + 1, q * (1 - p(n)));
  };
  walk(s.home.wins + s.away.wins + 1, s.home.wins, s.away.wins, 1);
  return out;
}

describe('series input', () => {
  const leg = (
    over: Partial<BetInput['legs'][number]> = {}
  ): BetInput['legs'][number] => ({
    sport: 'mlb',
    eventDate: '2026-10-24',
    participants: ['Milwaukee Brewers', 'Tampa Bay Rays'],
    market: 'series_spread',
    selection: { kind: 'team', team: 'Milwaukee Brewers' },
    line: -2.5,
    price: 320,
    ...over,
  });
  const issues = (l: Partial<BetInput['legs'][number]>) => {
    const r = betInputSchema.safeParse({
      book: 'FanDuel',
      stake: 10,
      price: leg(l).price,
      legs: [leg(l)],
    });
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts series_spread with a line and series_winner without', () => {
    expect(issues({})).toEqual([]);
    expect(issues({ market: 'series_winner', line: undefined })).toEqual([]);
  });

  it('rejects bad series legs', () => {
    expect(issues({ line: undefined })).toEqual([
      'series_spread needs a line (games, e.g. -2.5)',
    ]);
    expect(issues({ market: 'series_winner' })).toEqual([
      'series_winner takes no line',
    ]);
    expect(issues({ selection: { kind: 'over' } })).toEqual([
      'series_spread takes a team selection',
    ]);
    expect(issues({ sport: 'nfl' })).toEqual([
      'series markets: mlb, nba, nhl, wnba only',
    ]);
  });
});

describe('ESPN team schedule -> series', () => {
  it('the World Series: id, title, best of 7, home field, wins, hosts', () => {
    const s = ws();
    expect(s).toMatchObject({
      seriesId: 'espn:mlb:series:2026:8-30',
      title: 'World Series',
      bestOf: 7,
      home: { id: '8', name: 'Milwaukee Brewers', abbr: 'MIL', wins: 1 },
      away: { id: '30', name: 'Tampa Bay Rays', abbr: 'TB', wins: 0 },
      status: 'in',
      winner: null,
    });
    expect(s.games.map((g) => g.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 2-3-2: games 1, 2, 6, 7 in Milwaukee.
    expect(s.games.map((g) => (g.homeTeamId === '8' ? 'MIL' : 'TB'))).toEqual([
      'MIL',
      'MIL',
      'TB',
      'TB',
      'TB',
      'MIL',
      'MIL',
    ]);
    expect(s.games[0]).toMatchObject({
      id: '401908042',
      status: 'final',
      winnerTeamId: '8',
      homeScore: 3,
      awayScore: 2,
    });
    expect(s.games[4]!.ifNecessary).toBe(true);
    // The id doesn't depend on argument order.
    expect(seriesIdFor('mlb', 2026, '30', '8')).toBe(s.seriesId);
  });

  it('a finished series: NLCS sweep of LA, decided by Game 4', () => {
    const s = parseSeries('mlb', schedule(), '8', '19', NOW)!;
    expect(s).toMatchObject({
      title: 'NLCS',
      bestOf: 7,
      status: 'final',
      winner: 'home',
      home: { wins: 4 },
      away: { wins: 0 },
      decidedAt: '2026-10-16T00:00:00.000Z',
    });
  });

  it('NLDS: best of 5 from the title (only 4 games listed), 3-1', () => {
    const s = parseSeries('mlb', schedule(), '8', '25', NOW)!;
    expect(s).toMatchObject({ bestOf: 5, status: 'final', winner: 'home' });
    expect(s.home.wins + s.away.wins).toBe(4);
  });

  it('teams with no postseason games: none', () => {
    expect(parseSeries('mlb', schedule(), '8', '10', NOW)).toBeNull();
  });
});

describe('series model', () => {
  it('coin flips: P(win) 1/2; -2.5 = 4-0 or 4-1 = 1/16 + 4/32 = 0.1875', () => {
    const s = fresh();
    const pmf = seriesPmf(s, flat(s, 0.5));
    expect(seriesOutcome(pmf, sel('series_winner', 'home')).win).toBeCloseTo(
      0.5,
      12
    );
    expect(
      seriesOutcome(pmf, sel('series_spread', 'home', -2.5)).win
    ).toBeCloseTo(0.1875, 12);
    // Away +2.5 is the complement.
    expect(
      seriesOutcome(pmf, sel('series_spread', 'away', 2.5)).win
    ).toBeCloseTo(0.8125, 12);
  });

  it('p = 0.6 a game: 0.6^4 (1 + 4(.4) + 10(.16) + 20(.064)) = 0.710208', () => {
    const s = fresh();
    expect(
      seriesOutcome(seriesPmf(s, flat(s, 0.6)), sel('series_winner', 'home'))
        .win
    ).toBeCloseTo(0.710208, 9);
    // Up 1-0: 0.6^3 (1 + 3(.4) + 6(.16) + 10(.064)) = 0.8208
    const up = fresh([1, 0]);
    expect(
      seriesOutcome(seriesPmf(up, flat(up, 0.6)), sel('series_winner', 'home'))
        .win
    ).toBeCloseTo(0.8208, 9);
  });

  it('integer series spreads push on the exact margin', () => {
    // -1: a 4-3 win pushes. P(4-3) at coin flips = C(6,3)/2^7 = 20/128.
    const s = fresh();
    const o = seriesOutcome(
      seriesPmf(s, flat(s, 0.5)),
      sel('series_spread', 'home', -1)
    );
    expect(o.push).toBeCloseTo(20 / 128, 12);
    expect(o.win).toBeCloseTo(0.5 - 20 / 128, 12);
  });

  it('home edge by host: MLB strength 0 -> 0.5399 at home, 0.4601 away', () => {
    const s = fresh();
    const z: SeriesStrength = { source: 'neutral', logit: 0, detail: '' };
    // sigmoid(0.16) = 0.539915
    expect(gameProbability(s, z, 1)).toBeCloseTo(0.539915, 6);
    expect(gameProbability(s, z, 3)).toBeCloseTo(1 - 0.539915, 6);
    // The DP agrees with brute force over every sequence.
    const pmf = seriesPmf(s, z);
    const bf = bruteForce(s, (n) => gameProbability(s, z, n));
    for (const [k, p] of bf) expect(pmf.get(k)).toBeCloseTo(p, 12);
  });

  it('a game in progress uses ESPN live win probability', () => {
    const s = fresh([1, 0]);
    s.games[1]!.status = 'in';
    s.games[1]!.liveHomeWinProb = 0.8;
    const z = flat(s, 0.5);
    const pmf = seriesPmf(s, z);
    const bf = bruteForce(s, (n) => (n === 2 ? 0.8 : 0.5));
    for (const [k, p] of bf) expect(pmf.get(k)).toBeCloseTo(p, 12);
    // Game 3 hosted by the away team: its live number flips.
    const t = fresh([1, 1]);
    t.games[2]!.status = 'in';
    t.games[2]!.liveHomeWinProb = 0.7;
    const r = evaluateSeries(t, flat(t, 0.5), [sel('series_winner', 'home')]);
    expect(r[0]!.inputs).toMatchObject({
      nextGame: 3,
      nextGameHomeTeamWin: 0.3,
      live: 'ESPN win probability',
    });
  });

  it('settles from the final series score', () => {
    const s = parseSeries('mlb', schedule(), '8', '19', NOW)!;
    const r = evaluateSeries(s, flat(s, 0.5), [
      sel('series_winner', 'home'),
      sel('series_spread', 'home', -2.5),
      sel('series_spread', 'away', 1.5),
    ]);
    expect(r.map((x) => x.status)).toEqual(['won', 'won', 'lost']);
    expect(r[0]!.inputs.series).toBe('LAD 0-4 MIL');
  });

  it('joint: winner + -2.5 on the same series is just -2.5', () => {
    const s = fresh();
    const pmf = seriesPmf(s, flat(s, 0.5));
    const j = seriesJoint(pmf, [
      sel('series_winner', 'home'),
      sel('series_spread', 'home', -2.5),
    ]);
    expect(j).toHaveLength(1);
    expect(j[0]!.p).toBeCloseTo(0.1875, 12);
  });

  it('strength from a game line takes the host edge out; from a price, round trip', () => {
    const s = ws();
    // MIL -116 / TB +104 for Game 2 (at MIL): 0.522800 fair;
    // logit(0.5228) - 0.16 = -0.0688
    const [pMil] = devig([-116, 104]).fair as [number];
    expect(pMil).toBeCloseTo(0.5228, 4);
    expect(strengthFromGame(s, 2, pMil)).toBeCloseTo(
      Math.log(pMil / (1 - pMil)) - 0.16,
      12
    );
    // An entered price is reproduced by the model at that state.
    const leg = sel('series_spread', 'away', 1.5);
    const p = devigSingle(-150);
    const x = strengthForPrice(s, leg, p);
    const o = seriesOutcome(
      seriesPmf(s, { source: 'entered_odds', logit: x, detail: '' }),
      leg
    );
    expect(o.win).toBeCloseTo(p, 6);
  });

  it('the series as it stood when a bet was placed', () => {
    const s = ws();
    // Before Game 1 ended: 0-0.
    const before = stateAsOf(s, '2026-10-24T01:00:00.000Z');
    expect([before.home.wins, before.away.wins]).toEqual([0, 0]);
    expect(before.games[0]!.status).toBe('pre');
    // After it (start + 180 min): 1-0.
    const after = stateAsOf(s, '2026-10-24T03:00:00.000Z');
    expect([after.home.wins, after.away.wins]).toEqual([1, 0]);
  });
});

// --- Matching and the Tracker on the recorded schedule ----------------------------

describe('Tracker: series bets', () => {
  let db: Db;
  let clock: Date;
  let tracker: Tracker;
  let requested: string[];
  let providers: ReturnType<typeof createProviders>;
  const routes: Record<string, string> = {
    'baseball/mlb/teams?limit=1000': 'espn/teams-mlb.json',
    'baseball/mlb/teams/8/schedule': 'espn/schedule-mlb-mil-post-2026.json',
    'baseball/mlb/teams/30/schedule': 'espn/schedule-mlb-mil-post-2026.json',
    'baseball/mlb/summary?event=401908043':
      'espn/summary-mlb-401908043-pre.json',
  };

  beforeEach(() => {
    db = openDb(':memory:');
    const fake = fakeFetcher(routes);
    requested = fake.requested;
    providers = createProviders(fake.fetcher);
    clock = new Date(NOW);
    tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => clock,
    });
  });

  const bet = (
    legs: BetInput['legs'],
    over: Partial<BetInput> = {}
  ): BetInput => ({
    book: 'FanDuel',
    placedAt: '2026-10-24T18:00:00Z',
    stake: 20,
    price: legs[0]!.price,
    origin: 'recommended',
    legs,
    ...over,
  });
  const brewers = (
    over: Partial<BetInput['legs'][number]> = {}
  ): BetInput['legs'][number] => ({
    sport: 'mlb',
    eventDate: '2026-10-24',
    participants: ['Brewers', 'Rays'],
    market: 'series_spread',
    selection: { kind: 'team', team: 'Brewers' },
    line: -2.5,
    price: 320,
    ...over,
  });

  async function add(input: BetInput) {
    const b = createBet(db, input);
    await matchLegs(
      db,
      providers,
      b.legs.map((l) => l.id)
    );
    return b.bet.id;
  }

  it('matches a series leg to the series; the backed team to its side', async () => {
    const id = await add(bet([brewers()]));
    const leg = getBet(db, id)!.legs[0]!;
    expect(leg).toMatchObject({
      matchStatus: 'matched',
      eventId: null,
      seriesId: 'espn:mlb:series:2026:8-30',
      side: 'home',
    });
    const row = db.select().from(seriesTable).get()!;
    expect(row).toMatchObject({
      sport: 'mlb',
      season: 2026,
      title: 'World Series',
      bestOf: 7,
      homeName: 'Milwaukee Brewers',
      awayName: 'Tampa Bay Rays',
    });
  });

  it('teams with no series together stay unmatched (retried later)', async () => {
    const id = await add(
      bet([brewers({ participants: ['Brewers', 'Yankees'] })])
    );
    expect(getBet(db, id)!.legs[0]!.matchStatus).toBe('unmatched');
  });

  it('values the series from the Game 2 line and the 1-0 lead; placement too', async () => {
    const spread = await add(bet([brewers()]));
    const winner = await add(
      bet([
        brewers({
          market: 'series_winner',
          selection: { kind: 'team', team: 'Rays' },
          line: undefined,
          price: 150,
        }),
      ])
    );
    await tracker.tick();
    const row = db.select().from(seriesTable).get()!;
    const strength = JSON.parse(row.strengthJson!) as SeriesStrength;
    const [pMil] = devig([-116, 104]).fair as [number];
    expect(strength).toMatchObject({
      source: 'espn_lines',
      games: { '401908043': pMil },
    });
    expect(strength.logit).toBeCloseTo(Math.log(pMil / (1 - pMil)) - 0.16, 9);

    const s = JSON.parse(row.stateJson!) as SeriesState;
    // Game 2 at its own line; 3-5 at TB and 6-7 at MIL from the strength.
    const p = (n: number) =>
      n === 2
        ? pMil
        : 1 /
          (1 +
            Math.exp(-(strength.logit + ([6, 7].includes(n) ? 0.16 : -0.16))));
    const bf = bruteForce(s, p);
    // MIL -2.5 from 1-0: 4-0 or 4-1.
    const cover = (bf.get('4-0') ?? 0) + (bf.get('4-1') ?? 0);
    const l = getBet(db, spread)!.legs[0]!;
    expect(l).toMatchObject({
      status: 'open',
      model: 'series_dp',
      priorSource: 'espn_lines',
    });
    expect(l.pWin).toBeCloseTo(cover, 10);
    // Placed after Game 1: placement at the same 1-0 state.
    expect(l.pWinPlacement).toBeCloseTo(cover, 10);
    const rays = getBet(db, winner)!.legs[0]!;
    const tb = [...bf].filter(([k]) => k.endsWith('-4'));
    expect(rays.pWin).toBeCloseTo(
      tb.reduce((a, [, q]) => a + q, 0),
      10
    );

    const view = betViewById(db, getBet(db, spread)!);
    expect(view).toMatchObject({
      label: 'Brewers -2.5 games (series)',
      origin: 'recommended',
    });
    expect(view.legs[0]!.series).toMatchObject({
      id: 'espn:mlb:series:2026:8-30',
      title: 'World Series',
      summary: 'MIL leads 1-0',
      nextGame: { number: 2, host: 'Milwaukee Brewers', status: 'pre' },
    });
    // The next poll waits for Game 2 (10 min max).
    requested.length = 0;
    clock = new Date(clock.getTime() + 60_000);
    await tracker.tick();
    expect(requested.filter((u) => u.includes('schedule'))).toEqual([]);
  });

  it('the web page shows the series score and next game on the ticket', async () => {
    await add(bet([brewers()]));
    await tracker.tick();
    const services: Services = {
      db,
      providers,
      tracker,
      scores: scoreService(db, providers, tracker, { now: () => clock }),
      odds: new OddsApiClient(db, {
        apiKey: '',
        baseUrl: 'x',
        regions: 'us',
        cacheSeconds: 60,
      }),
      confirmAboveCost: 3,
    };
    const app = createApp(services, {
      appToken: 't',
      publicOrigin: 'https://djperron.com',
      now: () => clock,
    });
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app_token: 't' }).toString(),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const html = await (await app.request('/', { headers: { cookie } })).text();
    expect(html).toContain('World Series · MIL leads 1-0');
    expect(html).toContain('Game 2 at Milwaukee Brewers');
    expect(html).toContain('Brewers -2.5 games (series)');
    // A series with a game still to come is Upcoming, not Pending.
    expect(html).toContain('Upcoming (1)');
  });

  it('two legs on one series in a parlay are valued jointly', async () => {
    const id = await add(
      bet(
        [
          brewers({ market: 'series_winner', line: undefined, price: -150 }),
          brewers(),
        ],
        { price: 300 }
      )
    );
    await tracker.tick();
    const b = getBet(db, id)!;
    const joint = JSON.parse(b.bet.jointJson!);
    expect(Object.keys(joint)).toEqual(['espn:mlb:series:2026:8-30']);
    const v = valueBetRow(b.bet, b.legs);
    expect(v.now.pWinSource).toBe('model');
    // Winning by 3+ implies winning: P(parlay) = P(-2.5).
    expect(v.now.pWin).toBeCloseTo(b.legs[1]!.pWin!, 10);
  });

  it('settles when the series ends (NLCS sweep), at the deciding game', async () => {
    const id = await add(
      bet([
        brewers({
          eventDate: '2026-10-12',
          participants: ['Milwaukee Brewers', 'Los Angeles Dodgers'],
          selection: { kind: 'team', team: 'Milwaukee Brewers' },
        }),
      ])
    );
    await tracker.tick();
    const b = getBet(db, id)!;
    expect(b.legs[0]).toMatchObject({ status: 'won', model: 'settled' });
    // Game 4 started 10/16 00:00Z; MLB games run ~180 minutes.
    expect(b.bet).toMatchObject({
      status: 'won',
      settledAt: '2026-10-16T03:00:00.000Z',
    });
  });

  it('entered price as the strength when ESPN has no line yet', async () => {
    delete routes['baseball/mlb/summary?event=401908043'];
    try {
      const id = await add(bet([brewers()]));
      await tracker.tick();
      const l = getBet(db, id)!.legs[0]!;
      expect(l.priorSource).toBe('entered_odds');
      // The model reproduces the de-vigged entered price at placement.
      expect(l.pWinPlacement).toBeCloseTo(devigSingle(320), 6);
    } finally {
      routes['baseball/mlb/summary?event=401908043'] =
        'espn/summary-mlb-401908043-pre.json';
    }
  });

  it('an unsure team name comes back as a candidate; confirm links the series', async () => {
    // "Brew" is only a fuzzy match for the Brewers (not confident).
    const id = await add(
      bet([
        brewers({
          participants: ['Brew', 'Rays'],
          selection: { kind: 'team', team: 'Brew' },
        }),
      ])
    );
    const leg = getBet(db, id)!.legs[0]!;
    expect(leg).toMatchObject({
      matchStatus: 'needs_confirmation',
      seriesId: null,
    });
    const cands = JSON.parse(leg.matchCandidatesJson!);
    expect(cands.map((c: { eventId: string }) => c.eventId)).toEqual([
      'espn:mlb:series:2026:8-30',
    ]);
    expect(cands[0].label).toBe(
      'Tampa Bay Rays v Milwaukee Brewers (World Series)'
    );
    const r = confirmLegMatch(db, leg.id, 'espn:mlb:series:2026:8-30');
    expect(r).toMatchObject({
      status: 'matched',
      seriesId: 'espn:mlb:series:2026:8-30',
      side: 'home',
    });
    expect(
      db
        .select()
        .from(seriesTable)
        .where(eq(seriesTable.id, 'espn:mlb:series:2026:8-30'))
        .get()
    ).toBeTruthy();
  });
});
