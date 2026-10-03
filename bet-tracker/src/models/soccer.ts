import type { GameState } from '../gamestate/types.js';
import type { Prior } from './prior.js';
import { poissonPmf } from './stats.js';
import { beatLine, type ModelSelection, type Outcome } from './types.js';

// Soccer: each team's remaining goals ~ Poisson(rate x minutes left), rates
// from the prior's expected goals. Regulation only (90 + stoppage); 3-way
// markets settle on regulation.

/** Average stoppage time added to each half (minutes). */
export const STOPPAGE_FIRST_HALF = 2;
export const STOPPAGE_SECOND_HALF = 5;
export const MATCH_MINUTES = 90 + STOPPAGE_FIRST_HALF + STOPPAGE_SECOND_HALF;
/** Even in deep stoppage time, a goal can still come. */
const MIN_MINUTES_LEFT = 0.5;
const MAX_GOALS = 15;

/** Minutes still to play, including expected stoppage time. */
export function minutesRemaining(state: GameState): number {
  if (state.status === 'pre') return MATCH_MINUTES;
  if (state.status === 'final') return 0;
  const sit = state.situation?.kind === 'soccer' ? state.situation : null;
  const minute = sit?.minute ?? 45;
  const firstHalfLength = 45 + STOPPAGE_FIRST_HALF;
  const elapsed =
    (sit?.period ?? 1) <= 1
      ? Math.min(minute, firstHalfLength)
      : firstHalfLength + Math.max(0, minute - 45);
  return Math.max(MIN_MINUTES_LEFT, MATCH_MINUTES - elapsed);
}

/** Home/draw/away from two independent Poisson goal counts. */
export function threeWay(
  home: number[],
  away: number[]
): { home: number; draw: number; away: number } {
  let h = 0;
  let d = 0;
  let a = 0;
  for (let i = 0; i < home.length; i++) {
    for (let j = 0; j < away.length; j++) {
      const p = home[i]! * away[j]!;
      if (i > j) h += p;
      else if (i === j) d += p;
      else a += p;
    }
  }
  return { home: h, draw: d, away: a };
}

/**
 * Expected goals per team: split the expected total so the home share of
 * decisive results matches the prior's home/away ratio (bisection).
 */
export function goalRates(prior: Prior): { home: number; away: number } {
  const total = prior.expectedTotal ?? 2.6;
  const target = prior.homeWin / (prior.homeWin + prior.awayWin);
  let lo = 0.02;
  let hi = 0.98;
  for (let k = 0; k < 50; k++) {
    const s = (lo + hi) / 2;
    const r = threeWay(
      poissonPmf(total * s, MAX_GOALS),
      poissonPmf(total * (1 - s), MAX_GOALS)
    );
    if (r.home / (r.home + r.away) < target) lo = s;
    else hi = s;
  }
  const share = (lo + hi) / 2;
  return { home: total * share, away: total * (1 - share) };
}

export function soccerProbability(
  state: GameState,
  prior: Prior,
  sel: ModelSelection
): Outcome {
  const rates = goalRates(prior);
  const left = minutesRemaining(state) / MATCH_MINUTES;
  const addHome = poissonPmf(rates.home * left, MAX_GOALS);
  const addAway = poissonPmf(rates.away * left, MAX_GOALS);

  // Distribution of the final margin (home - away) and total, via convolution.
  const margin = new Map<number, number>();
  const total = new Map<number, number>();
  const m0 = state.home.score - state.away.score;
  const t0 = state.home.score + state.away.score;
  for (let i = 0; i < addHome.length; i++) {
    for (let j = 0; j < addAway.length; j++) {
      const p = addHome[i]! * addAway[j]!;
      margin.set(m0 + i - j, (margin.get(m0 + i - j) ?? 0) + p);
      total.set(t0 + i + j, (total.get(t0 + i + j) ?? 0) + p);
    }
  }
  const cdf = (dist: Map<number, number>, sign: number) => (y: number) => {
    let c = 0;
    for (const [v, p] of dist) if (sign * v <= y) c += p;
    return c;
  };

  switch (sel.market) {
    case 'moneyline3way': {
      const homeWin = 1 - cdf(margin, 1)(0);
      const awayWin = cdf(margin, 1)(-1);
      const draw = 1 - homeWin - awayWin;
      const win =
        sel.kind === 'draw' ? draw : sel.side === 'home' ? homeWin : awayWin;
      return { win, push: 0 };
    }
    case 'total': {
      if (sel.line == null) throw new Error('total needs a line');
      const over = beatLine(sel.line, cdf(total, 1));
      return sel.kind === 'over'
        ? over
        : { win: 1 - over.win - over.push, push: over.push };
    }
    case 'spread': {
      if (sel.line == null || !sel.side)
        throw new Error('spread needs a side and line');
      return beatLine(-sel.line, cdf(margin, sel.side === 'home' ? 1 : -1));
    }
    default:
      throw new Error(
        `soccer does not support ${sel.market}; use moneyline3way`
      );
  }
}
