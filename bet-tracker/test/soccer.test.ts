import { describe, expect, it } from 'vitest';
import { condBeat } from '../src/models/mlb.js';
import { resolvePrior } from '../src/models/prior.js';
import { outcomeFromScores } from '../src/models/scoreDist.js';
import {
  fitSoccer,
  MATCH_MINUTES,
  minutesRemaining,
  soccerScores,
  threeWay,
  type SoccerFit,
} from '../src/models/soccer.js';
import { PARAMS, state } from './helpers/states.js';

// Expected values computed independently in Python (plain Poisson when rho = 0).

const EVEN: SoccerFit = { home: 1.3, away: 1.3, rho: 0 };
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
const p = (
  s: ReturnType<typeof state>,
  f: SoccerFit,
  sel: Parameters<typeof outcomeFromScores>[1]
) => outcomeFromScores(soccerScores(s, f), sel);

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

describe('scores (rho = 0 is plain Poisson)', () => {
  it('pregame neutral draw = sum of Poisson(1.3)^2', () => {
    expect(p(state('soccer', { status: 'pre' }), EVEN, draw).win).toBeCloseTo(
      0.263914,
      6
    );
  });

  it('0-0 at 80 minutes: draw = sum of Poisson(1.3 x 15/97)^2', () => {
    expect(p(soccerAt(80, 2), EVEN, draw).win).toBeCloseTo(0.6962479, 6);
  });

  it('1-0 at 88 minutes: home holds with 7 minutes left', () => {
    const home = {
      market: 'moneyline3way' as const,
      kind: 'team' as const,
      side: 'home' as const,
      line: null,
    };
    expect(p(soccerAt(88, 2, 1, 0), EVEN, home).win).toBeCloseTo(0.9181169, 6);
  });

  it('three outcomes sum to 1', () => {
    const w = threeWay(
      soccerScores(soccerAt(60, 2, 1, 1), { ...EVEN, rho: -0.1 })
    );
    expect(w.home + w.draw + w.away).toBeCloseTo(1, 10);
  });

  it('integer totals push when no more goals come', () => {
    // 1-1 at 85': 10 minutes left; P(no goal) = exp(-2.6 x 10/97)
    const r = p(soccerAt(85, 2, 1, 1), EVEN, {
      market: 'total',
      kind: 'over',
      side: null,
      line: 2,
    });
    expect(r.push).toBeCloseTo(0.764876, 6);
    expect(r.win).toBeCloseTo(1 - 0.764876, 6);
  });

  it('negative rho adds draws (Dixon–Coles)', () => {
    const pre = state('soccer', { status: 'pre' });
    expect(p(pre, { ...EVEN, rho: -0.1 }, draw).win).toBeGreaterThan(
      p(pre, EVEN, draw).win + 0.01
    );
  });
});

describe('fitSoccer', () => {
  it('Portugal -165 / draw +330 / Norway +330, o/u 3.5 +110/-130: matches all three', () => {
    const prior = resolvePrior(
      'soccer',
      {
        espnLines: {
          homeMoneyline: -165,
          awayMoneyline: 330,
          drawMoneyline: 330,
          spreadHome: null,
          total: 3.5,
          overPrice: 110,
          underPrice: -130,
        },
      },
      PARAMS
    );
    const fit = fitSoccer(prior);
    const d = soccerScores(state('soccer', { status: 'pre' }), fit);
    const w = threeWay(d);
    expect(w.home).toBeCloseTo(prior.homeWin, 3);
    expect(w.draw).toBeCloseTo(prior.draw, 3);
    expect(condBeat(d, 3.5, 'total')).toBeCloseTo(prior.totalLine!.p, 3);
  });
});
