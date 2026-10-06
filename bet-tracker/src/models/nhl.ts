import type { GameState } from '../gamestate/types.js';
import { condBeat, homeWinProb } from './mlb.js';
import type { Prior } from './prior.js';
import { ScoreDist } from './scoreDist.js';
import { leastSquares, logit } from './stats.js';

// NHL: exact distribution of the final score. Regulation goals are Poisson
// per team over the seconds left, stepped every few seconds over every
// (home, away) score, so rates can depend on the score and clock: a team
// trailing by 1 (or 2) late pulls its goalie, which raises its own scoring
// and adds empty-net goals against. A regulation tie goes to overtime
// (regular season: 5 minutes 3-on-3, then a shootout; playoffs: sudden-death
// 5-on-5). The OT/shootout winner wins by exactly one, and that goal counts
// in the final score and total, as the books settle it.
//
// Fitted pregame to the moneyline, puck line and total: each team's
// regulation goal rate (per 60 minutes) and an empty-net strength.

export interface NhlFit {
  /** Regulation goals per 60 minutes, before empty-net situations. */
  home: number;
  away: number;
  /** Multiplier on the empty-net goal rate (1 = league-typical). */
  emptyNet: number;
}

const REGULATION = 3600;
const STEP = 6;
const CAP = 15;
/** Pull the goalie trailing by 1 with this many seconds left (by 2: PULL_BY_TWO). */
export const PULL_BY_ONE = 150;
export const PULL_BY_TWO = 210;
/** Trailing team's scoring rate x this with the extra attacker. */
export const EXTRA_ATTACKER = 1.5;
/** Empty-net goals per minute for the leading team (x emptyNet). */
export const EMPTY_NET_RATE = 0.1;
/** Regular-season OT: P(a goal in 5 minutes of 3-on-3) ≈ 58% -> combined rate. */
const OT_SECONDS = 300;
const OT_RATE_PER_SEC = -Math.log(1 - 0.58) / OT_SECONDS;
/** Shootouts are close to a coin flip; lean a quarter of the way to the stronger team. */
const SHOOTOUT_LEAN = 0.25;

const isPostseason = (s: GameState) =>
  s.situation?.kind === 'hockey' ? s.situation.postseason : !!s.postseason;

/** Where the game is: regulation seconds left, or OT seconds left, or shootout. */
function phase(s: GameState): {
  regulation: number;
  ot: number;
  shootout: boolean;
} {
  if (s.status !== 'in' || s.situation?.kind !== 'hockey') {
    return { regulation: REGULATION, ot: OT_SECONDS, shootout: false };
  }
  const { period, clock } = s.situation;
  if (period <= 3)
    return {
      regulation: (3 - period) * 1200 + clock,
      ot: OT_SECONDS,
      shootout: false,
    };
  if (isPostseason(s)) return { regulation: 0, ot: Infinity, shootout: false };
  if (period === 4) return { regulation: 0, ot: clock, shootout: false };
  return { regulation: 0, ot: 0, shootout: true };
}

