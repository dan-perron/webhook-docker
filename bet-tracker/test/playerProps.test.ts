import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { betInputSchema, type BetInput } from '../src/domain/betInput.js';
import {
  inningsToOuts,
  parsePlayerStats,
  type EspnSummaryStats,
} from '../src/gamestate/espn.js';
import { createProviders } from '../src/gamestate/registry.js';
import type {
  BaseballSituation,
  GameState,
  PlayerStatLine,
  PlayerStats,
} from '../src/gamestate/types.js';
import { matchLegs } from '../src/matching/service.js';
import {
  calibrateMean,
  countPmf,
  evaluateProp,
  expectedPlateAppearances,
  nbaGameMinutes,
  overUnderOutcome,
  propPregame,
  teamOutsLeft,
  type PropLeg,
} from '../src/models/props.js';
import { devig } from '../src/odds/math.js';
import { Tracker } from '../src/tracker/tracker.js';
import { betViewById, portfolio } from '../src/tracker/views.js';
import { BetCard, type Dashboard } from '../src/web/page.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { PARAMS, state } from './helpers/states.js';

// NBA and MLB over/under player props. Recorded ESPN data: Bulls @ Bucks
// 10/23 final, Heat @ Hornets 10/24 at the end of the 1st, World Series
// Game 1 (Rays @ Brewers, 10/23, MIL 3-2) final.

const summary = (f: string) =>
  parsePlayerStats(fixture<EspnSummaryStats>(f), '2026-10-24T03:00:00.000Z')!;

// --- Input -------------------------------------------------------------------

const nbaLeg = (
  over: Partial<BetInput['legs'][number]> = {}
): BetInput['legs'][number] => ({
  sport: 'nba',
  eventDate: '2026-10-23',
  participants: ['Chicago Bulls', 'Milwaukee Bucks'],
  market: 'player_prop',
  prop: { type: 'points', player: 'Norman Powell', team: 'Chicago Bulls' },
  selection: { kind: 'over' },
  line: 22.5,
  price: -115,
  ...over,
});

const single = (leg: BetInput['legs'][number], stake = 10): BetInput => ({
  book: 'FanDuel',
  stake,
  price: leg.price,
  legs: [leg],
});

