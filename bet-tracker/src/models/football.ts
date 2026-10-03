import type { Side } from '../domain/types.js';
import type { FootballSituation, GameState } from '../gamestate/types.js';
import type { FootballSigmas, Prior } from './prior.js';
import { normalCdf } from './stats.js';
import { beatLine, type ModelSelection, type Outcome } from './types.js';

// Football (NFL/NCAAF): final margin ~ Normal(mean, sd) with
//   mean = current margin + pregame expected margin x fraction remaining
//          + possession value
//   sd   = sigma x sqrt(fraction remaining)
// Totals the same way with the pregame total. Scores are integers, so lines
// are evaluated with a continuity correction (integer lines can push).

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

export interface FootballDistribution {
  /** Expected final margin, home minus away. */
  marginMean: number;
  marginSd: number;
  totalMean: number;
  totalSd: number;
  /** Possession value added to the margin (signed toward home). */
  possessionEp: number;
}

export function footballDistribution(
  state: GameState,
  prior: Prior,
  sigmas: FootballSigmas
): FootballDistribution {
  const f =
    state.status === 'pre'
      ? 1
      : Math.max(MIN_FRACTION, state.fractionRemaining);
  const sit = state.situation?.kind === 'football' ? state.situation : null;
  const excess = sit?.possession ? driveEp(sit) - BASELINE_DRIVE_EP : 0;
  const signed =
    sit?.possession === 'home'
      ? excess
      : sit?.possession === 'away'
        ? -excess
        : 0;
  const margin = state.home.score - state.away.score;
  const total = state.home.score + state.away.score;
  return {
    marginMean: margin + (prior.expectedMargin ?? 0) * f + signed,
    marginSd: sigmas.marginSigma * Math.sqrt(f),
    totalMean: total + (prior.expectedTotal ?? 0) * f + excess,
    totalSd: sigmas.totalSigma * Math.sqrt(f),
    possessionEp: signed,
  };
}

/**
 * P(backed side wins a game still tied after regulation). Overtime is close
 * to a coin flip; lean halfway toward the pregame favorite.
 */
function overtimeWin(prior: Prior, side: Side): number {
  const p = side === 'home' ? prior.homeWin : prior.awayWin;
  return 0.5 + (p - 0.5) * 0.5;
}

export function footballProbability(
  state: GameState,
  prior: Prior,
  sel: ModelSelection,
  sigmas: FootballSigmas
): Outcome {
  const d = footballDistribution(state, prior, sigmas);

  if (sel.market === 'total') {
    if (sel.line == null) throw new Error('total needs a line');
    const over = beatLine(sel.line, (y) =>
      normalCdf((y - d.totalMean) / d.totalSd)
    );
    return sel.kind === 'over'
      ? over
      : { win: 1 - over.win - over.push, push: over.push };
  }

  if (!sel.side) throw new Error(`${sel.market} needs a side`);
  // Margin from the backed side's perspective.
  const mu = sel.side === 'home' ? d.marginMean : -d.marginMean;
  const cdf = (y: number) => normalCdf((y - mu) / d.marginSd);

  if (sel.market === 'moneyline') {
    // Win outright, or tie after regulation and win in overtime.
    const tie = cdf(0.5) - cdf(-0.5);
    return { win: 1 - cdf(0.5) + tie * overtimeWin(prior, sel.side), push: 0 };
  }
  if (sel.market === 'spread') {
    if (sel.line == null) throw new Error('spread needs a line');
    // Covers when margin + line > 0, i.e. margin beats -line.
    return beatLine(-sel.line, cdf);
  }
  throw new Error(`football does not support ${sel.market}`);
}
