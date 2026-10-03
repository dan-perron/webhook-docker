import { describe, expect, it } from 'vitest';
import { devig } from '../src/odds/math.js';
import {
  goalRates,
  MATCH_MINUTES,
  minutesRemaining,
  soccerProbability,
  threeWay,
} from '../src/models/soccer.js';
import { poissonPmf } from '../src/models/stats.js';
import { prior, state } from './helpers/states.js';

// Expected values computed independently in Python.

const neutral = prior({
  homeWin: 0.365,
  draw: 0.27,
  awayWin: 0.365,
  expectedMargin: null,
  expectedTotal: 2.6,
});
const draw = {
  market: 'moneyline3way' as const,
  kind: 'draw' as const,
  side: null,
  line: null,
};
const soccerAt = (
  minute: number,
  period: number,
  homeScore = 0,
  awayScore = 0
) =>
  state('soccer', {
    homeScore,
    awayScore,
    situation: { kind: 'soccer', minute, period },
  });

describe('minutes remaining (90 + 2 + 5 stoppage)', () => {
  it('counts expected stoppage time', () => {
    expect(MATCH_MINUTES).toBe(97);
    expect(minutesRemaining(state('soccer', { status: 'pre' }))).toBe(97);
    // 2nd half minute 80: elapsed 47 + 35
    expect(minutesRemaining(soccerAt(80, 2))).toBe(15);
    // first-half stoppage caps at 47
    expect(minutesRemaining(soccerAt(46, 1))).toBe(51);
    expect(minutesRemaining(soccerAt(99, 2))).toBe(0.5);
  });
});

describe('goal rates from the prior', () => {
  it('neutral prior splits 2.6 evenly', () => {
    const r = goalRates(neutral);
    expect(r.home).toBeCloseTo(1.3, 6);
    expect(r.away).toBeCloseTo(1.3, 6);
  });

  it('Portugal -165 / draw +330 / Norway +330 reproduces the home share', () => {
    const { fair } = devig([-165, 330, 330]);
    expect(fair[0]).toBeCloseTo(0.5724082, 6);
    const p = prior({
      homeWin: fair[0]!,
      draw: fair[1]!,
      awayWin: fair[2]!,
      expectedTotal: 3.5,
    });
    const r = goalRates(p);
    expect(r.home + r.away).toBeCloseTo(3.5, 10);
    const w = threeWay(poissonPmf(r.home, 15), poissonPmf(r.away, 15));
    // home share of decisive results = 0.5724082 / (0.5724082 + 0.2137959)
    expect(w.home / (w.home + w.away)).toBeCloseTo(0.7280657, 6);
  });
});

describe('soccerProbability', () => {
  it('pregame neutral draw = sum of Poisson(1.3)^2', () => {
    expect(
      soccerProbability(state('soccer', { status: 'pre' }), neutral, draw).win
    ).toBeCloseTo(0.263914, 6);
  });

  it('0-0 at 80 minutes: draw = sum of Poisson(1.3 x 15/97)^2', () => {
    expect(soccerProbability(soccerAt(80, 2), neutral, draw).win).toBeCloseTo(
      0.6962479,
      6
    );
  });

  it('1-0 at 88 minutes: home holds with 7 minutes left', () => {
    const home = {
      market: 'moneyline3way' as const,
      kind: 'team' as const,
      side: 'home' as const,
      line: null,
    };
    expect(
      soccerProbability(soccerAt(88, 2, 1, 0), neutral, home).win
    ).toBeCloseTo(0.9181169, 6);
  });

  it('three outcomes sum to 1', () => {
    const s = soccerAt(60, 2, 1, 1);
    const home = soccerProbability(s, neutral, {
      ...draw,
      kind: 'team',
      side: 'home',
    }).win;
    const away = soccerProbability(s, neutral, {
      ...draw,
      kind: 'team',
      side: 'away',
    }).win;
    expect(home + away + soccerProbability(s, neutral, draw).win).toBeCloseTo(
      1,
      10
    );
  });

  it('integer totals push when no more goals come', () => {
    // 1-1 at 85': 10 minutes left; P(no goal) = exp(-2.6 x 10/97)
    const s = soccerAt(85, 2, 1, 1);
    const r = soccerProbability(s, neutral, {
      market: 'total',
      kind: 'over',
      side: null,
      line: 2,
    });
    expect(r.push).toBeCloseTo(0.764876, 6);
    expect(r.win).toBeCloseTo(1 - 0.764876, 6);
  });
});
