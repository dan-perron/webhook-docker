import { describe, expect, it } from 'vitest';
import {
  calibrate,
  wilson,
  type CalibrationPoint,
} from '../src/tracker/calibration.js';

// Hand-computed: leg 1 won (0.6 pregame, 0.8 live), leg 2 lost (0.3 pregame),
// leg 3 won (0.9 pregame, 0.7 live). Each leg weighs 1 in total.
const P = (
  legId: number,
  probability: number,
  outcome: 0 | 1,
  pregame: boolean
): CalibrationPoint => ({ legId, sport: 'nfl', probability, outcome, pregame });
const points = [
  P(1, 0.6, 1, true),
  P(1, 0.8, 1, false),
  P(2, 0.3, 0, true),
  P(3, 0.9, 1, true),
  P(3, 0.7, 1, false),
];

describe('calibrate', () => {
  const c = calibrate(points, 'nfl');

  it('weights each leg once', () => {
    expect(c.legs).toBe(3);
    expect(c.snapshots).toBe(5);
    // leg means of squared error: (0.16 + 0.04)/2, 0.09, (0.01 + 0.09)/2 -> 0.24 / 3
    expect(c.brier).toBeCloseTo(0.08, 12);
    // 2 of 3 legs won
    expect(c.baseRate).toBeCloseTo(2 / 3, 12);
    expect(c.brierBaseRate).toBeCloseTo(2 / 9, 12);
    // 1 - 0.08 / (2/9)
    expect(c.skill).toBeCloseTo(0.64, 12);
  });

  it('pregame Brier uses only pregame snapshots', () => {
    // (0.16 + 0.09 + 0.01) / 3
    expect(c.brierPregame).toBeCloseTo(0.086667, 6);
  });

  it('bins by predicted probability with leg weights', () => {
    expect(c.bins.map((b) => Math.round(b.lo * 10))).toEqual([3, 6, 7, 8, 9]);
    const b3 = c.bins.find((b) => Math.round(b.lo * 10) === 3)!;
    expect(b3).toMatchObject({ legs: 1, observed: 0 });
    expect(b3.meanPredicted).toBeCloseTo(0.3, 12);
    const b6 = c.bins.find((b) => Math.round(b.lo * 10) === 6)!;
    expect(b6.legs).toBeCloseTo(0.5, 12);
  });

  it('a probability of exactly 1 lands in the top bin', () => {
    const top = calibrate([P(9, 1, 1, false)], 'nfl').bins[0]!;
    expect(top.lo).toBeCloseTo(0.9, 12);
  });

  it('no data -> zeros, no skill', () => {
    const empty = calibrate([], 'mlb');
    expect(empty).toMatchObject({ legs: 0, brier: 0, skill: null, bins: [] });
  });
});

describe('wilson', () => {
  it('95% interval for 7 of 10', () => {
    const [lo, hi] = wilson(0.7, 10);
    expect(lo).toBeCloseTo(0.396773, 5);
    expect(hi).toBeCloseTo(0.892211, 5);
  });

  it('stays within [0, 1]', () => {
    const [lo, hi] = wilson(1, 1);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });
});
