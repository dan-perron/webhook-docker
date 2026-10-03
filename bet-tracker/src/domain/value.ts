import type { Outcome } from '../models/types.js';
import { winPayout, type PayoutBet } from './payout.js';
import type { BetStatus, LegStatus } from './types.js';

// Bet-level value from leg probabilities. Parlay legs are treated as
// independent; legs on the same event are flagged, not modeled.

export interface LegValueInput {
  priceAmerican: number;
  status: LegStatus;
  /** Model outcome for open legs (ignored once settled). */
  outcome: Outcome;
  eventId: string | null;
}

export interface BetValuation {
  /** P(the bet wins), legs independent. */
  pWin: number;
  /** P(the whole bet is refunded: single pushes, or every parlay leg pushes). */
  pPush: number;
  /** Return if it wins from here, given legs already settled. */
  payoutCents: number;
  /** Expected return now: P(win) x payout + push refunds. */
  valueCents: number;
  /** valueCents - stake. */
  evCents: number;
  /** Event ids that appear in more than one leg (correlated, not modeled). */
  sameGameEventIds: string[];
  status: BetStatus;
}

const settled = (s: LegStatus) => s !== 'open';

function legOutcome(l: LegValueInput): Outcome {
  switch (l.status) {
    case 'won':
      return { win: 1, push: 0 };
    case 'lost':
      return { win: 0, push: 0 };
    case 'push':
    case 'void':
      return { win: 0, push: 1 };
    default:
      return l.outcome;
  }
}

/** Status a bet takes from its legs' statuses. */
export function betStatus(legs: { status: LegStatus }[]): BetStatus {
  if (legs.some((l) => l.status === 'lost')) return 'lost';
  if (legs.some((l) => l.status === 'open')) return 'open';
  if (legs.every((l) => l.status === 'void')) return 'void';
  if (legs.every((l) => l.status === 'push' || l.status === 'void'))
    return 'push';
  return 'won';
}

/**
 * Value a bet. For parlays, a pushed leg drops out and the payout is
 * recomputed; value includes every single-leg-push path exactly and ignores
 * paths with two or more open legs pushing (vanishingly rare).
 */
export function valueBet(bet: PayoutBet, legs: LegValueInput[]): BetValuation {
  const counts = new Map<string, number>();
  for (const l of legs)
    if (l.eventId) counts.set(l.eventId, (counts.get(l.eventId) ?? 0) + 1);
  const sameGameEventIds = [...counts]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  const status = betStatus(legs);
  const outcomes = legs.map(legOutcome);
  const payoutNow = winPayout(bet, legs).cents;

  if (status !== 'open') {
    const valueCents =
      status === 'won' ? payoutNow : status === 'lost' ? 0 : bet.stakeCents;
    return {
      pWin: status === 'won' ? 1 : 0,
      pPush: status === 'push' || status === 'void' ? 1 : 0,
      payoutCents: payoutNow,
      valueCents,
      evCents: valueCents - bet.stakeCents,
      sameGameEventIds,
      status,
    };
  }

  // Every open leg wins. Settled legs here are won or pushed/void (a lost
  // leg made the bet lost above), and pushes are already priced out of
  // payoutNow, so they contribute a factor of 1.
  const pAllWin = outcomes.reduce(
    (acc, o, i) => acc * (settled(legs[i]!.status) ? 1 : o.win),
    1
  );
  let value = pAllWin * payoutNow;
  let pPush = 0;

  // Exactly one open leg pushes, every other open leg wins.
  const open = legs.map((l, i) => i).filter((i) => !settled(legs[i]!.status));
  for (const j of open) {
    const q = outcomes[j]!.push;
    if (q === 0) continue;
    let p = q;
    for (const i of open) if (i !== j) p *= outcomes[i]!.win;
    const hypothetical = legs.map((l, i) =>
      i === j ? { ...l, status: 'push' as const } : l
    );
    const allPushed = betStatus(hypothetical) === 'push';
    if (allPushed) {
      pPush += p;
      value += p * bet.stakeCents;
    } else {
      value += p * winPayout(bet, hypothetical).cents;
    }
  }

  return {
    pWin: pAllWin,
    pPush,
    payoutCents: payoutNow,
    valueCents: value,
    evCents: value - bet.stakeCents,
    sameGameEventIds,
    status,
  };
}
