import type { BaseballSituation, GameState } from '../gamestate/types.js';
import type { Prior } from './prior.js';
import { ScoreDist } from './scoreDist.js';
import { leastSquares, logit, poissonPmf } from './stats.js';
import { beatLine } from './types.js';

// MLB: exact distribution of the final score, carried half-inning by
// half-inning over every (home runs, away runs) pair. The current
// half-inning finishes from its base/out state (RE24-style tables); later
// ones start clean. Extras are played out (regular-season runner on 2nd),
// the home team skips the bottom of the 9th+ when ahead, and walk-offs end
// the game one run ahead.
//
// Three parameters, fitted pregame to the moneyline, run line and total:
// expected total runs, the home share of them, and a dispersion that trades
// how often an inning scores against how big the innings are (same mean).

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

/** Pythagenpat-style exponent: the starting point for the run share. */
const PYTH_EXPONENT = 1.83;
const MAX_INNINGS = 30;
/** Runs per team tracked; mass beyond is folded into the cap (negligible). */
const CAP = 30;
const MAX_INNING_RUNS = 20;

export interface MlbFit {
  /** Expected total runs over nine innings. */
  total: number;
  /** Home team's share of them. */
  share: number;
  /** 1 = league-typical innings; < 1 fewer, bigger innings (more variance). */
  dispersion: number;
}

export const basesMask = (
  s: Pick<BaseballSituation, 'first' | 'second' | 'third'>
) => (s.first ? 1 : 0) | (s.second ? 2 : 0) | (s.third ? 4 : 0);

/**
 * Runs from a base/out state to the end of the half-inning, for a team
 * scoring `scale` x league average: score at all with the table probability
 * (adjusted by `dispersion`), then 1 + Poisson, keeping the table's mean.
 */
export function halfInningPmf(
  outs: number,
  bases: number,
  scale: number,
  dispersion = 1
): number[] {
  const mean = RE24[outs]![bases]! * scale;
  const p0 = 1 - Math.pow(1 - P_SCORE[outs]![bases]!, scale);
  const p = Math.min(0.999, mean, Math.max(0.005, p0 * dispersion));
  const rest = poissonPmf(Math.max(0, mean / p - 1), MAX_INNING_RUNS - 1);
  return [1 - p, ...rest.map((q) => p * q)];
}

/** Pythagorean starting point for the home share of runs. */
export function pythagShare(homeWin: number): number {
  const h = Math.pow(homeWin, 1 / PYTH_EXPONENT);
  const a = Math.pow(1 - homeWin, 1 / PYTH_EXPONENT);
  return h / (h + a);
}

/** Runs per nine innings for each team. */
export function runRates(fit: MlbFit): { home: number; away: number } {
  return { home: fit.total * fit.share, away: fit.total * (1 - fit.share) };
}

/** Distribution of the final score from the current state. */
export function mlbScores(state: GameState, fit: MlbFit): ScoreDist {
  const rates = runRates(fit);
  const scale = {
    home: rates.home / 9 / LEAGUE_RUNS_PER_INNING,
    away: rates.away / 9 / LEAGUE_RUNS_PER_INNING,
  };
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
  const d = fit.dispersion;
  const fresh = {
    home: halfInningPmf(0, 0, scale.home, d),
    away: halfInningPmf(0, 0, scale.away, d),
  };
  const ghost = {
    home: halfInningPmf(0, 2, scale.home, d),
    away: halfInningPmf(0, 2, scale.away, d),
  };

  const W = CAP + 1;
  let cur = new Float64Array(W * W);
  cur[Math.min(state.home.score, CAP) * W + Math.min(state.away.score, CAP)] =
    1;
  const out = new ScoreDist(CAP);
  let inning = sit.inning;
  let half = sit.half;
  let first = true;

  for (;;) {
    // Game-over rules before a half-inning starts.
    for (let h = 0; h <= CAP; h++) {
      for (let a = 0; a <= CAP; a++) {
        const p = cur[h * W + a]!;
        if (p === 0) continue;
        const homeAhead = half === 'bottom' && inning >= scheduled && h > a;
        const decided = half === 'top' && inning > scheduled && h !== a;
        if (homeAhead || decided) {
          out.add(h, a, p);
          cur[h * W + a] = 0;
        }
      }
    }
    let mass = 0;
    for (const p of cur) mass += p;
    if (mass < 1e-12) break;
    if (inning > MAX_INNINGS) {
      // Still tied after 30 innings: call it a coin flip.
      for (let h = 0; h <= CAP; h++) {
        for (let a = 0; a <= CAP; a++) {
          const p = cur[h * W + a]!;
          if (p > 0) {
            out.add(Math.min(h + 1, CAP), a, p / 2);
            out.add(h, Math.min(a + 1, CAP), p / 2);
          }
        }
      }
      break;
    }

    const team = half === 'top' ? 'away' : 'home';
    const extra = inning > scheduled && sit.extraInningRunner;
    const pmf = first
      ? halfInningPmf(sit.outs, basesMask(sit), scale[team], d)
      : extra
        ? ghost[team]
        : fresh[team];
    const next = new Float64Array(W * W);
    for (let h = 0; h <= CAP; h++) {
      for (let a = 0; a <= CAP; a++) {
        const p = cur[h * W + a]!;
        if (p === 0) continue;
        for (let r = 0; r < pmf.length; r++) {
          const q = p * pmf[r]!;
          if (q === 0) continue;
          if (team === 'away') {
            next[h * W + Math.min(a + r, CAP)]! += q;
          } else if (inning >= scheduled && h + r > a) {
            // Walk-off: the game ends when the winning run scores.
            out.add(Math.min(a + 1, CAP), a, q);
          } else {
            next[Math.min(h + r, CAP) * W + a]! += q;
          }
        }
      }
    }
    cur = next;
    first = false;
    if (half === 'top') half = 'bottom';
    else {
      half = 'top';
      inning++;
    }
  }
  return out;
}

