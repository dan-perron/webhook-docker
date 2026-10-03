import { describe, expect, it } from 'vitest';
import type { BaseballSituation } from '../src/gamestate/types.js';
import {
  basesMask,
  mlbOutcome,
  RE24,
  runRates,
  sampleHalfInningRuns,
  simulateMlb,
} from '../src/models/mlb.js';
import { seededRng } from '../src/models/stats.js';
import { prior, state } from './helpers/states.js';

const bb = (s: Partial<BaseballSituation>): BaseballSituation => ({
  kind: 'baseball',
  inning: 1,
  half: 'top',
  outs: 0,
  first: false,
  second: false,
  third: false,
  scheduledInnings: 9,
  extraInningRunner: false,
  ...s,
});
const N = 20000;
const sim = (
  s: ReturnType<typeof state>,
  p = prior({ expectedTotal: 8.8 }),
  seed = 7
) => simulateMlb(s, p, { simulations: N, rng: seededRng(seed) });
const ML = (side: 'home' | 'away') => ({
  market: 'moneyline' as const,
  kind: 'team' as const,
  side,
  line: null,
});

describe('run rates from the prior', () => {
  it('splits the total by Pythagorean share: 60% favorite, 8.8 total', () => {
    // share = 0.6^(1/1.83) / (0.6^(1/1.83) + 0.4^(1/1.83)) = 0.555166
    const r = runRates(
      prior({ homeWin: 0.6, awayWin: 0.4, expectedTotal: 8.8 })
    );
    expect(r.home).toBeCloseTo(4.88546, 5);
    expect(r.away).toBeCloseTo(3.91454, 5);
  });
});

describe('half-inning sampler', () => {
  it('matches RE24 mean and scoring probability for a fresh inning', () => {
    const rng = seededRng(1);
    let sum = 0;
    let zeros = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const r = sampleHalfInningRuns(0, 0, 1, rng);
      sum += r;
      if (r === 0) zeros++;
    }
    expect(sum / n).toBeCloseTo(0.48, 2);
    expect(zeros / n).toBeCloseTo(0.73, 2);
  });

  it('bases loaded, 0 out averages 2.29', () => {
    const rng = seededRng(2);
    let sum = 0;
    for (let i = 0; i < 100000; i++) sum += sampleHalfInningRuns(0, 7, 1, rng);
    expect(sum / 100000).toBeCloseTo(RE24[0]![7]!, 1);
  });

  it('encodes bases as a bitmask', () => {
    expect(basesMask({ first: true, second: false, third: true })).toBe(5);
  });
});

describe('simulateMlb', () => {
  it('pregame reproduces a 60% favorite within 2 points', () => {
    const r = mlbOutcome(
      sim(
        state('mlb', { status: 'pre' }),
        prior({ homeWin: 0.6, awayWin: 0.4, expectedTotal: 8.8 })
      ),
      ML('home')
    );
    expect(Math.abs(r.win - 0.6)).toBeLessThan(0.02);
  });

  it('even teams are close to 50/50 pregame and total near 8.6-8.8', () => {
    const s = sim(state('mlb', { status: 'pre' }));
    expect(Math.abs(mlbOutcome(s, ML('home')).win - 0.5)).toBeLessThan(0.025);
    // Bottom 9ths skipped and walk-offs trim a little off the 8.8.
    const mean = Array.from(s.totals).reduce((a, b) => a + b, 0) / s.n;
    expect(mean).toBeGreaterThan(8.3);
    expect(mean).toBeLessThan(8.9);
  });

  it('home ahead after the top of the 9th: game over, exactly', () => {
    // A "Middle 9th" normalizes to bottom 9th, 0 out.
    const s = sim(
      state('mlb', {
        homeScore: 4,
        awayScore: 2,
        situation: bb({ inning: 9, half: 'bottom' }),
      })
    );
    expect(mlbOutcome(s, ML('home')).win).toBe(1);
    const over = mlbOutcome(s, {
      market: 'total',
      kind: 'over',
      side: null,
      line: 5.5,
    });
    expect(over.win).toBe(1);
    const push = mlbOutcome(s, {
      market: 'total',
      kind: 'under',
      side: null,
      line: 6,
    });
    expect(push.push).toBe(1);
  });

  it('top 9th, 2 out, nobody on, home up 5: near-certain', () => {
    const s = sim(
      state('mlb', {
        homeScore: 5,
        awayScore: 0,
        situation: bb({ inning: 9, outs: 2 }),
      })
    );
    expect(mlbOutcome(s, ML('home')).win).toBeGreaterThan(0.999);
  });

  it('bottom 9th, tied, bases loaded, 0 out: 0.87 + 0.13 x ~0.52 in extras', () => {
    const s = sim(
      state('mlb', {
        homeScore: 3,
        awayScore: 3,
        situation: bb({
          inning: 9,
          half: 'bottom',
          first: true,
          second: true,
          third: true,
        }),
      })
    );
    const win = mlbOutcome(s, ML('home')).win;
    expect(win).toBeGreaterThan(0.92);
    expect(win).toBeLessThan(0.955);
    // A walk-off ends one run ahead, so the home run line -1.5 needs extras.
    const rl = mlbOutcome(s, {
      market: 'spread',
      kind: 'team',
      side: 'home',
      line: -1.5,
    }).win;
    expect(rl).toBeLessThan(0.13);
  });

  it('the regular-season extra-innings runner raises scoring in extras', () => {
    // More runs per inning, partly offset by games ending sooner: ~+0.3.
    const tied = (runner: boolean) =>
      sim(
        state('mlb', {
          homeScore: 2,
          awayScore: 2,
          situation: bb({ inning: 10, extraInningRunner: runner }),
        })
      );
    const meanTotal = (r: ReturnType<typeof sim>) =>
      Array.from(r.totals).reduce((a, b) => a + b, 0) / r.n;
    expect(meanTotal(tied(true))).toBeGreaterThan(meanTotal(tied(false)) + 0.2);
  });

  it('recorded CWS 3 @ CLE 0, top 8th, 1 out: White Sox heavy favorites', () => {
    const s = sim(
      state('mlb', {
        homeScore: 0,
        awayScore: 3,
        situation: bb({ inning: 8, outs: 1 }),
      })
    );
    const cws = mlbOutcome(s, ML('away')).win;
    expect(cws).toBeGreaterThan(0.88);
    expect(cws).toBeLessThan(0.97);
    expect(cws + mlbOutcome(s, ML('home')).win).toBeCloseTo(1, 10);
  });

  it('is deterministic for a seed', () => {
    const a = mlbOutcome(
      sim(state('mlb', { status: 'pre' }), undefined, 42),
      ML('home')
    );
    const b = mlbOutcome(
      sim(state('mlb', { status: 'pre' }), undefined, 42),
      ML('home')
    );
    expect(a).toEqual(b);
  });
});