describe('prop input: NBA and MLB', () => {
  const issues = (leg: Partial<BetInput['legs'][number]>) => {
    const l = nbaLeg(leg);
    const r = betInputSchema.safeParse(single(l));
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  const mlb = (over: Partial<BetInput['legs'][number]>) =>
    issues({
      sport: 'mlb',
      participants: ['Tampa Bay Rays', 'Milwaukee Brewers'],
      prop: {
        type: 'home_runs',
        player: 'Christian Yelich',
        team: 'Milwaukee Brewers',
      },
      ...over,
    });

  it('accepts every NBA prop type over/under a line', () => {
    for (const type of [
      'points',
      'rebounds',
      'assists',
      'threes',
      'pra',
    ] as const)
      expect(
        issues({
          prop: { type, player: 'Norman Powell', team: 'Chicago Bulls' },
          selection: { kind: 'under' },
        })
      ).toEqual([]);
  });

  it('to hit a HR is yes with no line, or over 0.5', () => {
    expect(mlb({ selection: { kind: 'yes' }, line: undefined })).toEqual([]);
    expect(mlb({ selection: { kind: 'over' }, line: 0.5 })).toEqual([]);
    expect(mlb({ selection: { kind: 'yes' }, line: 0.5 })).toEqual([
      'home_runs yes takes no line (it is over 0.5)',
    ]);
    expect(mlb({ selection: { kind: 'over' }, line: undefined })).toEqual([
      'home_runs needs a line',
    ]);
  });

  it('checks the sport and the selection per prop type', () => {
    expect(issues({ sport: 'wnba' })).toEqual([
      'points is for nba only (got wnba)',
    ]);
    expect(issues({ selection: { kind: 'yes' }, line: undefined })).toEqual([
      'points selections: over, under (got yes)',
    ]);
    expect(
      mlb({
        prop: {
          type: 'pitcher_strikeouts',
          player: 'Jacob Misiorowski',
          team: 'Milwaukee Brewers',
        },
        selection: { kind: 'over' },
        line: 5.5,
      })
    ).toEqual([]);
  });
});

describe('over/under prop pricing', () => {
  it('de-vigs at 7% up to +200 and 12% above', () => {
    // -115: (115/215)/1.07 = 0.499891
    expect(propPregame('points', -115).p).toBeCloseTo(115 / 215 / 1.07, 12);
    expect(propPregame('points', -115).hold).toBe(0.07);
    // To hit a HR +350: (100/450)/1.12 = 0.198413
    expect(propPregame('home_runs', 350).p).toBeCloseTo(100 / 450 / 1.12, 12);
    expect(propPregame('home_runs', 350).hold).toBe(0.12);
  });
});

// --- Distributions -----------------------------------------------------------

describe('count distributions', () => {
  it('Poisson at dispersion 1', () => {
    const p = countPmf(2, 1);
    // e^-2 = 0.135335, 2e^-2 = 0.270671
    expect(p[0]).toBeCloseTo(Math.exp(-2), 12);
    expect(p[1]).toBeCloseTo(2 * Math.exp(-2), 12);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('negative binomial above 1 (variance = dispersion x mean)', () => {
    // mean 2, dispersion 2: r = 2, q = 1/2. P0 = 2^-2 = 0.25,
    // P1 = 0.25 x 2 x 0.5 = 0.25, P2 = 0.25 x (3/2) x 0.5 = 0.1875
    const p = countPmf(2, 2);
    expect(p[0]).toBeCloseTo(0.25, 12);
    expect(p[1]).toBeCloseTo(0.25, 12);
    expect(p[2]).toBeCloseTo(0.1875, 12);
    const mean = p.reduce((a, x, k) => a + k * x, 0);
    const v = p.reduce((a, x, k) => a + (k - mean) ** 2 * x, 0);
    expect(mean).toBeCloseTo(2, 8);
    expect(v).toBeCloseTo(4, 6);
  });

  it('over/under a line, with pushes on integer lines', () => {
    const rest = countPmf(2, 1);
    // Over 1.5 from 0: 1 - 3e^-2 = 0.593994; under: 3e^-2
    expect(overUnderOutcome('over', 1.5, 0, rest).win).toBeCloseTo(
      1 - 3 * Math.exp(-2),
      12
    );
    expect(overUnderOutcome('under', 1.5, 0, rest).win).toBeCloseTo(
      3 * Math.exp(-2),
      12
    );
    // Line 2: over = 1 - 5e^-2, push = 2e^-2, under = 3e^-2
    const o = overUnderOutcome('over', 2, 0, rest);
    expect(o.win).toBeCloseTo(1 - 5 * Math.exp(-2), 12);
    expect(o.push).toBeCloseTo(2 * Math.exp(-2), 12);
    expect(overUnderOutcome('under', 2, 0, rest).win).toBeCloseTo(
      3 * Math.exp(-2),
      12
    );
    // Already over: a lock; under: dead.
    expect(overUnderOutcome('over', 1.5, 2, rest)).toEqual({ win: 1, push: 0 });
    expect(overUnderOutcome('under', 1.5, 2, rest)).toEqual({
      win: 0,
      push: 0,
    });
    // Need 1 more on a 22.5 line with 22: P(rest >= 1) = 1 - e^-2
    expect(overUnderOutcome('over', 22.5, 22, rest).win).toBeCloseTo(
      1 - Math.exp(-2),
      12
    );
  });

  it('calibrates the full-game mean to the price', () => {
    // Over 0.5 Poisson: 1 - e^-μ = p, so μ = -ln(1 - p).
    const p = 100 / 450 / 1.12;
    expect(calibrateMean(0.5, p, 1)).toBeCloseTo(-Math.log(1 - p), 8);
    // Round trip at a dispersed line.
    const mu = calibrateMean(24.5, 0.55, 2.2);
    expect(
      overUnderOutcome('over', 24.5, 0, countPmf(mu, 2.2)).win
    ).toBeCloseTo(0.55, 6);
  });
});

// --- Box scores --------------------------------------------------------------

describe('box score parsing: NBA and MLB', () => {
  it('NBA: points, boards, assists, threes, minutes, on the floor, DNP', () => {
    const s = summary('espn/summary-nba-401909848-final.json');
    expect(s.final).toBe(true);
    const line = (n: string) => s.players.find((p) => p.name === n)!;
    expect(line('Jalen Smith')).toMatchObject({
      team: 'Chicago Bulls',
      stats: {
        minutes: 24,
        points: 14,
        rebounds: 13,
        assists: 1,
        threePointFieldGoalsMade: 2,
      },
    });
    expect(line('Norman Powell').stats).toMatchObject({
      points: 25,
      threePointFieldGoalsMade: 2,
    });
    expect(line('Zach Collins')).toMatchObject({ didNotPlay: true, stats: {} });

    const live = summary('espn/summary-nba-401909853-live.json');
    expect(live.final).toBe(false);
    expect(
      live.players.find((p) => p.name === 'Giannis Antetokounmpo')
    ).toMatchObject({
      team: 'Miami Heat',
      active: true,
      stats: { minutes: 8, points: 8, rebounds: 1, assists: 1 },
    });
  });

  it('MLB: lineup spot, PAs, total bases from the plays, pitcher outs/Ks/pitches', () => {
    const s = summary('espn/summary-mlb-401908042-final.json');
    const line = (n: string) => s.players.find((p) => p.name === n)!;
    // 1-for-4 with a triple: TB = 1 + 0 + 2 x 1 + 0 = 3
    expect(line('Christian Yelich')).toMatchObject({
      team: 'Milwaukee Brewers',
      batOrder: 3,
      stats: {
        hits: 1,
        homeRuns: 0,
        doubles: 0,
        triples: 1,
        totalBases: 3,
        plateAppearances: 4,
      },
    });
    // 1-for-3, a double, a walk: TB 2, 4 PAs
    expect(line('Junior Caminero').stats).toMatchObject({
      hits: 1,
      doubles: 1,
      totalBases: 2,
      walks: 1,
      plateAppearances: 4,
    });
    // Replaced by a pinch runner: out of the lineup.
    expect(line('Jonathan Aranda').active).toBe(false);
    // 5.0 IP = 15 outs, 3 K on 78 pitches; pulled.
    expect(line('Jacob Misiorowski')).toMatchObject({
      pitchingActive: false,
      stats: { pitchingOuts: 15, pitchingStrikeouts: 3, pitches: 78 },
    });
    // The last pitcher is still in.
    expect(line('Trevor Megill').pitchingActive).toBe(true);
    // Lineups posted before first pitch carry season totals (Yandy Diaz
    // 180-for-614): no box score until the game starts.
    expect(
      parsePlayerStats(
        fixture<EspnSummaryStats>('espn/summary-mlb-401908043-lineups.json'),
        'x'
      )
    ).toBeNull();
    expect(inningsToOuts('1.2')).toBe(5);
    expect(inningsToOuts('0.1')).toBe(1);
  });
});

// --- Live models ----------------------------------------------------------------

const nbaStats = (
  line: Partial<PlayerStatLine> & { stats: PlayerStatLine['stats'] },
  final = false
): PlayerStats => ({
  final,
  players: [{ name: 'Norman Powell', team: 'Away', ...line }],
  touchdowns: [],
  fetchedAt: 'x',
});

describe('NBA props live', () => {
  const leg: PropLeg = {
    propType: 'points',
    player: 'Norman Powell',
    team: 'Away',
    side: 'away',
    kind: 'over',
    line: 22.5,
  };
  const p = propPregame('points', -115).p;
  const mu = calibrateMean(22.5, p, 2.2);
  const at = (period: number, clockSeconds: number, status = 'in' as const) =>
    state('nba', { status, period, clockSeconds });

  it('game minutes: regulation and overtime', () => {
    expect(nbaGameMinutes(at(2, 0))).toEqual({ elapsed: 24, remaining: 24 });
    expect(nbaGameMinutes(at(3, 330))).toEqual({
      elapsed: 30.5,
      remaining: 17.5,
    });
    // 2:00 left in the first OT: 48 + 3 played, 2 left.
    expect(nbaGameMinutes(at(5, 120))).toEqual({ elapsed: 51, remaining: 2 });
  });

  it('at tip-off the live value is the pregame price', () => {
    const r = evaluateProp(
      leg,
      at(1, 720),
      nbaStats({ stats: { minutes: 0, points: 0 } }),
      p
    );
    expect(r.model).toBe('prop_live');
    // rate x share x 48 = (μ/2 / 16) x (16/24) x 48 = μ
    expect(r.inputs.remainingMean).toBeCloseTo(mu, 3);
    expect(r.outcome.win).toBeCloseTo(p, 4);
  });

  it('halftime with 14 in 18 minutes: pace blended with the pregame rate', () => {
    // share = (18 + 16)/(24 + 24), rate = (14 + μ/2)/(18 + 16):
    // still to come = (14 + μ/2) x 24/48 = 7 + μ/4
    const r = evaluateProp(
      leg,
      at(2, 0),
      nbaStats({ stats: { minutes: 18, points: 14 } }),
      p
    );
    const rest = 7 + mu / 4;
    expect(r.inputs.remainingMean).toBeCloseTo(rest, 3);
    expect(r.outcome.win).toBeCloseTo(
      overUnderOutcome('over', 22.5, 14, countPmf(rest, 2.2)).win,
      10
    );
    expect(r.outcome.win).toBeGreaterThan(p);
    // The under on the same state is the complement (half line).
    const u = evaluateProp(
      { ...leg, kind: 'under' },
      at(2, 0),
      nbaStats({ stats: { minutes: 18, points: 14 } }),
      1 - p
    );
    expect(u.outcome.win).toBeCloseTo(1 - r.outcome.win, 10);
  });

  it('ejected: the stat is final', () => {
    const r = evaluateProp(
      leg,
      at(3, 300),
      nbaStats({ ejected: true, stats: { minutes: 20, points: 21 } }),
      p
    );
    expect(r.outcome).toEqual({ win: 0, push: 0 });
    expect(r.inputs.note).toBe('out of the game: stat is final');
  });

  it('PRA sums points, rebounds and assists', () => {
    const r = evaluateProp(
      { ...leg, propType: 'pra', line: 30.5 },
      state('nba', { status: 'final', fractionRemaining: 0 }),
      nbaStats(
        { stats: { minutes: 33, points: 25, rebounds: 4, assists: 1 } },
        true
      ),
      0.5
    );
    expect(r).toMatchObject({ status: 'lost', inputs: { 'pts+reb+ast': 30 } });
  });

  it('settles from the final box score; DNP and missing need a hand settle', () => {
    const fin = state('nba', { status: 'final', fractionRemaining: 0 });
    const won = evaluateProp(
      leg,
      fin,
      nbaStats({ stats: { minutes: 33, points: 25 } }, true),
      p
    );
    expect(won).toMatchObject({ status: 'won', model: 'settled' });
    const push = evaluateProp(
      { ...leg, line: 25 },
      fin,
      nbaStats({ stats: { minutes: 33, points: 25 } }, true),
      p
    );
    expect(push.status).toBe('push');
    const dnp = evaluateProp(
      leg,
      fin,
      nbaStats({ didNotPlay: true, stats: {} }, true),
      p
    );
    expect(dnp).toMatchObject({ status: 'open', model: 'prop_unverified' });
    expect(dnp.inputs.note).toMatch(/did not play/);
    expect(
      evaluateProp(
        { ...leg, player: 'Nobody' },
        fin,
        nbaStats({ stats: {} }, true),
        p
      ).model
    ).toBe('prop_unverified');
  });
});

const baseball = (
  over: Partial<BaseballSituation>,
  status: 'in' | 'final' = 'in'
): GameState =>
  state('mlb', {
    status,
    situation: {
      kind: 'baseball',
      inning: 1,
      half: 'top',
      outs: 0,
      first: false,
      second: false,
      third: false,
      scheduledInnings: 9,
      extraInningRunner: false,
      ...over,
    },
  });

describe('MLB: plate appearances and outs left', () => {
  it('team outs left by inning, half and side', () => {
    // Top 7th, 1 out: away has 2 + 2 x 3 = 8; home bats in 7, 8, 9 = 9.
    expect(teamOutsLeft(baseball({ inning: 7, outs: 1 }), 'away')).toBe(8);
    expect(teamOutsLeft(baseball({ inning: 7, outs: 1 }), 'home')).toBe(9);
    // Bottom 9th, 2 outs: home has 1, away none.
    const b9 = baseball({ inning: 9, half: 'bottom', outs: 2 });
    expect(teamOutsLeft(b9, 'home')).toBe(1);
    expect(teamOutsLeft(b9, 'away')).toBe(0);
  });

  it('expected PAs: Σ_n P(T > d + 9n), T = outs + NegBin(outs, 0.7)', () => {
    // One inning (3 outs): F ~ NegBin(3, 0.7), P(F = f) = C(f+2, 2) .343 .3^f
    // Leadoff: 1 + P(F > 6) = 1 + 0.004291 = 1.004291
    expect(expectedPlateAppearances(3, 0, 0.7)).toBeCloseTo(1.004291, 5);
    // 4th up: P(F >= 1) = 1 - .343 = .657 (+ P(F > 9) ~ 0.0002)
    expect(expectedPlateAppearances(3, 3, 0.7)).toBeCloseTo(0.6572, 3);
    // 5th up: P(F >= 2) = 1 - .343 - .3087 = .3483
    expect(expectedPlateAppearances(3, 4, 0.7)).toBeCloseTo(0.3484, 3);
    expect(expectedPlateAppearances(0, 0, 0.7)).toBe(0);
    // A full game: ~4.6 for the leadoff man, ~3.8 for the 9th.
    const lead = expectedPlateAppearances(27, 0, 0.7);
    const ninth = expectedPlateAppearances(27, 8, 0.7);
    expect(lead).toBeGreaterThan(4.4);
    expect(lead).toBeLessThan(4.8);
    expect(ninth).toBeGreaterThan(3.6);
    expect(ninth).toBeLessThan(4);
  });
});

describe('MLB props live', () => {
  const batterStats = (
    over: Partial<PlayerStatLine['stats']> = {},
    extra: Partial<PlayerStatLine> = {},
    teamPa = 0
  ): PlayerStats => ({
    final: false,
    players: [
      {
        name: 'Christian Yelich',
        team: 'Away',
        batOrder: 3,
        active: true,
        ...extra,
        stats: {
          hits: 0,
          homeRuns: 0,
          totalBases: 0,
          plateAppearances: 0,
          ...over,
        },
      },
      // The rest of the lineup's PAs set who is due up.
      {
        name: 'Teammate',
        team: 'Away',
        batOrder: 1,
        stats: { plateAppearances: teamPa },
      },
    ],
    touchdowns: [],
    fetchedAt: 'x',
  });
  const hr: PropLeg = {
    propType: 'home_runs',
    player: 'Christian Yelich',
    team: 'Away',
    side: 'away',
    kind: 'yes',
    line: null,
  };
  const p = propPregame('home_runs', 350).p;
  const mu = -Math.log(1 - p);

  it('to hit a HR, due up leading off the 9th: rate per PA x expected PAs', () => {
    // Top 9th, 0 out, he is next (team PAs 2: spots 1-2 done, 3 due).
    const r = evaluateProp(
      hr,
      baseball({ inning: 9, half: 'top', outs: 0 }),
      batterStats({ plateAppearances: 0 }, {}, 2),
      p
    );
    const rate = mu / expectedPlateAppearances(27, 2, 0.7);
    const rest = rate * expectedPlateAppearances(3, 0, 0.7);
    expect(r.inputs).toMatchObject({ lineupSpot: 3, teamOutsLeft: 3 });
    expect(r.inputs.remainingMean).toBeCloseTo(rest, 3);
    // Poisson: P(at least one) = 1 - e^-rest
    expect(r.outcome.win).toBeCloseTo(1 - Math.exp(-rest), 10);
  });

  it('a HR already: a lock; replaced in the lineup without one: dead', () => {
    const live = baseball({ inning: 6, half: 'bottom', outs: 1 });
    expect(
      evaluateProp(hr, live, batterStats({ homeRuns: 1, hits: 1 }), p).outcome
    ).toEqual({ win: 1, push: 0 });
    const out = evaluateProp(hr, live, batterStats({}, { active: false }), p);
    expect(out.outcome).toEqual({ win: 0, push: 0 });
    expect(out.inputs.removed).toBe('yes');
  });

  it('pitcher strikeouts: pace-blended rate x outs left in his pitch budget', () => {
    const leg: PropLeg = {
      propType: 'pitcher_strikeouts',
      player: 'Jacob Misiorowski',
      team: 'Home',
      side: 'home',
      kind: 'over',
      line: 5.5,
    };
    const pk = propPregame('pitcher_strikeouts', -120).p;
    const muK = calibrateMean(5.5, pk, 1);
    const stats: PlayerStats = {
      final: false,
      players: [
        {
          name: 'Jacob Misiorowski',
          team: 'Home',
          pitchingActive: true,
          stats: { pitchingOuts: 12, pitchingStrikeouts: 5, pitches: 60 },
        },
      ],
      touchdowns: [],
      fetchedAt: 'x',
    };
    // Top 5th, 0 out: budget 90 pitches, 5.6/out: (90 - 60)/5.6 = 5.357 outs
    // (his defense has 15 left). Full-game outs 90/5.6 = 16.071;
    // rate = (5 + μ/2)/(12 + 16.071/2); still to come = rate x 5.357.
    const r = evaluateProp(
      leg,
      baseball({ inning: 5, half: 'top' }),
      stats,
      pk
    );
    const outsLeft = 30 / 5.6;
    const rate = (5 + muK / 2) / (12 + 90 / 5.6 / 2);
    expect(r.inputs.expectedOutsLeft).toBeCloseTo(outsLeft, 3);
    expect(r.inputs.remainingMean).toBeCloseTo(rate * outsLeft, 3);
    expect(r.outcome.win).toBeCloseTo(
      overUnderOutcome('over', 5.5, 5, countPmf(rate * outsLeft, 1)).win,
      3
    );
    // Pulled at 5: the under is a lock.
    stats.players[0]!.pitchingActive = false;
    const pulled = evaluateProp(
      { ...leg, kind: 'under' },
      baseball({ inning: 6, half: 'top' }),
      stats,
      1 - pk
    );
    expect(pulled.outcome).toEqual({ win: 1, push: 0 });
    expect(pulled.inputs).toMatchObject({
      pulled: 'yes',
      note: 'out of the game: stat is final',
    });
  });

  it('pitcher outs: the budget comes from the outs line', () => {
    const leg: PropLeg = {
      propType: 'pitcher_outs',
      player: 'Jacob Misiorowski',
      team: 'Home',
      side: 'home',
      kind: 'over',
      line: 17.5,
    };
    const po = propPregame('pitcher_outs', -120).p;
    const muO = calibrateMean(17.5, po, 1);
    const stats: PlayerStats = {
      final: false,
      players: [
        {
          name: 'Jacob Misiorowski',
          team: 'Home',
          pitchingActive: true,
          stats: { pitchingOuts: 15, pitchingStrikeouts: 3, pitches: 80 },
        },
      ],
      touchdowns: [],
      fetchedAt: 'x',
    };
    // Budget μ x 5.6 pitches; outs left = (μ x 5.6 - 80)/5.6 = μ - 14.286
    const r = evaluateProp(
      leg,
      baseball({ inning: 6, half: 'top' }),
      stats,
      po
    );
    expect(r.inputs.expectedOutsLeft).toBeCloseTo(muO - 80 / 5.6, 3);
  });

  it('settles total bases from the final box score', () => {
    const s = summary('espn/summary-mlb-401908042-final.json');
    const tb = (line: number, kind: 'over' | 'under') =>
      evaluateProp(
        {
          propType: 'total_bases',
          player: 'Christian Yelich',
          team: 'Milwaukee Brewers',
          side: 'home',
          kind,
          line,
        },
        baseball({}, 'final'),
        s,
        0.5
      );
    expect(tb(1.5, 'over')).toMatchObject({
      status: 'won',
      inputs: { 'total bases': 3 },
    });
    expect(tb(3, 'under').status).toBe('push');
    // Not in the box score: by hand.
    expect(
      evaluateProp(
        { ...hr, player: 'Nobody Atall', team: 'Milwaukee Brewers' },
        baseball({}, 'final'),
        s,
        p
      ).model
    ).toBe('prop_unverified');
  });
});

// --- Tracker on recorded games ---------------------------------------------------

describe('Tracker: NBA and MLB props', () => {
  let db: Db;
  let clock: Date;
  let routes: Record<string, string>;
  let tracker: Tracker;
  let providers: ReturnType<typeof createProviders>;

  beforeEach(() => {
    db = openDb(':memory:');
    routes = {};
    const fake = fakeFetcher(routes);
    providers = createProviders(fake.fetcher);
    tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => clock,
    });
  });

  const dashboard = (): Dashboard => ({
    tab: 'open',
    portfolio: portfolio(db),
    bets: [],
    counts: { open: 0, settled: 0 },
    quota: { remaining: null, used: null, last: null, updatedAt: null },
    updatedAt: null,
    timeZone: 'America/Chicago',
    now: clock,
    days: [],
    today: null,
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

  it('NBA final: Powell over 22.5 points won, Smith under 9.5 rebounds lost', async () => {
    Object.assign(routes, {
      'basketball/nba/scoreboard?dates=20261023':
        'espn/nba-20261023-final.json',
      'basketball/nba/summary?event=401909848':
        'espn/summary-nba-401909848-final.json',
    });
    clock = new Date('2026-10-24T03:00:00.000Z');
    const powell = await add(single(nbaLeg()));
    const smith = await add(
      single(
        nbaLeg({
          prop: {
            type: 'rebounds',
            player: 'Jalen Smith',
            team: 'Chicago Bulls',
          },
          selection: { kind: 'under' },
          line: 9.5,
          price: 105,
        })
      )
    );
    expect(getBet(db, powell)!.legs[0]).toMatchObject({
      eventId: 'espn:nba:401909848',
      side: 'away',
    });
    await tracker.tick();
    expect(getBet(db, powell)!.bet.status).toBe('won');
    expect(getBet(db, smith)!.bet.status).toBe('lost');
    const v = betViewById(db, getBet(db, powell)!);
    expect(v.label).toBe('Norman Powell Over 22.5 points');
    expect(v.legs[0]!.modelInputs).toMatchObject({ points: 25, line: 22.5 });
  });

  it('NBA game markets: pregame ML from DraftKings lines, then settled at the final', async () => {
    Object.assign(routes, {
      'basketball/nba/scoreboard?dates=20261024': 'espn/nba-20261024-live.json',
      'basketball/nba/summary?event=401909857':
        'espn/summary-nba-401909857-pre.json',
      'basketball/nba/scoreboard?dates=20261023':
        'espn/nba-20261023-final.json',
    });
    clock = new Date('2026-10-24T22:40:00.000Z');
    const bulls = await add({
      book: 'FanDuel',
      stake: 10,
      price: -125,
      legs: [
        {
          sport: 'nba',
          eventDate: '2026-10-24',
          participants: ['Washington Wizards', 'Chicago Bulls'],
          market: 'moneyline',
          selection: { kind: 'team', team: 'Chicago Bulls' },
          price: -125,
        },
      ],
    });
    const bucks = await add({
      book: 'FanDuel',
      stake: 10,
      price: -110,
      legs: [
        {
          sport: 'nba',
          eventDate: '2026-10-23',
          participants: ['Chicago Bulls', 'Milwaukee Bucks'],
          market: 'spread',
          selection: { kind: 'team', team: 'Milwaukee Bucks' },
          line: -4.5,
          price: -110,
        },
      ],
    });
    await tracker.tick();
    const l = getBet(db, bulls)!.legs[0]!;
    // DraftKings CHI -125 / WSH +105, de-vigged; the fitted model holds it.
    const [pChi] = devig([-125, 105]).fair as [number];
    expect(l).toMatchObject({
      eventId: 'espn:nba:401909857',
      side: 'home',
      model: 'basketball_normal',
      priorSource: 'espn_lines',
    });
    expect(l.pWin).toBeCloseTo(pChi, 2);
    // Bulls won at Milwaukee: the Bucks -4.5 lost.
    expect(getBet(db, bucks)!.bet.status).toBe('lost');
    expect(getBet(db, bucks)!.legs[0]!.model).toBe('settled');
  });

  it('NBA live: Giannis over 25.5 points after one quarter, from the box score', async () => {
    Object.assign(routes, {
      'basketball/nba/scoreboard?dates=20261024': 'espn/nba-20261024-live.json',
      'basketball/nba/summary?event=401909853':
        'espn/summary-nba-401909853-live.json',
    });
    clock = new Date('2026-10-24T22:40:00.000Z');
    const id = await add(
      single(
        nbaLeg({
          eventDate: '2026-10-24',
          participants: ['Miami Heat', 'Charlotte Hornets'],
          prop: {
            type: 'points',
            player: 'Giannis Antetokounmpo',
            team: 'Miami Heat',
          },
          line: 25.5,
          price: -110,
        })
      )
    );
    await tracker.tick();
    const l = getBet(db, id)!.legs[0]!;
    expect(l.model).toBe('prop_live');
    const inputs = JSON.parse(l.modelInputsJson!);
    // End of the 1st: 12 played, 36 left; 8 in 8 minutes.
    // still to come = (8 + μ/2) x 36/(12 + 24) = 8 + μ/2
    const mu = calibrateMean(25.5, propPregame('points', -110).p, 2.2);
    expect(inputs).toMatchObject({
      points: 8,
      minutes: 8,
      gameMinutesLeft: 36,
    });
    expect(inputs.remainingMean).toBeCloseTo(8 + mu / 2, 2);
    // Placement is still the pregame price.
    expect(l.pWinPlacement).toBeCloseTo(propPregame('points', -110).p, 12);
    const v = betViewById(db, getBet(db, id)!);
    expect(v.legs[0]!.prop).toMatchObject({
      player: 'Giannis Antetokounmpo',
      stat: { name: 'points', value: 8 },
    });
    expect(
      (await BetCard({ b: v, d: dashboard() }).toString()) as string
    ).toContain('Giannis Antetokounmpo: 8 points');
  });

  it('MLB final (Stats API event, ESPN box score): TB, HR and K props settle', async () => {
    Object.assign(routes, {
      'statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-23':
        'mlb/schedule-20261023.json',
      'gamePks=849805': 'mlb/schedule-ws1-final.json',
      'baseball/mlb/scoreboard?dates=20261023': 'espn/mlb-20261023-final.json',
      'baseball/mlb/summary?event=401908042':
        'espn/summary-mlb-401908042-final.json',
    });
    clock = new Date('2026-10-24T04:00:00.000Z');
    const leg = (
      type: 'total_bases' | 'home_runs' | 'pitcher_strikeouts',
      player: string,
      team: string,
      kind: 'over' | 'under' | 'yes',
      line: number | undefined,
      price: number
    ): BetInput['legs'][number] => ({
      sport: 'mlb',
      eventDate: '2026-10-23',
      participants: ['Tampa Bay Rays', 'Milwaukee Brewers'],
      market: 'player_prop',
      prop: { type, player, team },
      selection: { kind },
      line,
      price,
    });
    const tb = await add(
      single(
        leg(
          'total_bases',
          'Christian Yelich',
          'Milwaukee Brewers',
          'over',
          1.5,
          120
        )
      )
    );
    const homer = await add(
      single(
        leg(
          'home_runs',
          'Junior Caminero',
          'Tampa Bay Rays',
          'yes',
          undefined,
          380
        )
      )
    );
    const ks = await add(
      single(
        leg(
          'pitcher_strikeouts',
          'Jacob Misiorowski',
          'Milwaukee Brewers',
          'over',
          6.5,
          -105
        )
      )
    );
    expect(getBet(db, tb)!.legs[0]!.eventId).toBe('mlb:849805');
    await tracker.tick();
    expect(getBet(db, tb)!.bet.status).toBe('won');
    expect(getBet(db, homer)!.bet.status).toBe('lost');
    expect(getBet(db, ks)!.bet.status).toBe('lost');
    expect(betViewById(db, getBet(db, homer)!).label).toBe(
      'Junior Caminero to hit a HR'
    );
  });
});
