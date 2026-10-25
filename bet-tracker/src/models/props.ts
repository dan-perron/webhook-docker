import type { PropType, SelectionKind, Side } from '../domain/types.js';
import type {
  GameState,
  PlayerStatKey,
  PlayerStatLine,
  PlayerStats,
  TouchdownPlay,
} from '../gamestate/types.js';
import { nameScore, normalizeName } from '../matching/match.js';
import { devigSingle } from '../odds/math.js';
import type { LegEvaluation } from './evaluate.js';
import { certain, type Outcome } from './types.js';

// Player props. There is no player model: a prop's pregame P(win) is its
// own entered price de-vigged with an assumed prop hold. Live, the box score
// and the share of the game left move it; it settles from the final box
// score.
//
// Over/under props (NBA, MLB) share one shape: the final stat is what the
// player has so far plus a count still to come, Poisson or (overdispersed)
// negative binomial with variance = dispersion x mean. The pregame price
// fixes the full-game mean (calibrated so P(over) matches it); live, the
// mean still to come is that rate times the player's remaining opportunity:
// NBA minutes (pace-blended), MLB plate appearances (batters) or outs left
// in his pitch budget (pitchers).

type PropSport = 'nfl' | 'nba' | 'mlb';

/** What a prop type accepts and how it is counted. */
export interface PropSpec {
  /** Shown after the player's name, e.g. "Sam LaPorta anytime TD". */
  label: string;
  sport: PropSport;
  selections: readonly SelectionKind[];
  /** Over/under props need a line; yes/no props take none. */
  line: boolean;
  /** A `yes` selection means over this line (to hit a HR = over 0.5). */
  yesLine?: number;
  /** Label for a `yes` selection, e.g. "to hit a HR". */
  yesLabel?: string;
  /** Box score stats summed into the prop's number. */
  stats?: readonly PlayerStatKey[];
  /** Remaining-count dispersion (variance / mean; 1 = Poisson). */
  dispersion?: number;
  /** MLB: whose box score line (batting or pitching) counts. */
  role?: 'batter' | 'pitcher';
}

export const PROP_SPECS: Record<PropType, PropSpec> = {
  anytime_td: {
    label: 'anytime TD',
    sport: 'nfl',
    selections: ['yes'],
    line: false,
  },
  points: {
    label: 'points',
    sport: 'nba',
    selections: ['over', 'under'],
    line: true,
    stats: ['points'],
    dispersion: 2.2,
  },
  rebounds: {
    label: 'rebounds',
    sport: 'nba',
    selections: ['over', 'under'],
    line: true,
    stats: ['rebounds'],
    dispersion: 1.3,
  },
  assists: {
    label: 'assists',
    sport: 'nba',
    selections: ['over', 'under'],
    line: true,
    stats: ['assists'],
    dispersion: 1.2,
  },
  threes: {
    label: 'threes',
    sport: 'nba',
    selections: ['over', 'under'],
    line: true,
    stats: ['threePointFieldGoalsMade'],
    dispersion: 1.1,
  },
  pra: {
    label: 'pts+reb+ast',
    sport: 'nba',
    selections: ['over', 'under'],
    line: true,
    stats: ['points', 'rebounds', 'assists'],
    dispersion: 2.1,
  },
  home_runs: {
    label: 'home runs',
    sport: 'mlb',
    selections: ['over', 'under', 'yes'],
    line: true,
    yesLine: 0.5,
    yesLabel: 'to hit a HR',
    stats: ['homeRuns'],
    dispersion: 1,
    role: 'batter',
  },
  total_bases: {
    label: 'total bases',
    sport: 'mlb',
    selections: ['over', 'under'],
    line: true,
    stats: ['totalBases'],
    // Hits come in lumps of 1-4 bases.
    dispersion: 2.2,
    role: 'batter',
  },
  hits: {
    label: 'hits',
    sport: 'mlb',
    selections: ['over', 'under'],
    line: true,
    stats: ['hits'],
    dispersion: 1,
    role: 'batter',
  },
  pitcher_strikeouts: {
    label: 'strikeouts',
    sport: 'mlb',
    selections: ['over', 'under'],
    line: true,
    stats: ['pitchingStrikeouts'],
    dispersion: 1,
    role: 'pitcher',
  },
  pitcher_outs: {
    label: 'outs recorded',
    sport: 'mlb',
    selections: ['over', 'under'],
    line: true,
    stats: ['pitchingOuts'],
    dispersion: 1,
    role: 'pitcher',
  },
};