// --- Fitting ------------------------------------------------------------------

const pregame: GameState = {
  eventId: 'fit',
  sport: 'mlb',
  status: 'pre',
  cancelled: false,
  startTime: '',
  home: { name: 'home', abbr: null, score: 0 },
  away: { name: 'away', abbr: null, score: 0 },
  period: null,
  clockSeconds: null,
  detail: '',
  fractionRemaining: 1,
  situation: null,
  winner: null,
  providerWinProb: null,
  fetchedAt: '',
};

/**
 * P(the margin, or the total, beats t | not a push) from a score
 * distribution; `sign` -1 reads the margin from the away side.
 */
export function condBeat(
  dist: ScoreDist,
  t: number,
  of: 'margin' | 'total',
  sign = 1
): number {
  const cdfAt = (y: number) => {
    let c = 0;
    for (const [h, a, p] of dist.cells())
      if (sign * (of === 'margin' ? h - a : h + a) <= y) c += p;
    return c;
  };
  const o = beatLine(t, cdfAt);
  return o.win / Math.max(1e-12, 1 - o.push);
}

export function homeWinProb(dist: ScoreDist): number {
  let w = 0;
  for (const [h, a, p] of dist.cells()) if (h > a) w += p;
  return w;
}

/**
 * Fit total, share and dispersion so the pregame model prices the
 * moneyline, the main run line and the main total at the market's fair
 * probabilities. Without a run-line price the dispersion stays at 1;
 * without a total price the total is the line.
 */
export function fitMlb(prior: Prior): MlbFit {
  const spread = prior.spread ?? null;
  const total = prior.totalLine ?? null;
  const baseTotal = total?.line ?? prior.expectedTotal ?? 8.8;
  const start: MlbFit = {
    total: baseTotal,
    share: pythagShare(prior.homeWin),
    dispersion: 1,
  };
  const resid = (f: MlbFit) => {
    const dist = mlbScores(pregame, f);
    const r = [logit(homeWinProb(dist)) - logit(prior.homeWin)];
    // Home covers when margin + home line > 0, i.e. margin beats -line.
    if (spread)
      r.push(logit(condBeat(dist, -spread.line, 'margin')) - logit(spread.p));
    if (total)
      r.push(logit(condBeat(dist, total.line, 'total')) - logit(total.p));
    return r;
  };
  const free: ('total' | 'share' | 'dispersion')[] = ['share'];
  if (total) free.push('total');
  if (spread) free.push('dispersion');
  const bounds = {
    total: { lo: 3, hi: 20 },
    share: { lo: 0.15, hi: 0.85 },
    dispersion: { lo: 0.5, hi: 1.75 },
  };
  const { x } = leastSquares(
    (v) =>
      resid({
        ...start,
        ...Object.fromEntries(free.map((k, i) => [k, v[i]!])),
      }),
    free.map((k) => start[k]),
    free.map((k) => bounds[k])
  );
  return { ...start, ...Object.fromEntries(free.map((k, i) => [k, x[i]!])) };
}