/** Distribution of the final score (incl. any OT/shootout goal) from the current state. */
export function nhlScores(state: GameState, fit: NhlFit): ScoreDist {
  const { regulation, ot, shootout } = phase(state);
  const W = CAP + 1;
  let cur = new Float64Array(W * W);
  cur[Math.min(state.home.score, CAP) * W + Math.min(state.away.score, CAP)] =
    1;
  const base = { home: fit.home / REGULATION, away: fit.away / REGULATION };
  const en = (EMPTY_NET_RATE / 60) * fit.emptyNet;

  // Regulation, stepping down to zero seconds left.
  let left = regulation;
  while (left > 0) {
    const dt = Math.min(STEP, left);
    const next = new Float64Array(W * W);
    for (let h = 0; h <= CAP; h++) {
      for (let a = 0; a <= CAP; a++) {
        const p = cur[h * W + a]!;
        if (p === 0) continue;
        let rh = base.home;
        let ra = base.away;
        const d = h - a;
        const pulled =
          (Math.abs(d) === 1 && left <= PULL_BY_ONE) ||
          (Math.abs(d) === 2 && left <= PULL_BY_TWO);
        if (pulled && d < 0) {
          rh *= EXTRA_ATTACKER;
          ra += en;
        } else if (pulled && d > 0) {
          ra *= EXTRA_ATTACKER;
          rh += en;
        }
        const ph = Math.min(0.5, rh * dt);
        const pa = Math.min(0.5, ra * dt);
        next[Math.min(h + 1, CAP) * W + a]! += p * ph;
        next[h * W + Math.min(a + 1, CAP)]! += p * pa;
        next[h * W + a]! += p * (1 - ph - pa);
      }
    }
    cur = next;
    left -= dt;
  }

  const out = new ScoreDist(CAP);
  const share = fit.home / (fit.home + fit.away);
  const shootoutHome = 0.5 + (share - 0.5) * SHOOTOUT_LEAN;
  // Regular-season OT goal chance for the time left; playoffs always decide in OT.
  const pOtGoal = shootout
    ? 0
    : ot === Infinity
      ? 1
      : 1 - Math.exp(-OT_RATE_PER_SEC * ot);
  for (let h = 0; h <= CAP; h++) {
    for (let a = 0; a <= CAP; a++) {
      const p = cur[h * W + a]!;
      if (p === 0) continue;
      if (h !== a) {
        out.add(h, a, p);
        continue;
      }
      // Tied: OT goal (stronger team more likely), else a shootout.
      const homeWins = pOtGoal * share + (1 - pOtGoal) * shootoutHome;
      out.add(h + 1, a, p * homeWins);
      out.add(h, a + 1, p * (1 - homeWins));
    }
  }
  return out;
}

const pregame: GameState = {
  eventId: 'fit',
  sport: 'nhl',
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
 * Back each team's goal rate out of the de-vigged moneyline and total, and
 * the empty-net strength out of the puck line when it is priced.
 */
export function fitNhl(prior: Prior, postseason = false): NhlFit {
  const spread = prior.spread ?? null;
  const total = prior.totalLine ?? null;
  const goals = total?.line ?? prior.expectedTotal ?? 6;
  // Regulation rates come in a bit under the line (OT/SO and empty-net goals add some).
  const base = Math.max(1, goals - 0.4);
  const start: NhlFit = {
    home: base * prior.homeWin,
    away: base * (1 - prior.homeWin),
    emptyNet: 1,
  };
  const state = { ...pregame, postseason };
  const resid = (f: NhlFit) => {
    const dist = nhlScores(state, f);
    const r = [logit(homeWinProb(dist)) - logit(prior.homeWin)];
    if (spread)
      r.push(logit(condBeat(dist, -spread.line, 'margin')) - logit(spread.p));
    if (total)
      r.push(logit(condBeat(dist, total.line, 'total')) - logit(total.p));
    return r;
  };
  const free: ('home' | 'away' | 'emptyNet')[] = total
    ? ['home', 'away']
    : ['home'];
  if (spread) free.push('emptyNet');
  const bounds = {
    home: { lo: 0.5, hi: 7 },
    away: { lo: 0.5, hi: 7 },
    emptyNet: { lo: 0.2, hi: 4 },
  };
  const make = (v: number[]): NhlFit => {
    const f = {
      ...start,
      ...Object.fromEntries(free.map((k, i) => [k, v[i]!])),
    };
    // Without a total, keep the combined rate and move only the split.
    if (!total) f.away = base - f.home;
    return f;
  };
  const { x } = leastSquares(
    (v) => resid(make(v)),
    free.map((k) => start[k]),
    free.map((k) =>
      k === 'home' && !total ? { lo: 0.05 * base, hi: 0.95 * base } : bounds[k]
    )
  );
  return make(x);
}
