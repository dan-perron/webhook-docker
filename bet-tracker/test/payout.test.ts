import { describe, expect, it } from 'vitest';
import { winPayout, type PayoutBet } from '../src/domain/payout.js';

const parlay: PayoutBet = {
  stakeCents: 1000,
  priceAmerican: 785,
  boostPct: 30,
  boostedPriceAmerican: 1019,
  statedPayoutCents: 11199,
};
const open = (priceAmerican: number) => ({
  priceAmerican,
  status: 'open' as const,
});

describe('winPayout', () => {
  it('prefers the stated payout', () => {
    const legs = [open(180), open(114), open(-210)];
    expect(winPayout(parlay, legs)).toEqual({ cents: 11199, source: 'stated' });
  });

  it('falls back to boosted price, then price', () => {
    const bet = { ...parlay, statedPayoutCents: null };
    expect(winPayout(bet, [open(785)])).toEqual({
      cents: 11190,
      source: 'boosted_price',
    });
    expect(
      winPayout({ ...bet, boostedPriceAmerican: null }, [open(785)])
    ).toEqual({ cents: 8850, source: 'price' });
  });

  it('recomputes a parlay from remaining legs with the boost when a leg pushes', () => {
    // Yankees leg pushes: 2.8 x 1.476190 = 4.133333; boosted 1 + 3.133333 x 1.3
    // = 5.073333 -> $50.73
    const legs = [
      open(180),
      { priceAmerican: 114, status: 'push' as const },
      open(-210),
    ];
    expect(winPayout(parlay, legs)).toEqual({
      cents: 5073,
      source: 'recomputed_after_push',
    });
  });

  it('returns the stake when every parlay leg pushes', () => {
    const legs = [
      { priceAmerican: 180, status: 'void' as const },
      { priceAmerican: 114, status: 'push' as const },
    ];
    expect(winPayout(parlay, legs).cents).toBe(1000);
  });
});
