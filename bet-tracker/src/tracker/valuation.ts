import type { BetRow, LegRow } from '../db/schema.js';
import { THREE_WAY_HOLD } from '../models/prior.js';
import type { Outcome } from '../models/types.js';
import { devigSingle } from '../odds/math.js';
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
  /** Null until every matched leg has a placement probability. */
  atPlacement: BetValuation | null;
  /** Open legs not matched to an event, valued at their entered price. */
  unmatchedLegIds: number[];
}

/** An unmatched leg has no model: its own price, de-vigged. */
const enteredOutcome = (l: LegRow): Outcome => ({
  win: devigSingle(
    l.priceAmerican,
    l.market === 'moneyline3way' ? THREE_WAY_HOLD : undefined
  ),
  push: 0,
});

const isUnmatched = (l: LegRow) =>
  l.status === 'open' && (l.matchStatus !== 'matched' || !l.eventId);

/** Flag a model valuation that leans on entered prices. */
const withSource = (v: BetValuation, unmatched: boolean): BetValuation =>
  unmatched && v.status === 'open' && v.pWinSource === 'model'
    ? { ...v, pWinSource: 'entered_price' }
    : v;

export function valueBetRow(bet: BetRow, legRows: LegRow[]): BetValuations {
  const unmatchedLegIds = legRows.filter(isUnmatched).map((l) => l.id);
  const unmatched = new Set(unmatchedLegIds);
  const now = valueBet(
    bet,
    legRows.map((l) => ({
      priceAmerican: l.priceAmerican,
      status: l.status,
      outcome: unmatched.has(l.id)
        ? enteredOutcome(l)
        : // Unevaluated legs count as a coin flip only until the first tick.
          { win: l.pWin ?? 0.5, push: l.pPush ?? 0 },
      eventId: l.eventId,
    })),
    joints(bet.jointJson, legRows)
  );
  const placed = legRows.every(
    (l) => unmatched.has(l.id) || l.pWinPlacement != null
  );
  const atPlacement = placed
    ? valueBet(
        bet,
        legRows.map((l) => ({
          priceAmerican: l.priceAmerican,
          status: 'open' as const,
          outcome: unmatched.has(l.id)
            ? enteredOutcome(l)
            : { win: l.pWinPlacement!, push: l.pPushPlacement ?? 0 },
          eventId: l.eventId,
        })),
        joints(bet.jointPlacementJson, legRows)
      )
    : null;
  const flagged = unmatched.size > 0;
  return {
    now: withSource(now, flagged),
    atPlacement: atPlacement && withSource(atPlacement, flagged),
    unmatchedLegIds,
  };
}
