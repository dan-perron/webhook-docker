import type { BaseballSituation, GameState } from '../gamestate/types.js';
import type { Prior } from './prior.js';
import { samplePoisson, type Rng } from './stats.js';
import { beatLine, type ModelSelection, type Outcome } from './types.js';

// MLB: Monte Carlo of the remaining half-innings. Team run rates come from
// the prior (pregame total split by the moneyline). The current half-inning
// finishes from its base/out state using RE24-style tables; later ones start
// clean. Extras are played out (with the regular-season runner on 2nd), the
// home team skips the bottom of the 9th+ when ahead, and walk-offs end it.

// Index: [outs][bases] with bases as a bitmask 1st=1, 2nd=2, 3rd=4.
/** Expected runs scored from this state to the end of the half-inning. */
export const RE24: readonly (readonly number[])[] = [
  [0.48, 0.85, 1.1, 1.44, 1.35, 1.78, 1.96, 2.29],
  [0.25, 0.5, 0.66, 0.89, 0.95, 1.13, 1.39, 1.54],
  [0.1, 0.22, 0.32, 0.43, 0.36, 0.48, 0.58, 0.75],
];
/** P(at least one run scores) from this state to the end of the half-inning. */
export const P_SCORE: readonly (readonly number[])[] = [
  [0.27, 0.43, 0.62, 0.62, 0.85, 0.88, 0.86, 0.87],
  [0.16, 0.28, 0.41, 0.43, 0.66, 0.65, 0.69, 0.67],
  [0.07, 0.13, 0.23, 0.23, 0.27, 0.29, 0.27, 0.32],
];
/** League-average runs per half-inning (RE24 for a fresh inning). */
export const LEAGUE_RUNS_PER_INNING = RE24[0]![0]!;

/** Pythagenpat-style exponent linking run share to win share. */
const PYTH_EXPONENT = 1.83;
const MAX_INNINGS = 30;

export const basesMask = (
  s: Pick<BaseballSituation, 'first' | 'second' | 'third'>
) => (s.first ? 1 : 0) | (s.second ? 2 : 0) | (s.third ? 4 : 0);

/**
 * Runs from a base/out state to the end of the half-inning for a team whose
 * scoring is `scale` x league average. Hurdle model: score at all with the
 * table probability, then 1 + Poisson for the rest, matching the table mean.
 */
export function sampleHalfInningRuns(
  outs: number,
  bases: number,
  scale: number,
  rng: Rng
): number {
  const mean = RE24[outs]![bases]! * scale;
  const p = 1 - Math.pow(1 - P_SCORE[outs]![bases]!, scale);
  if (rng() >= p) return 0;
  return 1 + samplePoisson(Math.max(0, mean / p - 1), rng);
}

/** Expected runs per 9 innings for each team, from the prior. */
export function runRates(prior: Prior): { home: number; away: number } {
  const total = prior.expectedTotal ?? 8.8;
  const h = Math.pow(prior.homeWin, 1 / PYTH_EXPONENT);
  const a = Math.pow(prior.awayWin, 1 / PYTH_EXPONENT);
  const share = h / (h + a);
  return { home: total * share, away: total * (1 - share) };
}

export interface MlbSimResult {
  n: number;
  /** Final home-minus-away margin per simulation. */
  margins: Int16Array;
  /** Final total runs per simulation. */
  totals: Int16Array;
}

export interface MlbSimOptions {
  simulations: number;
  rng: Rng;
}

/** Simulate the rest of the game `n` times from the current state. */
export function simulateMlb(
  state: GameState,
  prior: Prior,
  opts: MlbSimOptions
): MlbSimResult {
  const rates = runRates(prior);
  const scaleHome = rates.home / 9 / LEAGUE_RUNS_PER_INNING;
  const scaleAway = rates.away / 9 / LEAGUE_RUNS_PER_INNING;
  const sit: BaseballSituation =
    state.status === 'in' && state.situation?.kind === 'baseball'
      ? state.situation
      : {
          kind: 'baseball',
          inning: state.status === 'in' ? (state.period ?? 1) : 1,
          half: 'top',
          outs: 0,
          first: false,
          second: false,
          third: false,
          scheduledInnings: 9,
          extraInningRunner: false,
        };
  const scheduled = sit.scheduledInnings;
  const margins = new Int16Array(opts.simulations);
  const totals = new Int16Array(opts.simulations);

  for (let i = 0; i < opts.simulations; i++) {
    let home = state.home.score;
    let away = state.away.score;
    let inning = sit.inning;
    let half = sit.half;
    let first = true;
    for (;;) {
      // Home doesn't bat in the bottom of the 9th+ when already ahead; a
      // tie-free score after a full 9th+ inning ends the game.
      if (half === 'bottom' && inning >= scheduled && home > away) break;
      if (half === 'top' && inning > scheduled && home !== away) break;
      if (inning > MAX_INNINGS) {
        if (home === away) home += opts.rng() < 0.5 ? 1 : 0;
        if (home === away) away += 1;
        break;
      }
      const extra = inning > scheduled && sit.extraInningRunner;
      const outs = first ? sit.outs : 0;
      const bases = first ? basesMask(sit) : extra ? 2 : 0;
      const runs = sampleHalfInningRuns(
        outs,
        bases,
        half === 'top' ? scaleAway : scaleHome,
        opts.rng
      );
      first = false;
      if (half === 'top') {
        away += runs;
        half = 'bottom';
      } else if (inning >= scheduled && home + runs > away) {
        // Walk-off: the game ends when the winning run scores (home trails or
        // is tied here, so it finishes one run ahead).
        home = away + 1;
        break;
      } else {
        home += runs;
        half = 'top';
        inning++;
      }
    }
    margins[i] = home - away;
    totals[i] = home + away;
  }
  return { n: opts.simulations, margins, totals };
}

/** Evaluate a selection against simulated finals (empirical CDF). */
export function mlbOutcome(sim: MlbSimResult, sel: ModelSelection): Outcome {
  const values = sel.market === 'total' ? sim.totals : sim.margins;
  const sign = sel.market !== 'total' && sel.side === 'away' ? -1 : 1;
  const cdfAt = (y: number) => {
    let c = 0;
    for (let i = 0; i < sim.n; i++) if (sign * values[i]! <= y) c++;
    return c / sim.n;
  };
  if (sel.market === 'total') {
    if (sel.line == null) throw new Error('total needs a line');
    const over = beatLine(sel.line, cdfAt);
    return sel.kind === 'over'
      ? over
      : { win: 1 - over.win - over.push, push: over.push };
  }
  if (!sel.side) throw new Error(`${sel.market} needs a side`);
  if (sel.market === 'moneyline') return { win: 1 - cdfAt(0), push: 0 };
  if (sel.market === 'spread') {
    if (sel.line == null) throw new Error('spread needs a line');
    return beatLine(-sel.line, cdfAt);
  }
  throw new Error(`mlb does not support ${sel.market}`);
}
