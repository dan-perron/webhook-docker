import type { Side } from '../domain/types.js';
import type { JointOutcome } from '../domain/value.js';
import type { FootballSituation, GameState } from '../gamestate/types.js';
import nflKeyNumbers from './data/nfl-key-numbers.json' with { type: 'json' };
import type { FootballSigmas, Prior } from './prior.js';
import { normalCdf } from './stats.js';
import type { ModelSelection, Outcome } from './types.js';

// Football (NFL/NCAAF). The final margin is an integer pmf:
//   P(m) ∝ φ((m − mean) / sd) · w(|m|)
//   mean = current margin + pregame expected margin x fraction remaining
//          + possession value
//   sd   = σ x sqrt(fraction remaining), σ fitted per game so the pregame
//          model matches the de-vigged moneyline (else the league default)
// w = NFL key-number weights fitted on historical results
// (scripts/fit_key_numbers.py); NCAAF uses none. Live, the weights fade with
// the fraction remaining. Totals ~ Normal discretized to integers. Spreads,
// moneylines and totals are all read off these distributions, and same-game
// parlays off their joint (footballJoint).

/**
 * Expected points of a possession by yards to the opponent's goal on 1st &
 * 10 (gross: what this drive is expected to score). Linear in between.
 */
export const EP_TABLE: ReadonlyArray<readonly [number, number]> = [
  [1, 6.0],
  [5, 5.4],
  [10, 4.9],
  [20, 4.1],
  [30, 3.4],
  [40, 2.9],
  [50, 2.4],
  [60, 2.0],
  [70, 1.6],
  [80, 1.3],
  [90, 0.9],
  [99, 0.5],
];

/**
 * What an average fresh possession is worth (1st & 10 at ~own 28). The
 * fraction-remaining term already includes average possessions, so only the
 * current drive's excess over this counts.
 */
export const BASELINE_DRIVE_EP = 1.5;

/** Below this share of regulation left (OT, end of 4th) keep a little spread. */
const MIN_FRACTION = 0.02;

export function firstDownEp(yardsToGoal: number): number {
  const y = Math.min(99, Math.max(1, yardsToGoal));
  for (let i = 1; i < EP_TABLE.length; i++) {
    const [x1, e1] = EP_TABLE[i]!;
    const [x0, e0] = EP_TABLE[i - 1]!;
    if (y <= x1) return e0 + ((y - x0) / (x1 - x0)) * (e1 - e0);
  }
  return EP_TABLE[EP_TABLE.length - 1]![1];
}

/** Field goal make probability by yards to goal (kick is ~17 yards longer). */
export function fieldGoalProb(yardsToGoal: number): number {
  if (yardsToGoal <= 15) return 0.9;
  if (yardsToGoal <= 25) return 0.8;
  if (yardsToGoal <= 35) return 0.6;
  return 0;
}

/** Fourth-down conversion probability by distance. */
function conversionProb(distance: number): number {
  if (distance <= 1) return 0.7;
  if (distance <= 3) return 0.55;
  if (distance <= 5) return 0.45;
  return 0.3;
}

/** Credit for punting: no points, but the opponent starts deep. */
const PUNT_EP = 0.5;

/**
 * Gross expected points of the current drive, adjusted for down/distance:
 * later downs and longer distances cost value; on 4th down take the best of
 * punting, a field goal try, or going for it.
 */
export function driveEp(s: FootballSituation): number {
  if (s.yardsToGoal == null) return BASELINE_DRIVE_EP;
  const ytg = s.yardsToGoal;
  const dist = s.distance ?? 10;
  const ep = firstDownEp(ytg);
  switch (s.down ?? 1) {
    case 1:
      return ep - 0.05 * Math.max(0, dist - 10);
    case 2:
      return ep - 0.3 - 0.04 * Math.max(0, dist - 5);
    case 3:
      return ep - 0.8 - 0.06 * Math.max(0, dist - 3);
    default: {
      const conv = conversionProb(dist);
      const goForIt =
        conv * firstDownEp(Math.max(1, ytg - dist)) - (1 - conv) * 1.0;
      const fg = 3 * fieldGoalProb(ytg);
      const punt = ytg > 40 ? PUNT_EP : -Infinity;
      return Math.max(goForIt, fg, punt);
    }
  }
}

/** Key-number weights by |margin| (last entry for every larger margin). */
export const NFL_KEY_WEIGHTS: readonly number[] = nflKeyNumbers.weights;

const keyWeightsFor = (sport: GameState['sport']) =>
  sport === 'nfl' ? NFL_KEY_WEIGHTS : null;

