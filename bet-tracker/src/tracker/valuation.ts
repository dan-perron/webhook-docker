import type { BetRow, LegRow } from '../db/schema.js';
import {
  valueBet,
  type BetValuation,
  type JointOutcome,
} from '../domain/value.js';
import type { StoredJoint } from './tracker.js';

/** Stored joints (legs by id) -> valueBet's joints (legs by position). */
function joints(
  json: string | null,
  legRows: LegRow[]
): Map<string, JointOutcome[]> {
  if (!json) return new Map();
  const pos = new Map(legRows.map((l, i) => [l.id, i]));
  const stored = JSON.parse(json) as Record<string, StoredJoint[]>;
  return new Map(
    Object.entries(stored).map(([eventId, outs]) => [
      eventId,
      outs.map((o) => ({
        p: o.p,
        pushed: o.pushedLegIds.map((id) => pos.get(id)!),
      })),
    ])
  );
}

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
    })),
    joints(bet.jointJson, legRows)
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
        })),
        joints(bet.jointPlacementJson, legRows)
      )
    : null;
  return { now, atPlacement };
}