/** Prop types offered for a sport. */
export const propTypesFor = (sport: string): PropType[] =>
  (Object.keys(PROP_SPECS) as PropType[]).filter(
    (t) => PROP_SPECS[t].sport === sport
  );

export interface PropParams {
  /**
   * Assumed hold on an anytime TD price (books don't post the "no" side):
   * one rate up to +200, another for longer prices, where it runs higher.
   */
  anytimeTdHold: { upTo200: number; above200: number };
  /** Assumed two-way hold on an over/under prop price (and to hit a HR). */
  overUnderHold: { upTo200: number; above200: number };
  nba: {
    /** Minutes a player is assumed to play (before he has any). */
    expectedMinutes: number;
    /** Weight of the pregame rate vs his pace so far, in games. */
    priorWeight: number;
  };
  mlb: {
    /** Pitches a starter is assumed to throw (strikeout props). */
    pitchBudget: number;
    pitchesPerOut: number;
    /** Share of plate appearances that end in an out. */
    outRate: number;
    /** Weight of the pregame strikeout rate vs his pace, in starts. */
    priorWeight: number;
  };
}

export const DEFAULT_PROP_PARAMS: PropParams = {
  anytimeTdHold: { upTo200: 0.08, above200: 0.15 },
  overUnderHold: { upTo200: 0.07, above200: 0.12 },
  nba: { expectedMinutes: 32, priorWeight: 0.5 },
  mlb: { pitchBudget: 90, pitchesPerOut: 5.6, outRate: 0.7, priorWeight: 0.5 },
};

const withDefaults = (p?: Partial<PropParams>): PropParams => ({
  ...DEFAULT_PROP_PARAMS,
  ...p,
});

/** The hold assumed when de-vigging a prop's entered price. */
export function propHold(
  type: PropType,
  price: number,
  params?: Partial<PropParams>
): number {
  const p = withDefaults(params);
  const tiers = type === 'anytime_td' ? p.anytimeTdHold : p.overUnderHold;
  return price <= 200 ? tiers.upTo200 : tiers.above200;
}

/** Pregame P(win) of a prop: its entered price, de-vigged. */
export function propPregame(
  type: PropType,
  price: number,
  params?: Partial<PropParams>
): { p: number; hold: number } {
  const hold = propHold(type, price, params);
  return { p: devigSingle(price, hold), hold };
}

/** Name key: case, accents, punctuation and Jr./III suffixes ignored. */
export function playerKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’-]/g, '')
    .split(/\s+/)
    .filter((t) => t && !/^(jr|sr|ii|iii|iv|v)$/.test(t))
    .join(' ');
}

/**
 * The box score's team name and the event's can differ in small ways (MLB
 * events come from the Stats API, box scores from ESPN).
 */
const sameTeam = (a: string, b: string) =>
  normalizeName(a) === normalizeName(b) || nameScore(a, [b]) >= 0.85;

/** A player's box score lines (several categories can name him). */
function playerLines(
  stats: PlayerStats,
  player: string,
  team: string | null
): PlayerStatLine[] {
  const key = playerKey(player);
  return stats.players.filter(
    (l) => playerKey(l.name) === key && (!team || sameTeam(l.team, team))
  );
}

export interface PlayerTouchdowns {
  /** Rushing + receiving + return/defensive TDs (passing TDs don't count). */
  count: number;
  /** The player has a box score line or a scoring play (he played). */
  found: boolean;
  plays: TouchdownPlay[];
}

/** Non-passing TDs from a box score line. */
function boxTouchdowns(l: PlayerStatLine): number {
  const s = l.stats;
  return (
    (s.rushingTouchdowns ?? 0) +
    (s.receivingTouchdowns ?? 0) +
    (s.kickReturnTouchdowns ?? 0) +
    (s.puntReturnTouchdowns ?? 0) +
    // Interception return TDs are also defensive TDs.
    Math.max(s.defensiveTouchdowns ?? 0, s.interceptionTouchdowns ?? 0)
  );
}

/**
 * A player's touchdowns: the larger of the box score count and the scoring
 * plays crediting him (each catches what the other misses, e.g. a fumble
 * recovery in the end zone).
 */
