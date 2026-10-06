import { describe, expect, it } from 'vitest';
import type { BaseballSituation } from '../src/gamestate/types.js';
import { parseEvents } from '../src/gamestate/espn.js';
import {
  basesMask,
  condBeat,
  fitMlb,
  halfInningPmf,
  homeWinProb,
  mlbScores,
  RE24,
  runRates,
  type MlbFit,
} from '../src/models/mlb.js';
import { resolvePrior } from '../src/models/prior.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS, prior, state } from './helpers/states.js';

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
// total 8.64, even split -> each team scores exactly league average (scale 1).
const EVEN: MlbFit = { total: 8.64, share: 0.5, dispersion: 1 };
const mean = (pmf: number[]) => pmf.reduce((a, p, r) => a + p * r, 0);

describe('half-inning distribution', () => {
  it('fresh inning at league average: mean 0.48, P(0) = 0.73', () => {
    const pmf = halfInningPmf(0, 0, 1);
    expect(mean(pmf)).toBeCloseTo(0.48, 9);
    expect(pmf[0]).toBeCloseTo(0.73, 12);
    expect(pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('bases loaded, 0 out averages RE24 = 2.29', () => {
    expect(mean(halfInningPmf(0, 7, 1))).toBeCloseTo(RE24[0]![7]!, 9);
  });

  it('dispersion changes how often an inning scores, not the mean', () => {
    const tight = halfInningPmf(0, 0, 1, 0.7);
    expect(mean(tight)).toBeCloseTo(0.48, 9);
    // P(score) 0.27 x 0.7
    expect(tight[0]).toBeCloseTo(1 - 0.189, 12);
  });

  it('encodes bases as a bitmask', () => {
    expect(basesMask({ first: true, second: false, third: true })).toBe(5);
  });
});

describe('exact final-score distribution', () => {
  it('is a proper distribution', () => {
    expect(
      mlbScores(state('mlb', { status: 'pre' }), EVEN).total()
    ).toBeCloseTo(1, 9);
  });

  it('home ahead after the top of the 9th: game over, exactly', () => {
    const d = mlbScores(
      state('mlb', {
        homeScore: 4,
        awayScore: 2,
        situation: bb({ inning: 9, half: 'bottom' }),
      }),
      EVEN
    );
    expect(homeWinProb(d)).toBe(1);
    expect(d.get(4, 2)).toBeCloseTo(1, 12);
  });

  it('bottom 9th, home down 1, 2 out, bases empty: ends 3-2 with P(no run) = 0.93', () => {
    // No run ends it right there; any run ties or walks off. P_SCORE[2 outs][empty] = 0.07.
    const d = mlbScores(
      state('mlb', {
        homeScore: 2,
        awayScore: 3,
        situation: bb({ inning: 9, half: 'bottom', outs: 2 }),
      }),
      EVEN
    );
    expect(d.get(2, 3)).toBeCloseTo(0.93, 9);
    expect(1 - homeWinProb(d)).toBeGreaterThan(0.93);
  });

  it('top 9th, 2 out, nobody on, home up 5: near-certain', () => {
    const d = mlbScores(
      state('mlb', {
        homeScore: 5,
        awayScore: 0,
        situation: bb({ inning: 9, outs: 2 }),
      }),
      EVEN
    );
    expect(homeWinProb(d)).toBeGreaterThan(0.999);
  });

  it('bottom 9th, tied, bases loaded, 0 out: 0.87 + 0.13 x extras', () => {
    const d = mlbScores(
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
      }),
      EVEN
    );
    expect(homeWinProb(d)).toBeGreaterThan(0.92);
    expect(homeWinProb(d)).toBeLessThan(0.955);
    // A walk-off ends one run ahead, so home -1.5 needs extras.
    expect(condBeat(d, 1.5, 'margin')).toBeLessThan(0.13);
  });

  it('the regular-season extra-innings runner raises scoring in extras', () => {
    const tied = (runner: boolean) =>
      mlbScores(
        state('mlb', {
          homeScore: 2,
          awayScore: 2,
          situation: bb({ inning: 10, extraInningRunner: runner }),
        }),
        EVEN
      );
    const meanTotal = (d: ReturnType<typeof tied>) =>
      [...d.cells()].reduce((a, [h, a2, p]) => a + (h + a2) * p, 0);
    expect(meanTotal(tied(true))).toBeGreaterThan(meanTotal(tied(false)) + 0.2);
  });

  it('recorded CWS 3 @ CLE 0, top 8th, 1 out: White Sox heavy favorites', () => {
    const d = mlbScores(
      state('mlb', {
        homeScore: 0,
        awayScore: 3,
        situation: bb({ inning: 8, outs: 1 }),
      }),
      EVEN
    );
    const cws = 1 - homeWinProb(d);
    expect(cws).toBeGreaterThan(0.88);
    expect(cws).toBeLessThan(0.97);
  });

  it('home share and total set each side’s run rate', () => {
    const r = runRates({ total: 8.8, share: 0.55, dispersion: 1 });
    expect(r.home).toBeCloseTo(4.84, 12);
    expect(r.away).toBeCloseTo(3.96, 12);
  });
});

describe('fitMlb (bet #18 game: CLE @ CWS, 10/7, DraftKings via ESPN)', () => {
  // ML CWS -121 / CLE +101, run line CWS +1.5 -206 / CLE -1.5 +169, o/u 7.5 -119/-101
  const ev = parseEvents(
    'mlb',
    'mlb',
    fixture('espn/mlb-20261007-pre.json')
  ).find((e) => e.home.name.includes('White Sox'))!;
  const p = resolvePrior('mlb', { espnLines: ev.pregameLines }, PARAMS);

  it('reads the run line and total prices', () => {
    expect(ev.pregameLines).toMatchObject({
      spreadHome: 1.5,
      spreadHomePrice: -206,
      spreadAwayPrice: 169,
      total: 7.5,
      overPrice: -119,
      underPrice: -101,
    });
  });

  it('matches moneyline, run line and total together', () => {
    const fit = fitMlb(p);
    const d = mlbScores(state('mlb', { status: 'pre' }), fit);
    expect(homeWinProb(d)).toBeCloseTo(p.homeWin, 3);
    expect(condBeat(d, -p.spread!.line, 'margin')).toBeCloseTo(p.spread!.p, 3);
    expect(condBeat(d, p.totalLine!.line, 'total')).toBeCloseTo(
      p.totalLine!.p,
      3
    );
    // The alternate line White Sox -1.5 moves from the old ~30% toward the market.
    const alt = condBeat(d, 1.5, 'margin');
    expect(alt).toBeGreaterThan(0.31);
    expect(alt).toBeLessThan(0.34);
  });

  it('without a run-line price, dispersion stays 1', () => {
    const noRl = {
      ...prior({ homeWin: 0.6, awayWin: 0.4, expectedTotal: 8.5 }),
      totalLine: { line: 8.5, p: 0.5 },
    };
    expect(fitMlb(noRl).dispersion).toBe(1);
  });
});
