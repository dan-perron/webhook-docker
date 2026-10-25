import { GAME_MINUTES } from '../domain/settleTime.js';
import type { LegStatus, Sport } from '../domain/types.js';
import type { JointOutcome } from '../domain/value.js';
import type { SeriesGame, SeriesState } from '../gamestate/types.js';
import { logit, sigmoid } from './stats.js';
import { certain, type ModelSelection, type Outcome } from './types.js';

// Playoff series. Each game is won by the series' home team (the one with
// home field) with a per-game probability: that game's own de-vigged line
// when ESPN has one, else a neutral-site strength shifted by home edge for
// whoever hosts it; a game in progress uses ESPN's live win probability.
// The remaining games are enumerated exactly (a DP over wins), giving the
// distribution of final series results; series_winner and series_spread
// (games won minus games lost) are read off it.

/** Home edge per game, in log-odds (MLB ~54%, NHL ~55%, NBA ~60%). */
export const HOME_EDGE: Partial<Record<Sport, number>> = {
  mlb: 0.16,
  nhl: 0.2,
  nba: 0.4,
  wnba: 0.35,
};

/**
 * Per-game strength of the series' home team: neutral-site log-odds of
 * winning a game, plus each game's own line (P(series home team wins that
 * game)) where one was published.
 */
export interface SeriesStrength {
  source: 'espn_lines' | 'entered_odds' | 'neutral';
  logit: number;
  /** Game id -> P(series home team wins), from that game's moneyline. */
  games?: Record<string, number>;
  detail: string;
}

/** Wins needed to take a best-of-n series. */
export const winsNeeded = (bestOf: number) => Math.floor(bestOf / 2) + 1;

/** Standard home-field games (1-based) when ESPN hasn't listed a game. */
const HOME_GAMES: Record<number, number[]> = {
  7: [1, 2, 5, 7],
  5: [1, 2, 5],
  3: [1, 2, 3],
  1: [1],
};

/** Does the series' home team host game n? */
function hostsGame(s: SeriesState, n: number): boolean {
  const g = s.games.find((x) => x.number === n);
  if (g) return g.homeTeamId === s.home.id;
  return (HOME_GAMES[s.bestOf] ?? [1, 2, 5, 7]).includes(n);
}

/** P(series home team wins game n) before it starts. */
export function gameProbability(
  s: SeriesState,
  strength: SeriesStrength,
  n: number
): number {
  const g = s.games.find((x) => x.number === n);
  const own = g && strength.games?.[g.id];
  if (own != null) return own;
  const edge = HOME_EDGE[s.sport] ?? 0;
  return sigmoid(strength.logit + (hostsGame(s, n) ? edge : -edge));
}

/** P(series home team wins a game in progress), from ESPN's live number. */
function liveProbability(
  s: SeriesState,
  g: SeriesGame,
  strength: SeriesStrength
): number {
  if (g.liveHomeWinProb == null) return gameProbability(s, strength, g.number);
  return g.homeTeamId === s.home.id ? g.liveHomeWinProb : 1 - g.liveHomeWinProb;
}

/** Final series results (home wins, away wins) and their probabilities. */
export type SeriesPmf = Map<string, number>;
export const resultKey = (home: number, away: number) => `${home}-${away}`;

/**
 * Distribution of the final series result from its current state: games
 * already final count as played; the rest are played in order until one
 * team has the wins it needs.
 */
export function seriesPmf(s: SeriesState, strength: SeriesStrength): SeriesPmf {
  const need = winsNeeded(s.bestOf);
  let dist = new Map<string, number>([
    [resultKey(s.home.wins, s.away.wins), 1],
  ]);
  const done = new Map<string, number>();
  const settle = () => {
    for (const [k, p] of dist) {
      const [h, a] = k.split('-').map(Number) as [number, number];
      if (h >= need || a >= need) {
        done.set(k, (done.get(k) ?? 0) + p);
        dist.delete(k);
      }
    }
  };
  settle();
  const played = s.home.wins + s.away.wins;
  for (let n = played + 1; n <= s.bestOf && dist.size; n++) {
    const g = s.games.find((x) => x.number === n);
    const p =
      g?.status === 'in'
        ? liveProbability(s, g, strength)
        : gameProbability(s, strength, n);
    const next = new Map<string, number>();
    for (const [k, q] of dist) {
      const [h, a] = k.split('-').map(Number) as [number, number];
      const win = resultKey(h + 1, a);
      const loss = resultKey(h, a + 1);
      next.set(win, (next.get(win) ?? 0) + q * p);
      next.set(loss, (next.get(loss) ?? 0) + q * (1 - p));
    }
    dist = next;
    settle();
  }
  return done;
}

type SeriesResult = 'won' | 'lost' | 'push';

/** One series leg's result for a final (home wins, away wins). */
export function seriesLegResult(
  sel: ModelSelection,
  home: number,
  away: number
): SeriesResult {
  if (!sel.side) throw new Error(`${sel.market} needs a side`);
  const margin = sel.side === 'home' ? home - away : away - home;
  if (sel.market === 'series_winner') return margin > 0 ? 'won' : 'lost';
  if (sel.market !== 'series_spread' || sel.line == null)
    throw new Error(`not a series selection: ${sel.market}`);
  const x = margin + sel.line;
  return x > 0 ? 'won' : x < 0 ? 'lost' : 'push';
}

