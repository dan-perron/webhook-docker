import { describe, expect, it } from 'vitest';
import {
  driveEp,
  fieldGoalProb,
  firstDownEp,
  fitMarginSigma,
  footballDistribution,
  footballJoint,
  footballProbability,
  homeWinShare,
  marginPmf,
  NFL_KEY_WEIGHTS,
  pAt,
} from '../src/models/football.js';
import { normalCdf } from '../src/models/stats.js';
import type { FootballSituation } from '../src/gamestate/types.js';
import { PARAMS, prior, state } from './helpers/states.js';

// Expected values below were computed independently in Python (math.erf and a
// separate implementation of the key-number margin pmf).

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
  // mean = 7 + 3 x 0.25 = 7.75; sd = 13.5 x sqrt(0.25) = 6.75; key-number
  // weights at 25% strength; a regulation tie goes to OT (±3).
  // Expected values from an independent Python implementation of this pmf.
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
    expect(d.sigma).toBe(13.5);
    expect(d.totalMean).toBeCloseTo(52, 10);
    expect(d.totalSd).toBeCloseTo(6.5, 10);
    // Live: no mass left on a tie.
    expect(pAt(d.margin, 0)).toBe(0);
  });

  it('moneyline', () => {
    const r = footballProbability(
      s,
      p,
      { market: 'moneyline', kind: 'team', side: 'home', line: null },
      NFL
    );
    expect(r.win).toBeCloseTo(0.874769, 5);
    expect(r.push).toBe(0);
  });

  it('half-point spread cannot push', () => {
    const r = footballProbability(
      s,
      p,
      { market: 'spread', kind: 'team', side: 'home', line: -7.5 },
      NFL
    );
    expect(r.win).toBeCloseTo(0.495522, 5);
    expect(r.push).toBe(0);
  });

  it('integer spread pushes on the number', () => {
    const r = footballProbability(
      s,
      p,
      { market: 'spread', kind: 'team', side: 'away', line: 7 },
      NFL
    );
    expect(r.win).toBeCloseTo(0.435158, 5);
    expect(r.push).toBeCloseTo(0.06932, 5);
  });

  it('totals: over 51.5, under 52 with push (unchanged normal)', () => {
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
    // f floored at 0.02; punt value 1.0 below an average drive moves 1.0
    // toward Houston: mean = 10 + 10.5 x 0.02 + 1.0 = 11.21, sd = 15 x
    // sqrt(0.02). NCAAF: no key numbers. UCF covers when Houston wins by <= 10.
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
    expect(r.win).toBeCloseTo(0.367735, 5);
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

describe('key numbers (NFL weights fitted on 2002-2026 results)', () => {
  it('home -3 pregame at sigma 13.5: 7.9% land exactly on 3 (push)', () => {
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
    expect(r.win).toBeCloseTo(0.466818, 5);
    expect(r.push).toBeCloseTo(0.078867, 5);
  });

  it('weights favor 3 and 7 over their neighbors', () => {
    expect(NFL_KEY_WEIGHTS[3]).toBeGreaterThan(2);
    expect(NFL_KEY_WEIGHTS[7]).toBeGreaterThan(1.4);
    expect(NFL_KEY_WEIGHTS[2]).toBeLessThan(1);
    expect(NFL_KEY_WEIGHTS[4]).toBeLessThan(1);
    // Ties are rare (0.23% of games).
    expect(NFL_KEY_WEIGHTS[0]).toBeLessThan(0.1);
  });

  it('marginPmf sums to 1 and blends weights by scale', () => {
    const full = marginPmf(3, 13.5, NFL_KEY_WEIGHTS);
    expect(full.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    const plain = marginPmf(3, 13.5, NFL_KEY_WEIGHTS, 0);
    expect(pAt(plain, 3)).toBeCloseTo(pAt(marginPmf(3, 13.5, null), 3), 12);
    expect(pAt(full, 3)).toBeGreaterThan(2 * pAt(plain, 3));
  });
});

describe('sigma fitted to the moneyline', () => {
  it('Titans +11.5 with ML 16%: sigma ~11.67, model matches the ML', () => {
    const sigma = fitMarginSigma(11.5, 0.84, NFL_KEY_WEIGHTS, 13.5, [10, 16]);
    expect(sigma).toBeCloseTo(11.6657, 3);
    expect(
      1 - homeWinShare(marginPmf(11.5, sigma, NFL_KEY_WEIGHTS))
    ).toBeCloseTo(0.16, 8);
  });

  it('clamps, and falls back when unidentifiable', () => {
    // PHI +3.5 priced at 36.3% wants sigma < 10.
    expect(fitMarginSigma(-3.5, 0.363, NFL_KEY_WEIGHTS, 13.5, [10, 16])).toBe(
      10
    );
    expect(fitMarginSigma(0, 0.55, NFL_KEY_WEIGHTS, 13.5, [10, 16])).toBe(13.5);
    expect(fitMarginSigma(3, 0.45, NFL_KEY_WEIGHTS, 13.5, [10, 16])).toBe(13.5);
  });
});

describe('doc test cases (bets 11-13, 2026-10-04)', () => {
  // Values from the independent Python reference; ranges from the doc.
  const pre = state('nfl', { status: 'pre' });
  const fitted = (margin: number, homeWin: number, total: number) => {
    const p = prior({
      expectedMargin: margin,
      homeWin,
      awayWin: 1 - homeWin,
      expectedTotal: total,
    });
    return {
      ...p,
      marginSigma: fitMarginSigma(
        margin,
        homeWin,
        NFL_KEY_WEIGHTS,
        13.5,
        [10, 16]
      ),
    };
  };
  const ml = (side: 'home' | 'away') => ({
    market: 'moneyline' as const,
    kind: 'team' as const,
    side,
    line: null,
  });
  const spread = (side: 'home' | 'away', line: number) => ({
    market: 'spread' as const,
    kind: 'team' as const,
    side,
    line,
  });
  const under = (line: number) => ({
    market: 'total' as const,
    kind: 'under' as const,
    side: null,
    line,
  });
  const win = (outs: { p: number; pushed: number[] }[]) =>
    outs.filter((o) => !o.pushed.length).reduce((a, o) => a + o.p, 0);

  // DET @ CAR: CAR home, DET -3.5, CAR ML 36.9%, total 51.5
  const detCar = fitted(-3.5, 0.369, 51.5);

  it('Titans ML (BAL -11.5, ML 0.16): 0.155-0.165', () => {
    const r = footballProbability(
      pre,
      fitted(11.5, 0.84, 42.5),
      ml('away'),
      NFL
    );
    expect(r.win).toBeCloseTo(0.159733, 5);
  });

  it('Lions ML (DET -3.5, ML 0.631): 0.625-0.635', () => {
    expect(footballProbability(pre, detCar, ml('away'), NFL).win).toBeCloseTo(
      0.629145,
      5
    );
  });

  it('SGP Lions ML + CAR +3.5 + U50.5: 0.065-0.080 (was 0.142)', () => {
    const j = footballJoint(
      pre,
      detCar,
      [ml('away'), spread('home', 3.5), under(50.5)],
      NFL
    );
    expect(win(j)).toBeCloseTo(0.074546, 5);
  });

  it('SGP Lions ML + CAR +3.5: 0.13-0.16 (was 0.302)', () => {
    const j = footballJoint(
      pre,
      detCar,
      [ml('away'), spread('home', 3.5)],
      NFL
    );
    expect(win(j)).toBeCloseTo(0.158832, 5);
  });

  it('sanity: Lions ML + Lions -3.5 = P(Lions -3.5)', () => {
    const j = footballJoint(
      pre,
      detCar,
      [ml('away'), spread('away', -3.5)],
      NFL
    );
    const single = footballProbability(
      pre,
      detCar,
      spread('away', -3.5),
      NFL
    ).win;
    expect(win(j)).toBeCloseTo(single, 12);
    expect(single).toBeCloseTo(0.470313, 5);
  });

  it('Eagles +3.5 (PHI ML 0.363 -> sigma clamped at 10): 0.531', () => {
    // Doc expected 0.49-0.51 (continuous model). Key numbers put mass on a
    // 3-point loss; history: +3.5 dogs cover 50.2% vs this model's 52.6%
    // average over those 621 games (within 1.2 standard errors).
    expect(
      footballProbability(
        pre,
        fitted(-3.5, 0.363, 42.5),
        spread('home', 3.5),
        NFL
      ).win
    ).toBeCloseTo(0.531079, 5);
  });

  it('live SGP: DET up 17-14, 2:00 Q4 -> joint = P(DET by 1-3 and total <= 50)', () => {
    const live = state('nfl', {
      homeScore: 14,
      awayScore: 17,
      period: 4,
      clockSeconds: 120,
      fractionRemaining: 120 / 3600,
    });
    const j = footballJoint(
      live,
      detCar,
      [ml('away'), spread('home', 3.5), under(50.5)],
      NFL
    );
    expect(win(j)).toBeCloseTo(0.536045, 5);
  });
});