/** Margins evaluated in [-MARGIN_RANGE, MARGIN_RANGE]. */
const MARGIN_RANGE = 80;

/** A pmf over integer margins m in [-MARGIN_RANGE, MARGIN_RANGE]; index = m + MARGIN_RANGE. */
export type MarginPmf = Float64Array;
export const pAt = (pmf: MarginPmf, m: number) =>
  Math.abs(m) > MARGIN_RANGE ? 0 : pmf[m + MARGIN_RANGE]!;

/**
 * Integer margin pmf: normal density x key-number weight, renormalized.
 * `weightScale` blends weights toward 1 (0 = plain discretized normal).
 */
export function marginPmf(
  mean: number,
  sd: number,
  weights: readonly number[] | null,
  weightScale = 1
): MarginPmf {
  const out = new Float64Array(2 * MARGIN_RANGE + 1);
  let sum = 0;
  for (let m = -MARGIN_RANGE; m <= MARGIN_RANGE; m++) {
    const z = (m - mean) / sd;
    let p = Math.exp(-0.5 * z * z);
    if (weights) {
      const w = weights[Math.min(Math.abs(m), weights.length - 1)]!;
      p *= 1 + (w - 1) * weightScale;
    }
    out[m + MARGIN_RANGE] = p;
    sum += p;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= sum;
  return out;
}

/** P(home wins | not a tie): what a de-vigged 2-way moneyline prices. */
export function homeWinShare(pmf: MarginPmf): number {
  let win = 0;
  for (let m = 1; m <= MARGIN_RANGE; m++) win += pAt(pmf, m);
  return win / (1 - pAt(pmf, 0));
}

/**
 * σ that makes the pregame margin pmf (mean = expected margin) price the
 * moneyline at `target`, clamped to `range` so a stale or odd line can't
 * blow it up. Unidentifiable (pick'em, or ML and spread disagree on the
 * favorite) -> `fallback`.
 */
export function fitMarginSigma(
  mean: number,
  target: number,
  weights: readonly number[] | null,
  fallback: number,
  range: readonly [number, number]
): number {
  if (mean === 0 || mean > 0 !== target > 0.5) return fallback;
  const share = (s: number) => homeWinShare(marginPmf(mean, s, weights));
  // The favorite's share falls toward 0.5 as σ grows.
  const favored = (s: number) =>
    mean > 0 ? share(s) - target : target - share(s);
  let [lo, hi] = range;
  if (favored(lo) < 0) return lo;
  if (favored(hi) > 0) return hi;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (favored(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface FootballDistribution {
  /** Expected final margin, home minus away (before key numbers). */
  marginMean: number;
  marginSd: number;
  /** σ used: fitted to this game's moneyline, or the league default. */
  sigma: number;
  /** Final margin pmf (live: a regulation tie is resolved as OT, ±3). */
  margin: MarginPmf;
  totalMean: number;
  totalSd: number;
  /** Possession value added to the margin (signed toward home). */
  possessionEp: number;
}

/**
 * P(backed side wins a game still tied after regulation). Overtime is close
 * to a coin flip; lean halfway toward the pregame favorite.
 */
function overtimeWin(prior: Prior, side: Side): number {
  const p = side === 'home' ? prior.homeWin : prior.awayWin;
  return 0.5 + (p - 0.5) * 0.5;
}

/** OT winners most often win by a field goal. */
const OVERTIME_MARGIN = 3;

export function footballDistribution(
  state: GameState,
  prior: Prior,
  sigmas: FootballSigmas
): FootballDistribution {
  const pre = state.status === 'pre';
  const f = pre ? 1 : Math.max(MIN_FRACTION, state.fractionRemaining);
  const sit = state.situation?.kind === 'football' ? state.situation : null;
  const excess = sit?.possession ? driveEp(sit) - BASELINE_DRIVE_EP : 0;
  const signed =
    sit?.possession === 'home'
      ? excess
      : sit?.possession === 'away'
        ? -excess
        : 0;
  const sigma = prior.marginSigma ?? sigmas.marginSigma;
  const marginMean =
    state.home.score -
    state.away.score +
    (prior.expectedMargin ?? 0) * f +
    signed;
  const marginSd = sigma * Math.sqrt(f);
  // Pregame, m = 0 is a true tie (historical finals include OT). Live, the
  // weights fade out and a regulation tie goes to overtime.
  const margin = marginPmf(
    marginMean,
    marginSd,
    keyWeightsFor(state.sport),
    pre ? 1 : f
  );
  if (!pre) {
    const tie = pAt(margin, 0);
    const home = overtimeWin(prior, 'home');
    margin[MARGIN_RANGE] = 0;
    margin[MARGIN_RANGE + OVERTIME_MARGIN]! += tie * home;
    margin[MARGIN_RANGE - OVERTIME_MARGIN]! += tie * (1 - home);
  }
  return {
    marginMean,
    marginSd,
    sigma,
    margin,
    totalMean:
      state.home.score +
      state.away.score +
      (prior.expectedTotal ?? 0) * f +
      excess,
    totalSd: sigmas.totalSigma * Math.sqrt(f),
    possessionEp: signed,
  };
}

type LegResult = 'won' | 'lost' | 'push';
const cmp = (x: number): LegResult => (x > 0 ? 'won' : x < 0 ? 'lost' : 'push');

/** A leg's result for a final margin (home − away) and total. */
function legResult(
  sel: ModelSelection,
  margin: number,
  total: number
): LegResult {
  if (sel.market === 'total') {
    if (sel.line == null) throw new Error('total needs a line');
    return cmp(sel.kind === 'over' ? total - sel.line : sel.line - total);
  }
  if (!sel.side) throw new Error(`${sel.market} needs a side`);
  const sideMargin = sel.side === 'home' ? margin : -margin;
  if (sel.market === 'moneyline') return cmp(sideMargin); // a tie pushes
  if (sel.market === 'spread') {
    if (sel.line == null) throw new Error('spread needs a line');
    return cmp(sideMargin + sel.line);
  }
  throw new Error(`football does not support ${sel.market}`);
}

/** Integer total pmf: Normal(mean, sd) with continuity correction. */
function totalPmf(mean: number, sd: number): { from: number; p: number[] } {
  const from = Math.max(0, Math.floor(mean - 8 * sd));
  const to = Math.ceil(mean + 8 * sd);
  const p: number[] = [];
  for (let t = from; t <= to; t++) {
    const lo = t === from ? 0 : normalCdf((t - 0.5 - mean) / sd);
    const hi = t === to ? 1 : normalCdf((t + 0.5 - mean) / sd);
    p.push(hi - lo);
  }
  return { from, p };
}

/**
 * Joint outcome of several legs on one game, summed exactly over (margin,
 * total). `totalLink` shifts the expected total per point of |margin| away
 * from its mean (close games run lower-scoring when > 0); default 0 =
 * independent. Returns every non-losing outcome with the legs (indices into
 * `sels`) that push in it.
 */
export function footballJoint(
  state: GameState,
  prior: Prior,
  sels: ModelSelection[],
  sigmas: FootballSigmas,
  totalLink = 0
): JointOutcome[] {
  const d = footballDistribution(state, prior, sigmas);
  const usesTotal = sels.some((s) => s.market === 'total');
  let meanAbs = 0;
  if (totalLink !== 0) {
    for (let m = -MARGIN_RANGE; m <= MARGIN_RANGE; m++)
      meanAbs += Math.abs(m) * pAt(d.margin, m);
  }
  const base = usesTotal
    ? totalPmf(d.totalMean, d.totalSd)
    : { from: 0, p: [1] };
  const acc = new Map<string, JointOutcome>();
  for (let m = -MARGIN_RANGE; m <= MARGIN_RANGE; m++) {
    const pm = pAt(d.margin, m);
    if (pm < 1e-12) continue;
    const tp =
      usesTotal && totalLink !== 0
        ? totalPmf(d.totalMean + totalLink * (Math.abs(m) - meanAbs), d.totalSd)
        : base;
    for (let i = 0; i < tp.p.length; i++) {
      const p = pm * tp.p[i]!;
      if (p < 1e-14) continue;
      const pushed: number[] = [];
      let lost = false;
      for (let j = 0; j < sels.length && !lost; j++) {
        const r = legResult(sels[j]!, m, tp.from + i);
        if (r === 'lost') lost = true;
        else if (r === 'push') pushed.push(j);
      }
      if (lost) continue;
      const key = pushed.join(',');
      const o = acc.get(key);
      if (o) o.p += p;
      else acc.set(key, { p, pushed });
    }
  }
  return [...acc.values()];
}

/** One leg's win/push probability, from the same distributions. */
export function footballProbability(
  state: GameState,
  prior: Prior,
  sel: ModelSelection,
  sigmas: FootballSigmas
): Outcome {
  let win = 0;
  let push = 0;
  for (const o of footballJoint(state, prior, [sel], sigmas)) {
    if (o.pushed.length) push += o.p;
    else win += o.p;
  }
  return { win, push };
}
