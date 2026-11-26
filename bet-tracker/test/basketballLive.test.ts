import { describe, expect, it } from 'vitest';
import type { EventRow, LegRow } from '../src/db/schema.js';
import { parseScoreboard, type EspnScoreboard } from '../src/gamestate/espn.js';
import type { GameState } from '../src/gamestate/types.js';
import { evaluateEvent } from '../src/models/evaluate.js';
import type { ModelParams, Prior } from '../src/models/prior.js';
import type { OddsApiClient, OddsEvent } from '../src/odds/oddsApi.js';
import { LiveMarketCheck } from '../src/tracker/liveMarket.js';
import { liveMarketWarning } from '../src/tracker/views.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS, prior, state } from './helpers/states.js';

// NBA live win probability (basketball_normal with the fitted live shape:
// σ 13.26, a 0.453, b 0.543, c 18.1, k 0.41; see LiveMarginShape and
// scripts/fit_live_margin.py). With f = share of regulation left, L = lead:
//   mean = L + μ f − a f^b · c tanh(L / c)
//   sd   = (13.26 + (σ_game − 13.26) f) · f^0.41

const ML = [
  {
    market: 'moneyline' as const,
    kind: 'team' as const,
    side: 'home' as const,
    line: null,
  },
];
const winAt = (s: GameState, p: Prior, params: ModelParams = PARAMS) =>
  evaluateEvent('nba', s, p, ML, { params })[0]!;

/** The model before calibration: random walk, σ √f, f floored at 0.02. */
const RANDOM_WALK: ModelParams = {
  ...PARAMS,
  nba: { ...PARAMS.nba, live: undefined },
};

const nba = (
  fractionRemaining: number,
  homeScore: number,
  awayScore: number,
  period = 2,
  clockSeconds = 0
) =>
  state('nba', {
    homeScore,
    awayScore,
    fractionRemaining,
    period,
    clockSeconds,
    situation: { kind: 'basketball', period, clock: clockSeconds },
  });

describe('bet #159: Celtics @ Nuggets, DEN down 49-61 at the half', () => {
  // Pregame fit: DEN (home) expected margin -1.97, σ 12.55, P(DEN) 0.44.
  const p = prior({
    homeWin: 0.44,
    awayWin: 0.56,
    expectedMargin: -1.97,
    marginSigma: 12.55,
  });
  const half = nba(0.5, 49, 61);

  it('before: the random walk gave DEN ~7%', () => {
    // mean = -12 - 1.97 x 0.5 = -12.985, sd = 12.55 x sqrt(0.5) = 8.874
    // P(m >= 1) = 1 - Φ(13.485 / 8.874) = 1 - Φ(1.5196) = 0.0643
    // P(m = 0) ≈ φ(1.4633) / 8.874 = 0.0154, x OT 0.5 + (0.44 - 0.5) x 0.5 = 0.47
    // P ≈ 0.0643 + 0.0072 = 0.0715
    expect(winAt(half, p, RANDOM_WALK).outcome.win).toBeCloseTo(0.0715, 2);
  });

  it('after: ~16%, the historical rate for this state', () => {
    // reversion = -0.453 x 0.5^0.543 x 18.1 tanh(-12 / 18.1)
    //           = -0.453 x 0.68634 x 18.1 x (-0.58037) = +3.266
    // mean = -12 - 0.985 + 3.266 = -9.719
    // sd = (13.26 + (12.55 - 13.26) x 0.5) x 0.5^0.41 = 12.905 x 0.75262 = 9.7125
    // P(m >= 1) = 1 - Φ(10.219 / 9.7125) = 1 - Φ(1.0522) = 0.1464
    // P(m = 0) ≈ φ(1.0007) / 9.7125 = 0.0249, x OT 0.47 = 0.0117
    // P ≈ 0.1581. Data (NBA 2022-26, halftime, trailing team a 1-3 point
    // underdog down 10-14, n = 120): 16.7% ± 3.4%. The live market's ~20%
    // de-vigs a +370..+400 long shot proportionally, which overstates it.
    const ev = winAt(half, p);
    expect(ev.outcome.win).toBeCloseTo(0.1581, 2);
    expect(ev.outcome.win).toBeGreaterThan(0.15);
    expect(ev.outcome.win).toBeLessThan(0.19);
    expect(ev.inputs).toMatchObject({
      marginMean: -9.72,
      marginSd: 9.71,
      sigma: 12.55,
      reversion: 3.27,
      fractionRemaining: 0.5,
    });
  });
});

