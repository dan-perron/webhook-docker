import type { Market, SelectionKind, Side } from '../domain/types.js';

/** What a leg backs, in model terms (side resolved by event matching). */
export interface ModelSelection {
  market: Market;
  kind: SelectionKind;
  /** Home/away of the backed team (team selections only). */
  side: Side | null;
  /** Spread from the selection's perspective, or the total line. */
  line: number | null;
}

/** Probabilities of a leg's outcomes; loss = 1 - win - push. */
export interface Outcome {
  win: number;
  push: number;
}

export const certain = (r: 'won' | 'lost' | 'push'): Outcome =>
  r === 'won'
    ? { win: 1, push: 0 }
    : r === 'push'
      ? { win: 0, push: 1 }
      : { win: 0, push: 0 };

/**
 * P(Y beats line t) for an integer-valued score Y described by `cdfAt`
 * (P(Y <= y) for half-integer y). Half-point lines can't push; integer lines
 * push when Y == t.
 */
export function beatLine(t: number, cdfAt: (y: number) => number): Outcome {
  if (Number.isInteger(t)) {
    const above = 1 - cdfAt(t + 0.5);
    const push = cdfAt(t + 0.5) - cdfAt(t - 0.5);
    return { win: above, push };
  }
  return { win: 1 - cdfAt(t), push: 0 };
}

export type LegResult = 'won' | 'lost' | 'push';
const cmp = (x: number): LegResult => (x > 0 ? 'won' : x < 0 ? 'lost' : 'push');

/** A selection's result for a final margin (home − away) and total. */
export function legResult(
  sel: ModelSelection,
  margin: number,
  total: number
): LegResult {
  if (sel.market === 'total') {
    if (sel.line == null) throw new Error('total needs a line');
    return cmp(sel.kind === 'over' ? total - sel.line : sel.line - total);
  }
  if (sel.market === 'moneyline3way') {
    const result = margin > 0 ? 'home' : margin < 0 ? 'away' : 'draw';
    return result === (sel.kind === 'draw' ? 'draw' : sel.side)
      ? 'won'
      : 'lost';
  }
  if (!sel.side) throw new Error(`${sel.market} needs a side`);
  const sideMargin = sel.side === 'home' ? margin : -margin;
  if (sel.market === 'moneyline') return cmp(sideMargin); // a tie pushes
  if (sel.line == null) throw new Error('spread needs a line');
  return cmp(sideMargin + sel.line);
}
