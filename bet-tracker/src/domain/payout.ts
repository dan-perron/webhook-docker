import {
  americanToDecimal,
  boostDecimal,
  parlayDecimal,
  payoutCents,
} from '../odds/math.js';
import type { BetStatus } from './types.js';

export interface PayoutBet {
  stakeCents: number;
  priceAmerican: number;
  boostPct: number | null;
  boostedPriceAmerican: number | null;
  statedPayoutCents: number | null;
}

export interface PayoutLeg {
  priceAmerican: number;
  status: BetStatus;
}

export type PayoutSource =
  'stated' | 'boosted_price' | 'price' | 'recomputed_after_push';

export interface Payout {
  /** Total return if the bet wins (stake included), in cents. */
  cents: number;
  source: PayoutSource;
}

/**
 * What the bet returns if it wins. The book's stated payout wins over any
 * price math. If parlay legs pushed/voided, the price is recomputed from the
 * remaining legs' stored odds with the same boost percentage applied.
 */
export function winPayout(bet: PayoutBet, legs: PayoutLeg[]): Payout {
  const dropped = legs.filter(
    (l) => l.status === 'push' || l.status === 'void'
  );
  if (legs.length > 1 && dropped.length > 0) {
    const remaining = legs.filter((l) => !dropped.includes(l));
    if (remaining.length === 0) {
      return { cents: bet.stakeCents, source: 'recomputed_after_push' };
    }
    let decimal = parlayDecimal(remaining.map((l) => l.priceAmerican));
    if (bet.boostPct) decimal = boostDecimal(decimal, bet.boostPct);
    return {
      cents: payoutCents(bet.stakeCents, decimal),
      source: 'recomputed_after_push',
    };
  }
  if (bet.statedPayoutCents != null) {
    return { cents: bet.statedPayoutCents, source: 'stated' };
  }
  if (bet.boostedPriceAmerican != null) {
    return {
      cents: payoutCents(
        bet.stakeCents,
        americanToDecimal(bet.boostedPriceAmerican)
      ),
      source: 'boosted_price',
    };
  }
  return {
    cents: payoutCents(bet.stakeCents, americanToDecimal(bet.priceAmerican)),
    source: 'price',
  };
}
