import type { LegStatus, Sport } from '../domain/types.js';
import type { GameState } from '../gamestate/types.js';
import { footballDistribution, footballProbability } from './football.js';
import { mlbOutcome, runRates, simulateMlb } from './mlb.js';
import type { ModelParams, Prior } from './prior.js';
import { goalRates, minutesRemaining, soccerProbability } from './soccer.js';
import type { Rng } from './stats.js';
import { certain, type ModelSelection, type Outcome } from './types.js';

export type ModelName =
  | 'football_normal'
  | 'mlb_monte_carlo'
  | 'soccer_poisson'
  | 'mma_prior'
  | 'settled';

export interface LegEvaluation {
  outcome: Outcome;
  /** 'open' while live; the exact result once the game is final. */
  status: LegStatus;
  model: ModelName;
  /** Model inputs worth showing (means, rates, minutes left...). */
  inputs: Record<string, number | string | null>;
}

/** Exact result of a selection on a final game. */
export function settleSelection(
  sport: Sport,
  state: GameState,
  sel: ModelSelection
): Exclude<LegStatus, 'open'> {
  if (state.cancelled) return 'void';
  const margin = state.home.score - state.away.score;
  const total = state.home.score + state.away.score;
  const cmp = (x: number): 'won' | 'lost' | 'push' =>
    x > 0 ? 'won' : x < 0 ? 'lost' : 'push';

  if (sel.market === 'total') {
    if (sel.line == null) throw new Error('total needs a line');
    return cmp(sel.kind === 'over' ? total - sel.line : sel.line - total);
  }
  if (sel.market === 'moneyline3way') {
    const result =
      state.winner ?? (margin > 0 ? 'home' : margin < 0 ? 'away' : 'draw');
    const backed = sel.kind === 'draw' ? 'draw' : sel.side;
    return result === backed ? 'won' : 'lost';
  }
  if (!sel.side) throw new Error(`${sel.market} needs a side`);
  const sideMargin = sel.side === 'home' ? margin : -margin;
  if (sel.market === 'moneyline') {
    // Fights (and anything else) can end in a draw: 2-way moneylines push.
    const winner =
      state.winner ?? (margin > 0 ? 'home' : margin < 0 ? 'away' : 'draw');
    if (winner === 'draw') return 'push';
    return winner === sel.side ? 'won' : 'lost';
  }
  if (sel.line == null) throw new Error('spread needs a line');
  return cmp(sideMargin + sel.line);
}

export interface EvaluateOptions {
  params: ModelParams;
  rng: Rng;
}

/**
 * Evaluate every tracked selection on one event. Selections share one model
 * run (e.g. one MLB simulation per event per poll).
 */
export function evaluateEvent(
  sport: Sport,
  state: GameState,
  prior: Prior,
  selections: ModelSelection[],
  opts: EvaluateOptions
): LegEvaluation[] {
  if (state.status === 'final') {
    return selections.map((sel) => {
      const status = settleSelection(sport, state, sel);
      return {
        // A void leg returns its stake, like a push.
        outcome: certain(status === 'void' ? 'push' : status),
        status,
        model: 'settled',
        inputs: { final: `${state.away.score}-${state.home.score}` },
      };
    });
  }

  switch (sport) {
    case 'nfl':
    case 'ncaaf': {
      const sigmas = opts.params.football[sport];
      const d = footballDistribution(state, prior, sigmas);
      const inputs = {
        marginMean: round(d.marginMean),
        marginSd: round(d.marginSd),
        sigma: round(d.sigma),
        totalMean: round(d.totalMean),
        totalSd: round(d.totalSd),
        possessionEp: round(d.possessionEp),
        fractionRemaining: round(state.fractionRemaining, 3),
      };
      return selections.map((sel) => ({
        outcome: footballProbability(state, prior, sel, sigmas),
        status: 'open',
        model: 'football_normal',
        inputs,
      }));
    }
    case 'mlb': {
      const sim = simulateMlb(state, prior, {
        simulations: opts.params.mlb.simulations,
        rng: opts.rng,
      });
      const rates = runRates(prior);
      const inputs = {
        homeRunsPer9: round(rates.home),
        awayRunsPer9: round(rates.away),
        simulations: sim.n,
      };
      return selections.map((sel) => ({
        outcome: mlbOutcome(sim, sel),
        status: 'open',
        model: 'mlb_monte_carlo',
        inputs,
      }));
    }
    case 'soccer': {
      const rates = goalRates(prior);
      const inputs = {
        homeXg: round(rates.home),
        awayXg: round(rates.away),
        minutesLeft: round(minutesRemaining(state), 1),
      };
      return selections.map((sel) => ({
        outcome: soccerProbability(state, prior, sel),
        status: 'open',
        model: 'soccer_poisson',
        inputs,
      }));
    }
    case 'mma':
      // No usable live state: the prior holds until the fight is final.
      return selections.map((sel) => {
        if (sel.market !== 'moneyline' || !sel.side) {
          throw new Error('mma supports moneyline only');
        }
        return {
          outcome: {
            win: sel.side === 'home' ? prior.homeWin : prior.awayWin,
            push: 0,
          },
          status: 'open',
          model: 'mma_prior',
          inputs: {},
        };
      });
  }
}

const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
