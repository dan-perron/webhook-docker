import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, settleBet, updateBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import type { BetInput } from '../src/domain/betInput.js';
import { winPayout, type PayoutBet } from '../src/domain/payout.js';
import { valueBet, type LegValueInput } from '../src/domain/value.js';
import { betViews, portfolio } from '../src/tracker/views.js';

// Bonus bets: the stake is the book's money, not Dan's, and isn't returned on
// a win (DK's "To Pay" is profit only). Cost 0, payout = stake x (decimal - 1).

const single: PayoutBet = {
  stakeCents: 2500,
  priceAmerican: 300,
  boostPct: null,
  boostedPriceAmerican: null,
  statedPayoutCents: null,
};
const bonus: PayoutBet = { ...single, bonusBet: true };
const leg = (win: number, status: LegValueInput['status'] = 'open') => ({
  priceAmerican: 300,
  status,
  outcome: { win, push: 0 },
  eventId: 'e1',
});

describe('bonus bet payout and value', () => {
  it('pays profit only: $25 at +300 -> $75, not $100', () => {
    // decimal 4.0; bonus: 2500 x (4 - 1) = 7500; cash: 2500 x 4 = 10000
    expect(winPayout(bonus, [leg(0.25)]).cents).toBe(7500);
    expect(winPayout(single, [leg(0.25)]).cents).toBe(10000);
  });

  it('takes a stated payout as-is (DK "To Pay" already excludes the stake)', () => {
    // bet 172: $25 bonus at +2430, DK To Pay $607.50 = 25 x 24.30
    expect(
      winPayout({ ...bonus, priceAmerican: 2430, statedPayoutCents: 60750 }, [])
        .cents
    ).toBe(60750);
  });

  it('values a +300 single at p = 0.25 as 0.25 x 3 x stake, EV = value', () => {
    // value = 0.25 x 3 x 2500 = 1875 cents; cost 0 -> ev = 1875
    const v = valueBet(bonus, [leg(0.25)]);
    expect(v.valueCents).toBeCloseTo(1875, 9);
    expect(v.evCents).toBeCloseTo(1875, 9);
    expect(v.payoutCents).toBe(7500);
  });

  it('leaves the same cash bet unchanged', () => {
    // value = 0.25 x 4 x 2500 = 2500; ev = 2500 - 2500 = 0
    const v = valueBet(single, [leg(0.25)]);
    expect(v.valueCents).toBeCloseTo(2500, 9);
    expect(v.evCents).toBeCloseTo(0, 9);
  });

  it('settles: won = payout, lost = $0 (not -stake), push = $0', () => {
    expect(valueBet(bonus, [leg(0, 'won')]).evCents).toBe(7500);
    expect(valueBet(bonus, [leg(0, 'lost')]).evCents).toBe(0);
    expect(valueBet(bonus, [leg(0, 'push')])).toMatchObject({
      valueCents: 0,
      evCents: 0,
    });
    // the cash bet loses its stake
    expect(valueBet(single, [leg(0, 'lost')]).evCents).toBe(-2500);
  });

  it('a bonus parlay with every leg pushed returns no cash', () => {
    const p = { ...bonus, priceAmerican: 1500 };
    const legs = [
      { priceAmerican: 300, status: 'push' as const },
      { priceAmerican: 300, status: 'push' as const },
    ];
    expect(winPayout(p, legs).cents).toBe(0);
  });
});

const ml = (over: Partial<BetInput> = {}): BetInput => ({
  book: 'DraftKings',
  stake: 25,
  price: 300,
  legs: [
    {
      sport: 'nba',
      eventDate: '2026-10-20',
      participants: ['Chicago Bulls', 'Detroit Pistons'],
      market: 'moneyline',
      selection: { kind: 'team', team: 'Chicago Bulls' },
      price: 300,
    },
  ],
  ...over,
});

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('bonus bets in views and portfolio', () => {
  it('is stored, editable and shown with conversion', () => {
    const b = createBet(db, ml({ bonusBet: true }));
    const c = createBet(db, ml());
    expect([b.bet.bonusBet, c.bet.bonusBet]).toEqual([true, false]);
    const [vb, vc] = betViews(db).sort((x, y) => x.id - y.id);
    expect(vb).toMatchObject({ bonusBet: true, stake: 25, cashStake: 0 });
    expect(vb!.payout).toBe(75);
    // value / face stake
    expect(vb!.now.conversion).toBeCloseTo(vb!.now.value / 25, 3);
    expect(vb!.now.ev).toBe(vb!.now.value);
    expect(vc).toMatchObject({ bonusBet: false, cashStake: 25 });
    expect(vc!.now.conversion).toBeUndefined();
    expect(updateBet(db, c.bet.id, { bonusBet: true })!.bet.bonusBet).toBe(
      true
    );
  });

  it('counts no cash stake, winnings as profit, and face separately', () => {
    const won = createBet(db, ml({ bonusBet: true }));
    const lost = createBet(db, ml({ bonusBet: true }));
    const push = createBet(db, ml({ bonusBet: true }));
    const cash = createBet(db, ml());
    settleBet(db, won.bet.id, 'won');
    settleBet(db, lost.bet.id, 'lost');
    settleBet(db, push.bet.id, 'push');
    settleBet(db, cash.bet.id, 'lost');
    const p = portfolio(db);
    // cash: $25 staked, lost; bonus: +$75 + $0 + $0
    expect(p.settled).toMatchObject({
      count: 4,
      staked: 25,
      returned: 75,
      profit: 50,
    });
    expect(p.bonusBetsUsed).toMatchObject({
      count: 3,
      face: 75,
      settled: { count: 3, face: 75, profit: 75 },
    });
    const pv = betViews(db).find((v) => v.id === push.bet.id)!;
    expect(pv.bonusBetMayBeReturned).toBe(true);
    expect(pv.now.ev).toBe(0);
  });
});