describe('sanity grid: trailing team in a pick-em game', () => {
  // Empirical P(trailing team wins), ESPN play-by-play 2022-23..2025-26,
  // |closing spread| <= 3, deficit ±1 (±2 at 15 and 20): see the calibration
  // table in the PR. The model must land within 0.06 of each; the random
  // walk misses the half and Q3 cells by 0.09-0.14.
  const p = prior({ homeWin: 0.5, awayWin: 0.5, expectedMargin: 0 });
  const slices: [string, number, number, number][] = [
    // name, f, period, clock
    ['Q1 end', 0.75, 1, 0],
    ['half', 0.5, 2, 0],
    ['Q3 end', 0.25, 3, 0],
    ['5:00 left', 300 / 2880, 4, 300],
    ['1:00 left', 60 / 2880, 4, 60],
  ];
  const deficits = [5, 10, 15, 20];
  const empirical: Record<string, number[]> = {
    'Q1 end': [0.393, 0.331, 0.178, 0.1],
    half: [0.39, 0.284, 0.162, 0.067],
    'Q3 end': [0.311, 0.162, 0.044, 0.032],
    '5:00 left': [0.241, 0.025, 0.01, 0],
    '1:00 left': [0.05, 0, 0, 0],
  };
  const grid = slices.map(([name, f, period, clock]) => ({
    name,
    p: deficits.map(
      (d) => winAt(nba(f, 100 - d, 100, period, clock), p).outcome.win
    ),
  }));

  it.each(slices.map(([name]) => name))('%s matches history', (name) => {
    const row = grid.find((g) => g.name === name)!;
    row.p.forEach((x, i) => {
      expect(Math.abs(x - empirical[name]![i]!)).toBeLessThan(0.06);
    });
  });

  it('falls with the deficit and with the clock', () => {
    for (const row of grid)
      for (let i = 1; i < row.p.length; i++)
        expect(row.p[i]!).toBeLessThan(row.p[i - 1]!);
    for (let d = 0; d < deficits.length; d++)
      for (let s = 1; s < grid.length; s++)
        expect(grid[s]!.p[d]!).toBeLessThanOrEqual(grid[s - 1]!.p[d]!);
  });

  it('the random walk was too sure at the half (down 10: 15% vs 28%)', () => {
    const rw = winAt(nba(0.5, 90, 100), p, RANDOM_WALK).outcome.win;
    expect(Math.abs(rw - empirical.half![1]!)).toBeGreaterThan(0.1);
  });
});

