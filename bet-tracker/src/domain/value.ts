import type { Outcome } from '../models/types.js';
import { impliedProbability } from '../odds/math.js';
import { winPayout, type PayoutBet } from './payout.js';
import type { BetStatus, LegStatus } from './types.js';

// Bet-level value from leg probabilities. Legs on different events are
// independent. Two or more open legs on one event are correlated: they are
// valued from a joint model of that game when one is supplied, otherwise the
// bet falls back to the book's own (unboosted) price.

export interface LegValueInput {
  priceAmerican: number;
  status: LegStatus;
  /** Model outcome for open legs (ignored once settled). */
  outcome: Outcome;
  eventId: string | null;
}

/**
 * One non-losing outcome of a same-game group, from a joint game model:
 * probability, and which of the bet's legs (by index) push in it; every
 * other open leg in the group wins.
 */
export interface JointOutcome {
  p: number;
  pushed: number[];
}

export type PWinSource = 'model' | 'book_implied' | 'entered_price';

export interface BetValuation {
  /** P(the bet pays more than the stake). */
  pWin: number;
  /** P(the whole bet is refunded: single pushes, or every parlay leg pushes). */
  pPush: number;
  /** Return if it wins from here, given legs already settled. */
  payoutCents: number;
  /** Expected return now: wins x their payout + push refunds. */
  valueCents: number;
  /** valueCents - stake. */
  evCents: number;
  /** Event ids that appear in more than one leg. */
  sameGameEventIds: string[];
  /**
   * 'model' when every leg (and same-game group) is modeled; 'book_implied'
   * when a same-game group has no joint model and the bet's own price
   * (unboosted, vig included) stands in for P(win); 'entered_price' when
   * an unmatched leg's own price (de-vigged) stands in for its model.
   */
  pWinSource: PWinSource;
  status: BetStatus;
}

const settled = (s: LegStatus) => s !== 'open';

/** Status a bet takes from its legs' statuses. */
export function betStatus(legs: { status: LegStatus }[]): BetStatus {
  if (legs.some((l) => l.status === 'lost')) return 'lost';
  if (legs.some((l) => l.status === 'open')) return 'open';
  if (legs.every((l) => l.status === 'void')) return 'void';
  if (legs.every((l) => l.status === 'push' || l.status === 'void'))
    return 'push';
  return 'won';
}

/** Above this many outcome combinations, push paths are dropped (wins only). */
const MAX_COMBINATIONS = 1 << 14;

/**
 * Value a bet exactly over every non-losing combination of its independent
 * units (single legs, and jointly-modeled same-game groups). A pushed leg
 * drops out and the payout is recomputed.
 */
export function valueBet(
  bet: PayoutBet,
  legs: LegValueInput[],
  joint: Map<string, JointOutcome[]> = new Map()
): BetValuation {
  const counts = new Map<string, number>();
  for (const l of legs)
    if (l.eventId) counts.set(l.eventId, (counts.get(l.eventId) ?? 0) + 1);
  const sameGameEventIds = [...counts]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  const status = betStatus(legs);
  const payoutNow = winPayout(bet, legs).cents;
  const base = { payoutCents: payoutNow, sameGameEventIds, status };

  if (status !== 'open') {
    const valueCents =
      status === 'won' ? payoutNow : status === 'lost' ? 0 : bet.stakeCents;
    return {
      ...base,
      pWin: status === 'won' ? 1 : 0,
      pPush: status === 'push' || status === 'void' ? 1 : 0,
      valueCents,
      evCents: valueCents - bet.stakeCents,
      pWinSource: 'model',
    };
  }

  // Group open legs into independent units.
  const openIdx = legs
    .map((_, i) => i)
    .filter((i) => !settled(legs[i]!.status));
  const byEvent = new Map<string, number[]>();
  const units: JointOutcome[][] = [];
  for (const i of openIdx) {
    const e = legs[i]!.eventId;
    if (e) byEvent.set(e, [...(byEvent.get(e) ?? []), i]);
    else units.push(singleUnit(legs[i]!.outcome, i));
  }
  for (const [eventId, idx] of byEvent) {
    if (idx.length === 1) {
      units.push(singleUnit(legs[idx[0]!]!.outcome, idx[0]!));
      continue;
    }
    const j = joint.get(eventId);
    if (!j) return bookImplied(bet, payoutNow, base);
    units.push(j.filter((o) => o.p > 0));
  }

  // Too many push paths: keep each unit's no-push outcome only.
  const size = units.reduce((n, u) => n * Math.max(1, u.length), 1);
  const used =
    size > MAX_COMBINATIONS
      ? units.map((u) => u.filter((o) => o.pushed.length === 0))
      : units;

  let pWin = 0;
  let pPush = 0;
  let value = 0;
  const payoutFor = new Map<string, number>();
  const walk = (k: number, p: number, pushed: number[]) => {
    if (p === 0) return;
    if (k === used.length) {
      const key = [...pushed].sort((a, b) => a - b).join(',');
      if (!payoutFor.has(key)) {
        const hyp = legs.map((l, i) =>
          pushed.includes(i) ? { ...l, status: 'push' as const } : l
        );
        payoutFor.set(
          key,
          betStatus(hyp) === 'push' ? -1 : winPayout(bet, hyp).cents
        );
      }
      const pay = payoutFor.get(key)!;
      if (pay < 0) {
        pPush += p;
        value += p * bet.stakeCents;
      } else {
        pWin += p;
        value += p * pay;
      }
      return;
    }
    for (const o of used[k]!)
      walk(k + 1, p * o.p, o.pushed.length ? [...pushed, ...o.pushed] : pushed);
  };
  walk(0, 1, []);

  return {
    ...base,
    pWin,
    pPush,
    valueCents: value,
    evCents: value - bet.stakeCents,
    pWinSource: 'model',
  };
}

function singleUnit(o: Outcome, legIndex: number): JointOutcome[] {
  return [
    { p: o.win, pushed: [] },
    { p: o.push, pushed: [legIndex] },
  ].filter((x) => x.p > 0);
}

/** Interim guard: the book's own price, unboosted, stands in for P(win). */
function bookImplied(
  bet: PayoutBet,
  payoutCents: number,
  base: Pick<BetValuation, 'payoutCents' | 'sameGameEventIds' | 'status'>
): BetValuation {
  const pWin = impliedProbability(bet.priceAmerican);
  const value = pWin * payoutCents;
  return {
    ...base,
    pWin,
    pPush: 0,
    valueCents: value,
    evCents: value - bet.stakeCents,
    pWinSource: 'book_implied',
  };
}
