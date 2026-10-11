import type { PropType, SelectionKind } from '../domain/types.js';
import type {
  GameState,
  PlayerStatLine,
  PlayerStats,
  TouchdownPlay,
} from '../gamestate/types.js';
import { devigSingle } from '../odds/math.js';
import type { LegEvaluation } from './evaluate.js';
import { certain } from './types.js';

// Player props. There is no player model: a prop's pregame P(win) is its
// own entered price de-vigged with an assumed prop hold. Live, the box score
// (touchdowns so far) and the share of the game left move it; it settles from
// the final box score.

/** What a prop type accepts. Add first_td, 2plus_td, yardage here. */
export interface PropSpec {
  /** Shown after the player's name, e.g. "Sam LaPorta anytime TD". */
  label: string;
  selections: readonly SelectionKind[];
  /** Over/under props need a line; yes/no props take none. */
  line: boolean;
}

export const PROP_SPECS: Record<PropType, PropSpec> = {
  anytime_td: { label: 'anytime TD', selections: ['yes'], line: false },
};

export interface PropParams {
  /**
   * Assumed hold on an anytime TD price (books don't post the "no" side):
   * one rate up to +200, another for longer prices, where it runs higher.
   */
  anytimeTdHold: { upTo200: number; above200: number };
}

export const DEFAULT_PROP_PARAMS: PropParams = {
  anytimeTdHold: { upTo200: 0.08, above200: 0.15 },
};

/** The hold assumed when de-vigging a prop's entered price. */
export function propHold(
  type: PropType,
  price: number,
  params: PropParams = DEFAULT_PROP_PARAMS
): number {
  switch (type) {
    case 'anytime_td':
      return price <= 200
        ? params.anytimeTdHold.upTo200
        : params.anytimeTdHold.above200;
  }
}

/** Pregame P(win) of a prop: its entered price, de-vigged. */
export function propPregame(
  type: PropType,
  price: number,
  params: PropParams = DEFAULT_PROP_PARAMS
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
  const lines = stats.players.filter(
    (l) => playerKey(l.name) === key && (!team || l.team === team)
  );
  const plays = stats.touchdowns.filter(
    (t) =>
      t.scorer != null &&
      playerKey(t.scorer) === key &&
      (!team || !t.team || t.team === team)
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
  pregame: number
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
  switch (leg.propType) {
    case 'anytime_td':
      return anytimeTd(leg, state, stats, pregame);
  }
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
    // No line at all: he may not have played (void at most books).
    return {
      outcome: { win: 0, push: 0 },
      status: 'open',
      model: 'prop_unverified',
      inputs: {
        ...inputs,
        note: 'player not in the final box score: settle by hand (void if inactive)',
      },
    };
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

const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;