export function playerTouchdowns(
  stats: PlayerStats,
  player: string,
  team: string | null
): PlayerTouchdowns {
  const key = playerKey(player);
  const lines = playerLines(stats, player, team);
  const plays = stats.touchdowns.filter(
    (t) =>
      t.scorer != null &&
      playerKey(t.scorer) === key &&
      (!team || !t.team || sameTeam(t.team, team))
  );
  const box = lines.reduce((n, l) => n + boxTouchdowns(l), 0);
  return {
    count: Math.max(box, plays.length),
    found: lines.length > 0 || plays.length > 0,
    plays,
  };
}

export interface PropLeg {
  propType: PropType;
  player: string;
  /** The player's team (full name as the event names it), if known. */
  team: string | null;
  /** Home/away of the player's team (MLB batters: when his team bats). */
  side?: Side | null;
  kind: SelectionKind;
  line: number | null;
}

/**
 * One prop leg now. `pregame` is its pregame P(win) (propPregame). Without
 * a box score (pregame, or the provider has none yet) the pregame value
 * carries forward.
 */
export function evaluateProp(
  leg: PropLeg,
  state: GameState,
  stats: PlayerStats | null,
  pregame: number,
  params?: Partial<PropParams>
): LegEvaluation {
  if (state.cancelled) {
    return {
      outcome: certain('push'),
      status: 'void',
      model: 'settled',
      inputs: { result: 'game cancelled' },
    };
  }
  if (state.status === 'pre' || !stats) {
    return {
      outcome: { win: pregame, push: 0 },
      status: 'open',
      model: 'prop_pregame',
      inputs: {
        pregame: round(pregame),
        ...(state.status === 'pre' ? {} : { note: 'no box score yet' }),
      },
    };
  }
  if (leg.propType === 'anytime_td')
    return anytimeTd(leg, state, stats, pregame);
  return overUnderProp(leg, state, stats, pregame, withDefaults(params));
}

/**
 * Anytime TD: touchdowns arrive as a Poisson process over game time, with
 * the rate the pregame P(win) implies, P = 1 - e^-λ, so with a share f of
 * the game left and no TD yet P = 1 - (1 - pregame)^f. One TD wins.
 */
function anytimeTd(
  leg: PropLeg,
  state: GameState,
  stats: PlayerStats,
  pregame: number
): LegEvaluation {
  const td = playerTouchdowns(stats, leg.player, leg.team);
  const plays = td.plays.map((p) =>
    `Q${p.period ?? '?'} ${p.clock ?? ''} ${p.type}`.replace(/\s+/g, ' ')
  );
  const inputs = {
    touchdowns: td.count,
    ...(plays.length ? { plays: plays.join('; ') } : {}),
    pregame: round(pregame),
  };
  if (state.status === 'final' && stats.final) {
    if (td.count > 0)
      return {
        outcome: certain('won'),
        status: 'won',
        model: 'settled',
        inputs,
      };
    if (td.found)
      return {
        outcome: certain('lost'),
        status: 'lost',
        model: 'settled',
        inputs,
      };
    return unverified(inputs);
  }
  if (td.count > 0)
    return {
      outcome: certain('won'),
      status: 'open',
      model: 'prop_live',
      inputs,
    };
  const f = Math.max(0, Math.min(1, state.fractionRemaining));
  return {
    outcome: { win: 1 - (1 - pregame) ** f, push: 0 },
    status: 'open',
    model: 'prop_live',
    inputs: { ...inputs, fractionRemaining: round(f, 3) },
  };
}

/** No line at all in the final box score: he may not have played. */
function unverified(
  inputs: Record<string, number | string | null>,
  note = 'player not in the final box score: settle by hand (void if inactive)'
): LegEvaluation {
  return {
    outcome: { win: 0, push: 0 },
    status: 'open',
    model: 'prop_unverified',
    inputs: { ...inputs, note },
  };
}

// --- Count distributions ------------------------------------------------------

/**
 * P(Y = k), k = 0..n, for a count with this mean and variance = dispersion
 * x mean: Poisson at dispersion 1, else negative binomial (r = mean /
 * (dispersion - 1), success probability 1 / dispersion). The tail beyond
 * the returned length is below 1e-12.
 */