/** A series leg's win/push probability from the result distribution. */
export function seriesOutcome(pmf: SeriesPmf, sel: ModelSelection): Outcome {
  let win = 0;
  let push = 0;
  for (const [k, p] of pmf) {
    const [h, a] = k.split('-').map(Number) as [number, number];
    const r = seriesLegResult(sel, h, a);
    if (r === 'won') win += p;
    else if (r === 'push') push += p;
  }
  return { win, push };
}

/** Joint outcome of several legs on one series (non-losing outcomes). */
export function seriesJoint(
  pmf: SeriesPmf,
  sels: ModelSelection[]
): JointOutcome[] {
  const acc = new Map<string, JointOutcome>();
  for (const [k, p] of pmf) {
    const [h, a] = k.split('-').map(Number) as [number, number];
    const pushed: number[] = [];
    let lost = false;
    sels.forEach((sel, i) => {
      const r = seriesLegResult(sel, h, a);
      if (r === 'lost') lost = true;
      else if (r === 'push') pushed.push(i);
    });
    if (lost) continue;
    const key = pushed.join(',');
    const o = acc.get(key);
    if (o) o.p += p;
    else acc.set(key, { p, pushed });
  }
  return [...acc.values()];
}

export interface SeriesEvaluation {
  outcome: Outcome;
  status: LegStatus;
  model: 'series_dp' | 'settled';
  inputs: Record<string, number | string | null>;
}

/** Evaluate legs on one series (settles them once it is decided). */
export function evaluateSeries(
  s: SeriesState,
  strength: SeriesStrength,
  sels: ModelSelection[]
): SeriesEvaluation[] {
  const score = `${s.away.abbr ?? s.away.name} ${s.away.wins}-${s.home.wins} ${s.home.abbr ?? s.home.name}`;
  if (s.status === 'final' && s.winner) {
    return sels.map((sel) => {
      const r = seriesLegResult(sel, s.home.wins, s.away.wins);
      return {
        outcome: certain(r),
        status: r,
        model: 'settled',
        inputs: { series: score },
      };
    });
  }
  const pmf = seriesPmf(s, strength);
  const next = s.games.find((g) => g.number === s.home.wins + s.away.wins + 1);
  const inputs = {
    series: score,
    bestOf: s.bestOf,
    homeGameWin: round(sigmoid(strength.logit + (HOME_EDGE[s.sport] ?? 0))),
    awayGameWin: round(sigmoid(strength.logit - (HOME_EDGE[s.sport] ?? 0))),
    ...(next
      ? {
          nextGame: next.number,
          nextGameHomeTeamWin: round(
            next.status === 'in'
              ? liveProbability(s, next, strength)
              : gameProbability(s, strength, next.number)
          ),
          ...(next.status === 'in' && next.liveHomeWinProb != null
            ? { live: 'ESPN win probability' }
            : {}),
        }
      : {}),
    strength: strength.source,
  };
  return sels.map((sel) => ({
    outcome: seriesOutcome(pmf, sel),
    status: 'open',
    model: 'series_dp',
    inputs,
  }));
}

/**
 * Neutral-site strength (log-odds) whose model prices `sel` at `p` from
 * state `s` (an entered series price, de-vigged). P(sel) is monotone in
 * strength for either side, so bisect.
 */
export function strengthForPrice(
  s: SeriesState,
  sel: ModelSelection,
  p: number
): number {
  const target = Math.min(0.995, Math.max(0.005, p));
  const at = (x: number) => {
    const o = seriesOutcome(
      seriesPmf(s, { source: 'entered_odds', logit: x, detail: '' }),
      sel
    );
    return o.win / Math.max(1e-12, 1 - o.push);
  };
  // Backing home: P rises with strength; backing away: it falls.
  const rising = sel.side === 'home';
  let lo = -4;
  let hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < target === rising) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Strength from one game's de-vigged line: P(series home team wins game n)
 * with the host's edge taken out.
 */
export function strengthFromGame(
  s: SeriesState,
  n: number,
  pSeriesHome: number
): number {
  const edge = HOME_EDGE[s.sport] ?? 0;
  return logit(pSeriesHome) - (hostsGame(s, n) ? edge : -edge);
}

/**
 * The series as it stood at `asOf`: only games over by then count (a game
 * is taken to end GAME_MINUTES after its start).
 */
export function stateAsOf(s: SeriesState, asOf: string): SeriesState {
  const t = new Date(asOf).getTime();
  const length = GAME_MINUTES[s.sport] * 60_000;
  let home = 0;
  let away = 0;
  const games = s.games.map((g) => {
    const endedBefore =
      g.status === 'final' && new Date(g.startTime).getTime() + length <= t;
    if (!endedBefore) return { ...g, status: 'pre' as const };
    if (g.winnerTeamId === s.home.id) home++;
    else if (g.winnerTeamId === s.away.id) away++;
    return g;
  });
  return {
    ...s,
    games,
    home: { ...s.home, wins: home },
    away: { ...s.away, wins: away },
    status: home + away === 0 ? 'pre' : 'in',
    winner: null,
  };
}

const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