describe('basketball live edges', () => {
  it('at tip-off the live model is the pregame model', () => {
    // f = 1, L = 0: reversion 0, sd = σ_game x 1, mean = μ.
    const p = prior({
      homeWin: 0.6,
      awayWin: 0.4,
      expectedMargin: 3,
      marginSigma: 12,
    });
    const pre = winAt({ ...nba(1, 0, 0, 1, 720), status: 'pre' }, p);
    const tip = winAt(nba(1, 0, 0, 1, 720), p);
    expect(tip.outcome.win).toBeCloseTo(pre.outcome.win, 10);
    expect(pre.inputs).not.toHaveProperty('reversion');
  });

  it('a tie at 0:00 of the 4th is the overtime split', () => {
    // f = 0: the margin is a point mass at 0, all of it to OT:
    // P(home) = 0.5 + (0.6 - 0.5) x 0.5 = 0.55
    const p = prior({ homeWin: 0.6, awayWin: 0.4, expectedMargin: 2 });
    const ev = winAt(nba(0, 101, 101, 4, 0), p);
    expect(ev.outcome.win).toBeCloseTo(0.55, 6);
  });

  it('overtime keeps an OT period of spread (was read as game over)', () => {
    // Home up 2 with 2:30 left in OT, pick-em, game σ 13. f = 150/2880 = 0.05208
    // reversion = -0.453 x 0.05208^0.543 x 18.1 tanh(2/18.1)
    //           = -0.453 x 0.20099 x 1.99189 = -0.1814
    // mean = 2 - 0.1814 = 1.8186
    // sd = (13.26 - 0.26 x 0.05208) x 0.05208^0.41 = 13.2465 x 0.29775 = 3.9442
    // P(m >= 1) = Φ(1.3186 / 3.9442) = Φ(0.3343) = 0.6309
    // P(m = 0) ≈ φ(0.4611) / 3.9442 = 0.0909, x OT 0.5 = 0.0455
    // P ≈ 0.676 (before: f floored at 0.02, sd 1.84 -> ~0.85)
    const ot = nba(150 / 2880, 110, 108, 5, 150);
    const p = prior({ homeWin: 0.5, awayWin: 0.5, expectedMargin: 0 });
    expect(winAt(ot, p).outcome.win).toBeCloseTo(0.676, 2);
  });

  it('the last seconds are not floored at a minute of spread', () => {
    // Up 3 with 0:05 left: f = 5/2880 < 0.002 -> 0.002 (~6 s).
    // sd = 13.2595 x 0.002^0.41 = 13.2595 x 0.07823 = 1.0373
    // reversion = -0.453 x 0.002^0.543 x 18.1 tanh(3/18.1) = -0.0461
    // P(m >= 1) = Φ((2.954 - 0.5) / 1.0373) = Φ(2.366) = 0.9910
    // P(m = 0) ≈ φ(2.848) / 1.0373 = 0.0067, x 0.5 = 0.0033 -> P ≈ 0.994
    // (before: f floored at 0.02 = 58 s, P ≈ 0.94)
    const p = prior({ homeWin: 0.5, awayWin: 0.5, expectedMargin: 0 });
    const s = nba(5 / 2880, 100, 97, 4, 5);
    expect(winAt(s, p).outcome.win).toBeCloseTo(0.994, 2);
    expect(winAt(s, p, RANDOM_WALK).outcome.win).toBeLessThan(0.95);
  });

  it('reads the NBA overtime clock on the 48-minute scale', () => {
    const board = structuredClone(
      fixture<EspnScoreboard>('espn/nba-20261024-live.json')
    );
    const ev = board.events!.find((e) => e.id === '401909853')!;
    const c = ev.competitions[0]!;
    c.status = { ...c.status!, period: 5, clock: 150 };
    const [ot] = parseScoreboard('nba', { events: [ev] });
    // 2:30 left in OT: 150 / 2880
    expect(ot!.fractionRemaining).toBeCloseTo(150 / 2880, 10);
  });
});

