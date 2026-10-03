import type { BetRow, LegRow } from '../db/schema.js';
import { valueBet, type BetValuation } from '../domain/value.js';

/** A bet valued now (latest model) and at placement (prior / entered price). */
export interface BetValuations {
  now: BetValuation;
  /** Null until every leg has a placement probability. */
  atPlacement: BetValuation | null;
}

export function valueBetRow(bet: BetRow, legRows: LegRow[]): BetValuations {
  const now = valueBet(
    bet,
    legRows.map((l) => ({
      priceAmerican: l.priceAmerican,
      status: l.status,
      // Unevaluated legs count as a coin flip only until the first tick.
      outcome: { win: l.pWin ?? 0.5, push: l.pPush ?? 0 },
      eventId: l.eventId,
    }))
  );
  const placed = legRows.every((l) => l.pWinPlacement != null);
  const atPlacement = placed
    ? valueBet(
        bet,
        legRows.map((l) => ({
          priceAmerican: l.priceAmerican,
          status: 'open' as const,
          outcome: { win: l.pWinPlacement!, push: l.pPushPlacement ?? 0 },
          eventId: l.eventId,
        }))
      )
    : null;
  return { now, atPlacement };
}
