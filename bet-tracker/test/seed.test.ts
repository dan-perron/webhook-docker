import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet, listBets } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { betInputSchema } from '../src/domain/betInput.js';
import { winPayout } from '../src/domain/payout.js';
import { americanToDecimal, boostDecimal } from '../src/odds/math.js';
import { seedBets } from '../src/seed/seedData.js';
import { loadSeed } from '../src/seed/load.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('seed data', () => {
  it('every seed bet passes input validation', () => {
    for (const bet of seedBets) betInputSchema.parse(bet);
  });

  it("stated payouts agree with the boosted price within FanDuel's rounding", () => {
    for (const bet of seedBets) {
      const price = bet.boostedPrice ?? bet.price;
      const computed = bet.stake * americanToDecimal(price);
      // FanDuel rounds displayed odds; allow 1% of payout.
      expect(Math.abs(computed - bet.statedPayout!)).toBeLessThan(
        bet.statedPayout! * 0.01
      );
    }
  });

  it('boosted prices follow from the profit boost within rounding', () => {
    for (const bet of seedBets.filter((b) => b.boostPct)) {
      const boosted = boostDecimal(americanToDecimal(bet.price), bet.boostPct!);
      expect(
        Math.abs(boosted / americanToDecimal(bet.boostedPrice!) - 1)
      ).toBeLessThan(0.01);
    }
  });
});

describe('loadSeed', () => {
  it('inserts 10 bets and 24 legs, unmatched', () => {
    const { inserted, skipped } = loadSeed(db);
    expect(skipped).toBe(false);
    expect(inserted).toHaveLength(10);
    const all = listBets(db);
    expect(all.flatMap((b) => b.legs)).toHaveLength(24);
    expect(
      all.every((b) => b.legs.every((l) => l.matchStatus === 'unmatched'))
    ).toBe(true);
    expect(all.filter((b) => b.bet.betType === 'parlay')).toHaveLength(3);
  });

  it('stores money in cents and uses the stated payout', () => {
    loadSeed(db);
    const big = listBets(db).find((b) => b.legs.length === 11)!;
    expect(big.bet.stakeCents).toBe(1000);
    expect(big.bet.statedPayoutCents).toBe(2519781);
    expect(winPayout(big.bet, big.legs)).toEqual({
      cents: 2519781,
      source: 'stated',
    });
    const rams = listBets(db).find((b) => b.bet.tokenInfo)!;
    expect(rams.bet.stakeCents).toBe(500);
    expect(rams.bet.statedPayoutCents).toBe(763);
  });

  it('records the live bet placement time in UTC', () => {
    loadSeed(db);
    const live = listBets(db).find((b) => b.bet.placedLive)!;
    expect(live.bet.placedAt).toBe('2026-10-03T18:16:00.000Z');
    expect(live.bet.boostKind).toBe('live_boost');
  });

  it('is idempotent unless forced', () => {
    loadSeed(db);
    expect(loadSeed(db).skipped).toBe(true);
    expect(listBets(db)).toHaveLength(10);
    const forced = loadSeed(db, { force: true });
    expect(forced.skipped).toBe(false);
    expect(listBets(db)).toHaveLength(10);
  });
});

describe('createBet validation', () => {
  const base = {
    book: 'FanDuel',
    stake: 10,
    price: -110,
    legs: [
      {
        sport: 'nfl' as const,
        eventDate: '2026-10-04',
        participants: ['Bears', 'Packers'] as [string, string],
        market: 'spread' as const,
        selection: { kind: 'team' as const, team: 'Bears' },
        line: 3.5,
        price: -110,
      },
    ],
  };

  it('accepts a valid single and infers type', () => {
    const { bet, legs } = createBet(db, base);
    expect(bet.betType).toBe('single');
    expect(legs[0]!.line).toBe(3.5);
    expect(getBet(db, bet.id)!.legs).toHaveLength(1);
  });

  it.each([
    ['team not a participant', { selection: { kind: 'team', team: 'Lions' } }],
    ['spread without a line', { line: undefined }],
    ['over on a spread', { selection: { kind: 'over' } }],
    ['bad date', { eventDate: '10/4/2026' }],
    ['price inside (-100, 100)', { price: 50 }],
  ])('rejects %s', (_name, patch) => {
    const leg = { ...base.legs[0], ...patch };
    expect(() => createBet(db, { ...base, legs: [leg] } as never)).toThrow();
    expect(listBets(db)).toHaveLength(0);
  });

  it('rejects a boost percent without a kind', () => {
    expect(() => createBet(db, { ...base, boostPct: 30 })).toThrow(/boostKind/);
  });
});
