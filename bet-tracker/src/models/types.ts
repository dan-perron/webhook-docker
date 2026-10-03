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
