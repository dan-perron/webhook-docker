import type { GameState } from '../gamestate/types.js';
import { condBeat } from './mlb.js';
import type { Prior } from './prior.js';
import { ScoreDist } from './scoreDist.js';
import { leastSquares, logit, poissonPmf } from './stats.js';

// Soccer: each team's remaining goals ~ Poisson(rate x share of the match
// left), with the Dixon–Coles low-score correction (rho) so draws and 1-0s
// come out at their real frequency. Regulation only (90 + stoppage); 3-way
// markets settle on regulation. Fitted pregame to home/draw/away and the
// total.

/** Average stoppage time added to each half (minutes). */
export const STOPPAGE_FIRST_HALF = 2;
export const STOPPAGE_SECOND_HALF = 5;
export const MATCH_MINUTES = 90 + STOPPAGE_FIRST_HALF + STOPPAGE_SECOND_HALF;
/** Even in deep stoppage time, a goal can still come. */
const MIN_MINUTES_LEFT = 0.5;
const MAX_GOALS = 15;

export interface SoccerFit {
  /** Expected goals over a full match. */
  home: number;
  away: number;
  /** Dixon–Coles rho: < 0 adds draws/low scores, > 0 removes them. */
  rho: number;
}

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

/** Dixon–Coles adjustment for the four lowest scorelines of the remaining goals. */
function tau(
  i: number,
  j: number,
  lh: number,
  la: number,
  rho: number
): number {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

/** Distribution of the final score from the current state. */
export function soccerScores(state: GameState, fit: SoccerFit): ScoreDist {
  const left = minutesRemaining(state) / MATCH_MINUTES;
  const lh = fit.home * left;
  const la = fit.away * left;
  const ph = poissonPmf(lh, MAX_GOALS);
  const pa = poissonPmf(la, MAX_GOALS);
  const out = new ScoreDist(MAX_GOALS + 10);
  let sum = 0;
  const cells: [number, number, number][] = [];
  for (let i = 0; i < ph.length; i++) {
    for (let j = 0; j < pa.length; j++) {
      const p = Math.max(0, ph[i]! * pa[j]! * tau(i, j, lh, la, fit.rho));
      cells.push([i, j, p]);
      sum += p;
    }
  }
  for (const [i, j, p] of cells)
    out.add(state.home.score + i, state.away.score + j, p / sum);
  return out;
}

/** Home/draw/away of a score distribution. */
export function threeWay(dist: ScoreDist): {
  home: number;
  draw: number;
  away: number;
} {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (const [h, a, p] of dist.cells()) {
    if (h > a) home += p;
    else if (h === a) draw += p;
    else away += p;
  }
  return { home, draw, away };
}

const pregame = {
  status: 'pre',
  home: { score: 0 },
  away: { score: 0 },
  situation: null,
} as unknown as GameState;

/**
 * Fit both goal rates and rho so the pregame model prices home, draw and
 * the main total (P(over) at the line; 50/50 at the line when unpriced).
 */
export function fitSoccer(prior: Prior): SoccerFit {
  const total = prior.totalLine ?? null;
  const goals = total?.line ?? prior.expectedTotal ?? 2.6;
  const share = prior.homeWin / (prior.homeWin + prior.awayWin);
  const start: SoccerFit = {
    home: goals * share,
    away: goals * (1 - share),
    rho: 0,
  };
  const resid = (f: SoccerFit) => {
    const dist = soccerScores(pregame, f);
    const w = threeWay(dist);
    const r = [
      logit(w.home) - logit(prior.homeWin),
      logit(w.draw) - logit(prior.draw),
    ];
    if (total)
      r.push(logit(condBeat(dist, total.line, 'total')) - logit(total.p));
    return r;
  };
  const { x } = leastSquares(
    (v) => resid({ home: v[0]!, away: v[1]!, rho: total ? v[2]! : 0 }),
    total ? [start.home, start.away, 0] : [start.home, start.away],
    [
      { lo: 0.05, hi: 5 },
      { lo: 0.05, hi: 5 },
      ...(total ? [{ lo: -0.2, hi: 0.2 }] : []),
    ]
  );
  return { home: x[0]!, away: x[1]!, rho: total ? x[2]! : 0 };
}
