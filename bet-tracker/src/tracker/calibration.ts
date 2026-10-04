import { isNotNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { predictionSnapshots } from '../db/schema.js';

// Calibration of the models against settled outcomes. Every settled leg
// counts once: its snapshots (one pregame, then up to one per 5 minutes
// live) share a total weight of 1, so long live games don't dominate.

export interface CalibrationPoint {
  legId: number;
  sport: string;
  probability: number;
  /** 1 won, 0 lost (pushes/voids carry no outcome and are excluded). */
  outcome: 0 | 1;
  pregame: boolean;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  /** Effective legs in the bin (sum of weights). */
  legs: number;
  meanPredicted: number;
  observed: number;
  /** 95% Wilson interval for the observed rate. */
  ciLow: number;
  ciHigh: number;
}

export interface SportCalibration {
  sport: string;
  legs: number;
  snapshots: number;
  /** Mean squared error of probability vs outcome; 0 is perfect. */
  brier: number;
  /** Brier of the pregame snapshots only (null when none). */
  brierPregame: number | null;
  baseRate: number;
  /** Brier of always predicting the base rate. */
  brierBaseRate: number;
  /** 1 - brier / brierBaseRate: > 0 beats the base rate. */
  skill: number | null;
  bins: ReliabilityBin[];
}

/** Wilson score interval; works with a fractional (effective) n. */
export function wilson(p: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half =
    (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function calibrate(
  points: CalibrationPoint[],
  sport: string,
  binWidth = 0.1
): SportCalibration {
  const perLeg = new Map<number, number>();
  for (const p of points) perLeg.set(p.legId, (perLeg.get(p.legId) ?? 0) + 1);
  const weight = (p: CalibrationPoint) => 1 / perLeg.get(p.legId)!;

  let wSum = 0;
  let brierSum = 0;
  let wins = 0;
  for (const p of points) {
    const w = weight(p);
    wSum += w;
    brierSum += w * (p.probability - p.outcome) ** 2;
    wins += w * p.outcome;
  }
  const pre = points.filter((p) => p.pregame);
  const brierPregame = pre.length
    ? pre.reduce((a, p) => a + (p.probability - p.outcome) ** 2, 0) / pre.length
    : null;
  const baseRate = wSum ? wins / wSum : 0;
  const brier = wSum ? brierSum / wSum : 0;
  const brierBaseRate = baseRate * (1 - baseRate);

  const nBins = Math.round(1 / binWidth);
  const acc = Array.from({ length: nBins }, () => ({ w: 0, p: 0, o: 0 }));
  // p * nBins, not p / binWidth: 0.3 / 0.1 is 2.999... in floating point.
  for (const p of points) {
    const i = Math.min(nBins - 1, Math.floor(p.probability * nBins + 1e-9));
    const w = weight(p);
    acc[i]!.w += w;
    acc[i]!.p += w * p.probability;
    acc[i]!.o += w * p.outcome;
  }
  const bins = acc.flatMap((a, i) => {
    if (a.w === 0) return [];
    const observed = a.o / a.w;
    const [ciLow, ciHigh] = wilson(observed, a.w);
    return [
      {
        lo: i * binWidth,
        hi: (i + 1) * binWidth,
        legs: a.w,
        meanPredicted: a.p / a.w,
        observed,
        ciLow,
        ciHigh,
      },
    ];
  });

  return {
    sport,
    legs: perLeg.size,
    snapshots: points.length,
    brier,
    brierPregame,
    baseRate,
    brierBaseRate,
    skill: brierBaseRate > 0 ? 1 - brier / brierBaseRate : null,
    bins,
  };
}

const SPORT_ORDER = ['nfl', 'ncaaf', 'mlb', 'soccer', 'mma'];

/** Per sport (in a fixed order) plus 'all', from logged snapshots. */
export function calibrationReport(db: Db): SportCalibration[] {
  const rows = db
    .select()
    .from(predictionSnapshots)
    .where(isNotNull(predictionSnapshots.outcome))
    .all();
  const points: CalibrationPoint[] = rows
    .filter((r) => r.legId != null)
    .map((r) => ({
      legId: r.legId!,
      sport: r.sport,
      probability: r.probability,
      outcome: r.outcome === 1 ? 1 : 0,
      pregame: r.gameStatus === 'pre',
    }));
  if (points.length === 0) return [];
  const sports = [...new Set(points.map((p) => p.sport))].sort(
    (a, b) => SPORT_ORDER.indexOf(a) - SPORT_ORDER.indexOf(b)
  );
  return [
    calibrate(points, 'all'),
    ...sports.map((s) =>
      calibrate(
        points.filter((p) => p.sport === s),
        s
      )
    ),
  ];
}