export function countPmf(mean: number, dispersion = 1): number[] {
  if (!(mean > 0)) return [1];
  const out: number[] = [];
  let cum = 0;
  let k = 0;
  if (dispersion <= 1 + 1e-9) {
    let p = Math.exp(-mean);
    for (; cum < 1 - 1e-12 && k < 2000; k++) {
      if (k > 0) p *= mean / k;
      out.push(p);
      cum += p;
    }
    return out;
  }
  const r = mean / (dispersion - 1);
  const q = 1 - 1 / dispersion;
  let p = dispersion ** -r;
  for (; cum < 1 - 1e-12 && k < 5000; k++) {
    if (k > 0) p *= ((k - 1 + r) / k) * q;
    out.push(p);
    cum += p;
  }
  return out;
}

/** P(Y <= x) from a pmf (x may be fractional or negative). */
function cdfAt(pmf: number[], x: number): number {
  const k = Math.floor(x + 1e-9);
  if (k < 0) return 0;
  let s = 0;
  for (let i = 0; i <= k && i < pmf.length; i++) s += pmf[i]!;
  return Math.min(1, s);
}

/**
 * Over/under `line` for a final stat = `current` + a count still to come
 * (its pmf). Integer lines push when the final lands on them.
 */
export function overUnderOutcome(
  kind: 'over' | 'under',
  line: number,
  current: number,
  rest: number[]
): Outcome {
  const need = line - current;
  const onLine = Number.isInteger(need) && need >= 0 ? (rest[need] ?? 0) : 0;
  // P(rest < need) and P(rest > need).
  const below = need <= 0 ? 0 : cdfAt(rest, Math.ceil(need) - 1);
  const above = Math.max(0, 1 - below - onLine);
  return kind === 'over'
    ? { win: above, push: onLine }
    : { win: below, push: onLine };
}

/**
 * The full-game mean whose count beats `line` over with probability `pOver`
 * given no push (what a de-vigged over price says).
 */
