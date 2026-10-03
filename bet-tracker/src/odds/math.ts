// Pure odds arithmetic. Prices are American odds; probabilities are 0..1.

export function assertAmerican(price: number): void {
  if (!Number.isFinite(price) || (price > -100 && price < 100)) {
    throw new RangeError(`Invalid American odds: ${price}`);
  }
}

/** Decimal odds (total return per 1 staked), e.g. +150 -> 2.5, -200 -> 1.5. */
export function americanToDecimal(price: number): number {
  assertAmerican(price);
  return price > 0 ? 1 + price / 100 : 1 + 100 / -price;
}

/** Nearest American price for decimal odds (> 1). */
export function decimalToAmerican(decimal: number): number {
  if (!(decimal > 1)) throw new RangeError(`Invalid decimal odds: ${decimal}`);
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : Math.round(-100 / (decimal - 1));
}

/** Break-even probability implied by a price (includes the book's vig). */
export function impliedProbability(price: number): number {
  return 1 / americanToDecimal(price);
}

export interface DevigResult {
  /** Fair probabilities, same order as the input prices; sums to 1. */
  fair: number[];
  /** Overround: sum of implied probabilities minus 1 (0.045 = 4.5%). */
  hold: number;
}

/**
 * Remove the vig from a complete market (2-way or 3-way) by proportional
 * normalization of implied probabilities.
 */
export function devig(prices: number[]): DevigResult {
  if (prices.length < 2) throw new RangeError('devig needs >= 2 outcomes');
  const implied = prices.map(impliedProbability);
  const total = implied.reduce((a, b) => a + b, 0);
  return { fair: implied.map((p) => p / total), hold: total - 1 };
}

/**
 * Typical two-way hold used to strip vig from a single entered price when the
 * other side is unknown (e.g. -110/-110 is ~4.5%).
 */
export const DEFAULT_TWO_WAY_HOLD = 0.045;

/** Approximate fair probability from one side's price assuming `hold`. */
export function devigSingle(
  price: number,
  hold = DEFAULT_TWO_WAY_HOLD
): number {
  return Math.min(1, impliedProbability(price) / (1 + hold));
}

/** Combined decimal odds of independent legs. */
export function parlayDecimal(prices: number[]): number {
  return prices.reduce((acc, p) => acc * americanToDecimal(p), 1);
}

/** Apply a profit boost (percent) to a price: profit x (1 + pct/100). */
export function boostDecimal(decimal: number, boostPct: number): number {
  return 1 + (decimal - 1) * (1 + boostPct / 100);
}

/** Total return (stake + profit) in cents, rounded to the nearest cent. */
export function payoutCents(stakeCents: number, decimal: number): number {
  return Math.round(stakeCents * decimal);
}
