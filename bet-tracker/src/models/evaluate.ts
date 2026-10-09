import type { LegStatus, Sport } from '../domain/types.js';
import type { JointOutcome } from '../domain/value.js';
import type { GameState } from '../gamestate/types.js';
import {
  footballDistribution,
  footballJoint,
  footballProbability,
} from './football.js';
import { mlbScores, runRates } from './mlb.js';
import { nhlScores } from './nhl.js';
import { marginSigmasFor, type ModelParams, type Prior } from './prior.js';
import {
  jointFromScores,
  outcomeFromScores,
  type ScoreDist,
} from './scoreDist.js';
import { minutesRemaining, soccerScores } from './soccer.js';
import { logit, sigmoid } from './stats.js';
import { certain, type ModelSelection, type Outcome } from './types.js';

export type ModelName =
  | 'football_normal'
  | 'basketball_normal'
  | 'mlb_exact'
  | 'nhl_poisson'
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
  /**
   * Per selection: log-odds shift that makes the pregame model match the
   * market's price for that exact line (null = none). Fades linearly with
   * the share of the game left.
   */
  anchors?: (number | null)[];
}

/** The game-state model's distribution for an event (fitted prior). */
type Model =
  | { kind: 'scores'; dist: ScoreDist; name: ModelName; inputs: Inputs }
  | { kind: 'margin'; name: ModelName; inputs: Inputs }
  | { kind: 'prior'; name: ModelName; inputs: Inputs };
type Inputs = Record<string, number | string | null>;

function model(
  sport: Sport,
  state: GameState,
  prior: Prior,
  params: ModelParams
): Model {
  const f = prior.fit ?? {};
  switch (sport) {
    case 'nfl':
    case 'ncaaf':
    case 'wnba': {
      const d = footballDistribution(
        state,
        prior,
        marginSigmasFor(sport, params)
      );
      return {
        kind: 'margin',
        name: sport === 'wnba' ? 'basketball_normal' : 'football_normal',
        inputs: {
          marginMean: round(d.marginMean),
          marginSd: round(d.marginSd),
          sigma: round(d.sigma),
          totalMean: round(d.totalMean),
          totalSd: round(d.totalSd),
          ...(sport === 'wnba' ? {} : { possessionEp: round(d.possessionEp) }),
          fractionRemaining: round(state.fractionRemaining, 3),
        },
      };
    }
    case 'mlb': {
      const fit = {
        total: f.total ?? prior.expectedTotal ?? 8.8,
        share: f.share ?? 0.5,
        dispersion: f.dispersion ?? 1,
      };
      const rates = runRates(fit);
      return {
        kind: 'scores',
        dist: mlbScores(state, fit),
        name: 'mlb_exact',
        inputs: {
          homeRunsPer9: round(rates.home),
          awayRunsPer9: round(rates.away),
          dispersion: round(fit.dispersion),
        },
      };
    }
    case 'nhl': {
      const fit = {
        home: f.home ?? 3,
        away: f.away ?? 3,
        emptyNet: f.emptyNet ?? 1,
      };
      return {
        kind: 'scores',
        dist: nhlScores(state, fit),
        name: 'nhl_poisson',
        inputs: {
          homeGoalsPer60: round(fit.home),
          awayGoalsPer60: round(fit.away),
          emptyNet: round(fit.emptyNet),
        },
      };
    }
    case 'soccer': {
      const fit = { home: f.home ?? 1.3, away: f.away ?? 1.3, rho: f.rho ?? 0 };
      return {
        kind: 'scores',
        dist: soccerScores(state, fit),
        name: 'soccer_poisson',
        inputs: {
          homeXg: round(fit.home),
          awayXg: round(fit.away),
          rho: round(fit.rho),
          minutesLeft: round(minutesRemaining(state), 1),
        },
      };
    }
    case 'mma':
      return { kind: 'prior', name: 'mma_prior', inputs: {} };
    default:
      // Scores-only sports can't be bet on (betInput allows BET_SPORTS).
      throw new Error(`No model for ${sport}`);
  }
}

function rawOutcome(
  m: Model,
  state: GameState,
  prior: Prior,
  sel: ModelSelection,
  params: ModelParams
): Outcome {
  if (m.kind === 'scores') return outcomeFromScores(m.dist, sel);
  if (m.kind === 'margin') {
    return footballProbability(
      state,
      prior,
      sel,
      marginSigmasFor(state.sport as 'nfl' | 'ncaaf' | 'wnba', params)
    );
  }
  // MMA: no usable live state; the prior holds until the fight is final.
  if (sel.market !== 'moneyline' || !sel.side)
    throw new Error('mma supports moneyline only');
  return { win: sel.side === 'home' ? prior.homeWin : prior.awayWin, push: 0 };
}

/** P(win) given no push, for anchoring. */
export const conditionalWin = (o: Outcome) =>
  o.win / Math.max(1e-12, 1 - o.push);

/** Log-odds shift that moves the model's conditional P(win) to the market's. */
export function anchorShift(pregame: Outcome, market: number): number | null {
  const p = conditionalWin(pregame);
  if (!(p > 1e-6 && p < 1 - 1e-6)) return null;
  return Math.max(-4, Math.min(4, logit(market) - logit(p)));
}

/** Apply a shift scaled by the share of the game left; pushes are unchanged. */
export function applyAnchor(
  o: Outcome,
  shift: number,
  fractionRemaining: number
): Outcome {
  if (!shift || fractionRemaining <= 0) return o;
  const cond = sigmoid(
    logit(conditionalWin(o)) + shift * Math.min(1, fractionRemaining)
  );
  return { win: cond * (1 - o.push), push: o.push };
}

/**
 * Evaluate every tracked selection on one event from one model run. The
 * prior must be fitted (models/fit.ts).
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
  const m = model(sport, state, prior, opts.params);
  const f = state.status === 'pre' ? 1 : state.fractionRemaining;
  return selections.map((sel, i) => {
    const shift = opts.anchors?.[i] ?? null;
    const raw = rawOutcome(m, state, prior, sel, opts.params);
    return {
      outcome: shift ? applyAnchor(raw, shift, f) : raw,
      status: 'open',
      model: m.name,
      inputs: shift
        ? { ...m.inputs, marketAnchor: round(shift * Math.min(1, f), 3) }
        : m.inputs,
    };
  });
}

/**
 * Exact joint outcome of several legs on one game (same-game parlays), from
 * the same model; null for sports without one (MMA). Anchors are not applied.
 */
export function jointOutcomes(
  sport: Sport,
  state: GameState,
  prior: Prior,
  sels: ModelSelection[],
  params: ModelParams
): JointOutcome[] | null {
  if (state.status === 'final') return null;
  const m = model(sport, state, prior, params);
  if (m.kind === 'scores') return jointFromScores(m.dist, sels);
  if (m.kind === 'margin')
    return footballJoint(
      state,
      prior,
      sels,
      marginSigmasFor(sport as 'nfl' | 'ncaaf' | 'wnba', params)
    );
  return null;
}

const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
