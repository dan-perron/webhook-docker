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
  /**
   * Placed with a sportsbook bonus bet: the stake isn't Dan's cash and isn't
   * returned on a win, so the payout is profit only (DK's "To Pay").
   */
  bonusBet?: boolean;
}

/** Cash out of pocket: the stake, or nothing for a bonus bet. */
export const cashCostCents = (bet: PayoutBet) =>
  bet.bonusBet ? 0 : bet.stakeCents;

/**
 * Cash back when the whole bet pushes or voids: the stake, or nothing for a
 * bonus bet (the book may return the bonus bet itself, which isn't cash).
 */
export const refundCents = cashCostCents;

export interface PayoutLeg {
  priceAmerican: number;
  status: BetStatus;
}

export type PayoutSource =
  'stated' | 'boosted_price' | 'price' | 'recomputed_after_push';

export interface Payout {
  /**
   * Cash returned if the bet wins, in cents: stake included for a cash bet,
   * profit only for a bonus bet.
   */
  cents: number;
  source: PayoutSource;
}

/**
 * How the book priced the parlay relative to multiplying its legs: below 1
 * when it discounted correlated legs (e.g. a UFC card: legs multiply to +699,
 * priced +541 -> 6.41 / 7.99 = 0.80).
 */
export function parlayPriceFactor(bet: PayoutBet, legs: PayoutLeg[]): number {
  return (
    americanToDecimal(bet.priceAmerican) /
    parlayDecimal(legs.map((l) => l.priceAmerican))
  );
}

/** stake x decimal, less the stake for a bonus bet (it isn't returned). */
function fromDecimal(bet: PayoutBet, decimal: number): number {
  return payoutCents(bet.stakeCents, bet.bonusBet ? decimal - 1 : decimal);
}

/**
 * What the bet returns if it wins. The book's stated payout wins over any
 * price math (for a bonus bet it is taken as profit only, as DK states it). If parlay legs pushed/voided, the price is recomputed from the
 * remaining legs' stored odds, scaled by the book's original parlay pricing
 * factor, with the same boost percentage applied.
 */
export function winPayout(bet: PayoutBet, legs: PayoutLeg[]): Payout {
  const dropped = legs.filter(
    (l) => l.status === 'push' || l.status === 'void'
  );
  if (legs.length > 1 && dropped.length > 0) {
    const remaining = legs.filter((l) => !dropped.includes(l));
    if (remaining.length === 0) {
      return { cents: refundCents(bet), source: 'recomputed_after_push' };
    }
    let decimal =
      parlayDecimal(remaining.map((l) => l.priceAmerican)) *
      parlayPriceFactor(bet, legs);
    if (bet.boostPct) decimal = boostDecimal(decimal, bet.boostPct);
    return {
      cents: fromDecimal(bet, decimal),
      source: 'recomputed_after_push',
    };
  }
  if (bet.statedPayoutCents != null) {
    return { cents: bet.statedPayoutCents, source: 'stated' };
  }
  if (bet.boostedPriceAmerican != null) {
    return {
      cents: fromDecimal(bet, americanToDecimal(bet.boostedPriceAmerican)),
      source: 'boosted_price',
    };
  }
  return {
    cents: fromDecimal(bet, americanToDecimal(bet.priceAmerican)),
    source: 'price',
  };
}
