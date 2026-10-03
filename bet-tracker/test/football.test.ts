import { describe, expect, it } from 'vitest';
import {
  driveEp,
  fieldGoalProb,
  firstDownEp,
  footballDistribution,
  footballProbability,
} from '../src/models/football.js';
import { normalCdf } from '../src/models/stats.js';
import type { FootballSituation } from '../src/gamestate/types.js';
import { PARAMS, prior, state } from './helpers/states.js';

// Expected values below were computed independently in Python with math.erf.

const NFL = PARAMS.football.nfl;
const NCAAF = PARAMS.football.ncaaf;
const sit = (s: Partial<FootballSituation>): FootballSituation => ({
  kind: 'football',
  possession: 'home',
  down: 1,
  distance: 10,
  yardsToGoal: 75,
  text: null,
  ...s,
});

describe('expected points', () => {
  it('interpolates the 1st & 10 table', () => {
    expect(firstDownEp(20)).toBeCloseTo(4.1, 10);
    // halfway between 20 (4.1) and 30 (3.4)
    expect(firstDownEp(25)).toBeCloseTo(3.75, 10);
    // halfway between 60 (2.0) and 70 (1.6)
    expect(firstDownEp(65)).toBeCloseTo(1.8, 10);
    expect(firstDownEp(0)).toBe(6.0);
  });

  it('later downs and longer distances cost value', () => {
    // 3rd & 8 at the 25: 3.75 - 0.8 - 0.06 x 5
    expect(driveEp(sit({ down: 3, distance: 8, yardsToGoal: 25 }))).toBeCloseTo(
      2.65,
      10
    );
    expect(
      driveEp(sit({ down: 2, distance: 10, yardsToGoal: 25 }))
    ).toBeGreaterThan(driveEp(sit({ down: 3, distance: 10, yardsToGoal: 25 })));
  });

  it('4th down takes the best of punt, field goal, or going for it', () => {
    // 4th & 2 at the 20: FG 3 x 0.8 = 2.4 beats going (0.55 x EP(18) - 0.45)
    expect(driveEp(sit({ down: 4, distance: 2, yardsToGoal: 20 }))).toBeCloseTo(
      2.4,
      10
    );
    // 4th & 6 at own 29 (71 to go): punt 0.5 beats going (0.3 x 1.8 - 0.7)
    expect(driveEp(sit({ down: 4, distance: 6, yardsToGoal: 71 }))).toBeCloseTo(
      0.5,
      10
    );
    expect(fieldGoalProb(36)).toBe(0);
  });
});

describe('footballProbability (NFL, home up 7 with a quarter left, no possession)', () => {
  // mean = 7 + 3 x 0.25 = 7.75; sd = 13.5 x sqrt(0.25) = 6.75
  const s = state('nfl', {
    homeScore: 24,
    awayScore: 17,
    period: 4,
    clockSeconds: 900,
    fractionRemaining: 0.25,
  });
  const p = prior({
    expectedMargin: 3,
    homeWin: normalCdf(3 / 13.5),
    awayWin: 1 - normalCdf(3 / 13.5),
    expectedTotal: 44,
  });

  it('distribution', () => {
    const d = footballDistribution(s, p, NFL);
    expect(d.marginMean).toBeCloseTo(7.75, 10);
    expect(d.marginSd).toBeCloseTo(6.75, 10);
    expect(d.totalMean).toBeCloseTo(52, 10);
    expect(d.totalSd).toBeCloseTo(6.5, 10);
  });

  it('moneyline includes a tie going to overtime', () => {
    const r = footballProbability(
      s,
      p,
      { market: 'moneyline', kind: 'team', side: 'home', line: null },
      NFL
    );
    expect(r.win).toBeCloseTo(0.8752413, 5);
    expect(r.push).toBe(0);
  });

  it('half-point spread cannot push', () => {
    const r = footballProbability(
      s,
      p,
      { market: 'spread', kind: 'team', side: 'home', line: -7.5 },
      NFL
    );
    expect(r.win).toBeCloseTo(0.5147723, 5);
    expect(r.push).toBe(0);
  });

  it('integer spread pushes on the number', () => {
    const r = footballProbability(
      s,
      p,
      { market: 'spread', kind: 'team', side: 'away', line: 7 },
      NFL
    );
    expect(r.win).toBeCloseTo(0.4265419, 5);
    expect(r.push).toBeCloseTo(0.0586858, 5);
  });

  it('totals: over 51.5, under 52 with push', () => {
    const over = footballProbability(
      s,
      p,
      { market: 'total', kind: 'over', side: null, line: 51.5 },
      NFL
    );
    expect(over.win).toBeCloseTo(0.5306576, 5);
    const under = footballProbability(
      s,
      p,
      { market: 'total', kind: 'under', side: null, line: 52 },
      NFL
    );
    expect(under.win).toBeCloseTo(0.4693424, 5);
    expect(under.push).toBeCloseTo(0.0613153, 5);
  });
});

describe('footballProbability with possession (recorded UCF @ Houston)', () => {
  it('UCF +10.5 down 27-17 with 1:08 left, punting from own 29', () => {
    // f = 68/3600 -> floored at 0.02. Punt value 0.5 is 1.0 below an average
    // drive, so 1.0 moves toward Houston: mean = 10 + 10.5 x 0.02 + 1.0 = 11.21,
    // sd = 15 x sqrt(0.02).
    const s = state('ncaaf', {
      homeScore: 27,
      awayScore: 17,
      period: 4,
      clockSeconds: 68,
      fractionRemaining: 68 / 3600,
      situation: sit({
        possession: 'away',
        down: 4,
        distance: 6,
        yardsToGoal: 71,
      }),
    });
    const p = prior({ expectedMargin: 10.5, expectedTotal: 55 });
    const d = footballDistribution(s, p, NCAAF);
    expect(d.marginMean).toBeCloseTo(11.21, 10);
    const r = footballProbability(
      s,
      p,
      { market: 'spread', kind: 'team', side: 'away', line: 10.5 },
      NCAAF
    );
    expect(r.win).toBeCloseTo(0.3689268, 5);
  });

  it('possession near the goal line moves the margin toward the offense', () => {
    const base = { homeScore: 14, awayScore: 14, fractionRemaining: 0.1 };
    const p = prior({ expectedTotal: 44 });
    const ml = {
      market: 'moneyline' as const,
      kind: 'team' as const,
      side: 'home' as const,
      line: null,
    };
    const atGoal = footballProbability(
      state('nfl', { ...base, situation: sit({ yardsToGoal: 2 }) }),
      p,
      ml,
      NFL
    );
    const ownEnd = footballProbability(
      state('nfl', { ...base, situation: sit({ yardsToGoal: 95 }) }),
      p,
      ml,
      NFL
    );
    expect(atGoal.win).toBeGreaterThan(0.6);
    expect(ownEnd.win).toBeLessThan(0.5);
  });
});

describe('pregame', () => {
  it('reproduces the prior: home -3 NFL is Phi(3/13.5) before kickoff', () => {
    const p = prior({
      expectedMargin: 3,
      homeWin: normalCdf(3 / 13.5),
      awayWin: 1 - normalCdf(3 / 13.5),
    });
    const r = footballProbability(
      state('nfl', { status: 'pre' }),
      p,
      { market: 'spread', kind: 'team', side: 'home', line: -3 },
      NFL
    );
    // Integer line at the mean: about half the push band each way.
    expect(r.win + r.push / 2).toBeCloseTo(0.5, 2);
    expect(r.push).toBeGreaterThan(0.02);
  });
});