describe('live market debug beside the model (get_bet)', () => {
  const start = '2026-11-19T02:00:00.000Z';
  const half = {
    ...nba(0.5, 49, 61),
    status: 'in' as const,
    startTime: start,
    home: { name: 'Denver Nuggets', abbr: 'DEN', score: 49 },
    away: { name: 'Boston Celtics', abbr: 'BOS', score: 61 },
  };
  const event = {
    id: 'espn:nba:1',
    sport: 'nba',
    league: 'nba',
    homeName: 'Denver Nuggets',
    awayName: 'Boston Celtics',
    startTime: start,
    stateJson: JSON.stringify(half),
  } as unknown as EventRow;
  const leg = {
    id: 7,
    status: 'open',
    market: 'moneyline',
    selectionKind: 'team',
    side: 'home',
    line: null,
    priorJson: JSON.stringify(
      prior({
        homeWin: 0.44,
        awayWin: 0.56,
        expectedMargin: -1.97,
        marginSigma: 12.55,
      })
    ),
  } as unknown as LegRow;
  const h2h = (book: string, den: number, bos: number) => ({
    key: book,
    title: book,
    last_update: start,
    markets: [
      {
        key: 'h2h',
        outcomes: [
          { name: 'Denver Nuggets', price: den },
          { name: 'Boston Celtics', price: bos },
        ],
      },
    ],
  });
  const odds: OddsEvent[] = [
    {
      id: 'x',
      sport_key: 'basketball_nba',
      commence_time: start,
      home_team: 'Denver Nuggets',
      away_team: 'Boston Celtics',
      bookmakers: [h2h('fanduel', 370, -500), h2h('draftkings', 400, -550)],
    } as unknown as OddsEvent,
  ];
  const fakeClient = (remaining: number) => {
    const calls: string[] = [];
    const client = {
      configured: true,
      quota: () => ({ remaining, used: null, last: null, updatedAt: null }),
      getOdds: async (req: { sportKey: string }) => {
        calls.push(req.sportKey);
        return { events: odds, cost: 1, cached: false, quota: client.quota() };
      },
    };
    return { client: client as unknown as OddsApiClient, calls };
  };
  const opts = { enabled: true, cacheSeconds: 300, quotaFloor: 40 };

  it('shows the de-vigged market beside our P(win), cached per sport', async () => {
    const { client, calls } = fakeClient(400);
    let now = Date.parse('2026-11-19T03:10:00Z');
    const check = new LiveMarketCheck(client, PARAMS, opts, () => now);
    const m = (await check.forLegs([{ leg, event }])).get(7)!;
    // FanDuel +370/-500: 0.212766 / (0.212766 + 0.833333) = 0.20339
    // DraftKings +400/-550: 0.2 / (0.2 + 0.846154) = 0.19118
    // consensus = (0.20339 + 0.19118) / 2 = 0.19728
    expect(m.marketWin).toBeCloseTo(0.1973, 4);
    expect(m.books).toBe(2);
    // Our model at this state: 0.1581 (bet #159 above).
    expect(m.modelWin).toBeCloseTo(0.1581, 2);
    expect(m.drift).toBeCloseTo(m.marketWin - m.modelWin, 4);
    expect(calls).toEqual(['basketball_nba']);

    now += 120_000; // warm: no new request
    await check.forLegs([{ leg, event }]);
    expect(calls).toHaveLength(1);
    now += 240_000; // past 300 s: one more
    await check.forLegs([{ leg, event }]);
    expect(calls).toHaveLength(2);
  });

  it('spends nothing below the quota floor or for games not in progress', async () => {
    const low = fakeClient(10);
    const a = new LiveMarketCheck(low.client, PARAMS, opts);
    expect((await a.forLegs([{ leg, event }])).get(7)).toBeNull();
    expect(low.calls).toHaveLength(0);

    const ok = fakeClient(400);
    const b = new LiveMarketCheck(ok.client, PARAMS, opts);
    const pre = {
      ...event,
      stateJson: JSON.stringify({ ...half, status: 'pre' }),
    } as EventRow;
    expect((await b.forLegs([{ leg, event: pre }])).size).toBe(0);
    expect(ok.calls).toHaveLength(0);

    const off = new LiveMarketCheck(ok.client, PARAMS, {
      ...opts,
      enabled: false,
    });
    expect((await off.forLegs([{ leg, event }])).size).toBe(0);
    expect(ok.calls).toHaveLength(0);
  });

  it('prices the backed team by name, so a wrong stored side shows as a mismatch', async () => {
    const { client } = fakeClient(400);
    const check = new LiveMarketCheck(client, PARAMS, opts);
    // A Celtics pick stored as side home (Denver): the market is Boston's
    // 1 - 0.19728 = 0.80272, the model Denver's 0.1581.
    const wrong = { ...leg, selectionTeam: 'Celtics' } as LegRow;
    const m = (await check.forLegs([{ leg: wrong, event }])).get(7)!;
    expect(m.marketWin).toBeCloseTo(0.8027, 4);
    expect(m.modelWin).toBeCloseTo(0.1581, 2);
    expect(liveMarketWarning(m)).toMatch(/likely side mismatch/);
    // The right side: no warning.
    const right = { ...leg, selectionTeam: 'Nuggets' } as LegRow;
    expect(
      liveMarketWarning((await check.forLegs([{ leg: right, event }])).get(7)!)
    ).toBeNull();
  });
});