export function calibrateMean(
  line: number,
  pOver: number,
  dispersion: number
): number {
  const target = Math.min(0.999, Math.max(0.001, pOver));
  const over = (mu: number) => {
    const o = overUnderOutcome('over', line, 0, countPmf(mu, dispersion));
    return o.win / Math.max(1e-12, 1 - o.push);
  };
  let lo = 1e-4;
  let hi = Math.max(5, line * 4 + 10);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (over(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// --- Over/under props (NBA, MLB) -----------------------------------------------

/** The selection as an over/under (yes = over the spec's yes line). */
function asOverUnder(leg: PropLeg): { kind: 'over' | 'under'; line: number } {
  const spec = PROP_SPECS[leg.propType];
  if (leg.kind === 'yes')
    return { kind: 'over', line: leg.line ?? spec.yesLine ?? 0.5 };
  return { kind: leg.kind === 'under' ? 'under' : 'over', line: leg.line! };
}

/** What is still to come for the player: mean, and whether he is done. */
interface Remaining {
  mean: number;
  /** He is out of the game (pulled, subbed out, ejected): the stat is final. */
  done: boolean;
  inputs: Record<string, number | string | null>;
}

function overUnderProp(
  leg: PropLeg,
  state: GameState,
  stats: PlayerStats,
  pregame: number,
  params: PropParams
): LegEvaluation {
  const spec = PROP_SPECS[leg.propType];
  const { kind, line } = asOverUnder(leg);
  const lines = playerLines(stats, leg.player, leg.team).filter((l) =>
    spec.role === 'pitcher'
      ? l.stats.pitchingOuts != null
      : spec.role === 'batter'
        ? l.stats.plateAppearances != null || l.stats.atBats != null
        : true
  );
  const current = statTotal(lines, spec.stats!);
  const pOver = kind === 'over' ? pregame : 1 - pregame;
  const fullMean = calibrateMean(line, pOver, spec.dispersion!);
  const base = {
    [spec.label]: current,
    line,
    pregame: round(pregame),
    pregameMean: round(fullMean, 2),
  };

  if (state.status === 'final' && stats.final) {
    const line0 = lines[0];
    if (!line0) return unverified(base);
    if (spec.sport === 'nba' && !(line0.stats.minutes! > 0))
      return unverified(
        base,
        'did not play: settle by hand (void at most books)'
      );
    const r = settle(kind, line, current);
    return {
      outcome: certain(r),
      status: r,
      model: 'settled',
      inputs: base,
    };
  }

  const rest: Remaining | null = !lines.length
    ? null
    : spec.sport === 'nba'
      ? nbaRemaining(lines[0]!, state, fullMean, current, params)
      : spec.role === 'pitcher'
        ? pitcherRemaining(lines[0]!, state, leg, fullMean, params)
        : batterRemaining(lines[0]!, stats, state, leg, fullMean, params);
  if (!rest) {
    // Not in the box score yet (hasn't checked in / batted): the pregame
    // mean is still all to come.
    const o = overUnderOutcome(
      kind,
      line,
      0,
      countPmf(fullMean, spec.dispersion)
    );
    return {
      outcome: o,
      status: 'open',
      model: 'prop_live',
      inputs: { ...base, note: 'not in the box score yet' },
    };
  }
  const o = overUnderOutcome(
    kind,
    line,
    current,
    countPmf(rest.done ? 0 : rest.mean, spec.dispersion)
  );
  return {
    outcome: o,
    status: 'open',
    model: 'prop_live',
    inputs: {
      ...base,
      ...rest.inputs,
      remainingMean: round(rest.done ? 0 : rest.mean, 3),
      ...(rest.done ? { note: 'out of the game: stat is final' } : {}),
    },
  };
}

const settle = (
  kind: 'over' | 'under',
  line: number,
  x: number
): 'won' | 'lost' | 'push' => {
  const d = kind === 'over' ? x - line : line - x;
  return d > 0 ? 'won' : d < 0 ? 'lost' : 'push';
};

function statTotal(
  lines: PlayerStatLine[],
  keys: readonly PlayerStatKey[]
): number {
  // A player appears once per category; take each stat's largest value.
  return keys.reduce(
    (sum, k) => sum + Math.max(0, ...lines.map((l) => l.stats[k] ?? 0)),
    0
  );
}

// --- NBA: minutes and pace -----------------------------------------------------

const NBA_QUARTER_MIN = 12;
const NBA_OT_MIN = 5;

/** Game minutes played and still to play (the current overtime only). */
export function nbaGameMinutes(state: GameState): {
  elapsed: number;
  remaining: number;
} {
  const p = state.period ?? 1;
  const clock = (state.clockSeconds ?? 0) / 60;
  if (p <= 4) {
    const remaining = (4 - p) * NBA_QUARTER_MIN + clock;
    return { elapsed: 4 * NBA_QUARTER_MIN - remaining, remaining };
  }
  return {
    elapsed: 4 * NBA_QUARTER_MIN + (p - 5) * NBA_OT_MIN + (NBA_OT_MIN - clock),
    remaining: clock,
  };
}

/**
 * NBA: his share of the minutes left and his rate per minute, each blended
 * with the pregame expectation (weight w games):
 *   share = (min + M w) / (elapsed + 48 w)
 *   rate  = (stat + μ w) / (min + M w)
 *   still to come = rate x share x game minutes left
 * which at tip-off is exactly the pregame mean μ.
 */
function nbaRemaining(
  line: PlayerStatLine,
  state: GameState,
  fullMean: number,
  current: number,
  params: PropParams
): Remaining {
  const { expectedMinutes: M, priorWeight: w } = params.nba;
  const g = nbaGameMinutes(state);
  const min = line.stats.minutes ?? 0;
  const share = (min + M * w) / (g.elapsed + 4 * NBA_QUARTER_MIN * w);
  const rate = (current + fullMean * w) / (min + M * w);
  const done = !!line.ejected;
  return {
    mean: rate * Math.min(1, share) * g.remaining,
    done,
    inputs: {
      minutes: min,
      gameMinutesLeft: round(g.remaining, 2),
      ...(done ? { ejected: 'yes' } : {}),
    },
  };
}

// --- MLB: plate appearances and pitch budget --------------------------------------

/**
 * Outs the team still makes at the plate this game (regulation; the home
 * team is assumed to bat in the 9th, and extra innings give whoever bats
 * now only the rest of this half).
 */
export function teamOutsLeft(state: GameState, side: Side): number {
  const sit = state.situation;
  if (sit?.kind !== 'baseball') return 0;
  const S = sit.scheduledInnings;
  const batting = (sit.half === 'top' ? 'away' : 'home') === side;
  const later = Math.max(0, S - sit.inning) * 3;
  if (batting) return 3 - sit.outs + later;
  // Not batting: the home team still bats this inning (bottom half).
  return side === 'home' && sit.inning <= S ? later + 3 : later;
}

/**
 * Expected plate appearances for the batter `d` spots after the next one
 * due up, with the team making `outs` more outs: each PA is an out with
 * probability `outRate`, so the team's remaining PAs are T = outs + F with
 * F ~ NegBin(outs, outRate), and he bats on PAs d, d + 9, d + 18, ...:
 *   E = Σ_n P(T > d + 9n)
 */
export function expectedPlateAppearances(
  outs: number,
  d: number,
  outRate: number
): number {
  if (outs <= 0) return 0;
  // Non-outs before the last out: mean outs (1 - p) / p, dispersion 1 / p.
  const pmf = countPmf((outs * (1 - outRate)) / outRate, 1 / outRate);
  let e = 0;
  for (let k = d; ; k += 9) {
    const pAbove = k < outs ? 1 : 1 - cdfAt(pmf, k - outs);
    if (pAbove < 1e-9) break;
    e += pAbove;
  }
  return e;
}

/**
 * MLB batter: per-PA rate = pregame mean / his pregame expected PAs (from
 * his lineup spot); still to come = rate x expected PAs left. A batter
 * replaced in the lineup is done.
 */
function batterRemaining(
  line: PlayerStatLine,
  stats: PlayerStats,
  state: GameState,
  leg: PropLeg,
  fullMean: number,
  params: PropParams
): Remaining | null {
  const spot = line.batOrder;
  if (!spot || !leg.side) return null;
  const { outRate } = params.mlb;
  // Team PAs so far put the next batter due at spot (PAs mod 9) + 1.
  const teamPa = stats.players
    .filter((l) => l.team === line.team && l.batOrder)
    .reduce((n, l) => n + (l.stats.plateAppearances ?? 0), 0);
  const d = (spot - 1 - (teamPa % 9) + 9) % 9;
  const outs = teamOutsLeft(state, leg.side);
  const paLeft = expectedPlateAppearances(outs, d, outRate);
  const paFull = expectedPlateAppearances(27, spot - 1, outRate);
  const done = line.active === false;
  return {
    mean: (fullMean / paFull) * paLeft,
    done,
    inputs: {
      plateAppearances: line.stats.plateAppearances ?? null,
      lineupSpot: spot,
      teamOutsLeft: outs,
      expectedPaLeft: round(paLeft, 3),
      ...(done ? { removed: 'yes' } : {}),
    },
  };
}

/**
 * MLB pitcher: outs left = what is left of his pitch budget (pregame outs
 * mean x pitches per out for an outs prop, else the default budget), capped
 * by the outs left in regulation for his defense; strikeouts come at his
 * rate per out, blended with his pace (weight w starts). Pulled = done.
 */
function pitcherRemaining(
  line: PlayerStatLine,
  state: GameState,
  leg: PropLeg,
  fullMean: number,
  params: PropParams
): Remaining {
  const { pitchBudget, pitchesPerOut, priorWeight: w } = params.mlb;
  const outs = line.stats.pitchingOuts ?? 0;
  const pitches = line.stats.pitches ?? 0;
  const isOuts = leg.propType === 'pitcher_outs';
  const fullOuts = isOuts ? fullMean : pitchBudget / pitchesPerOut;
  const budget = fullOuts * pitchesPerOut;
  // His defense is in the field when the other team bats.
  const defense: Side | null = leg.side ?? null;
  const fieldOuts = defense
    ? teamOutsLeft(state, defense === 'home' ? 'away' : 'home')
    : 27;
  const outsLeft = Math.min(
    Math.max(0, budget - pitches) / pitchesPerOut,
    fieldOuts
  );
  const done = line.pitchingActive === false;
  const kRate = isOuts
    ? 1
    : ((line.stats.pitchingStrikeouts ?? 0) + fullMean * w) /
      (outs + fullOuts * w);
  return {
    mean: kRate * outsLeft,
    done,
    inputs: {
      pitches,
      outs,
      expectedOutsLeft: round(outsLeft, 3),
      ...(isOuts ? {} : { strikeoutsPerOut: round(kRate, 4) }),
      ...(done ? { pulled: 'yes' } : {}),
    },
  };
}

const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
