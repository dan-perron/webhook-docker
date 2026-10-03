import { describe, expect, it } from 'vitest';
import { winPayout, parlayPriceFactor } from '../src/domain/payout.js';
import {
  betStatus,
  valueBet,
  type LegValueInput,
} from '../src/domain/value.js';
import { evaluateEvent, settleSelection } from '../src/models/evaluate.js';
import { seededRng } from '../src/models/stats.js';
import type { ModelSelection } from '../src/models/types.js';
import { PARAMS, prior, state } from './helpers/states.js';

const final = (homeScore: number, awayScore: number, over = {}) =>
  state('nfl', {
    status: 'final',
    homeScore,
    awayScore,
    fractionRemaining: 0,
    ...over,
  });
const sel = (s: Partial<ModelSelection>): ModelSelection => ({
  market: 'moneyline',
  kind: 'team',
  side: 'home',
  line: null,
  ...s,
});

describe('settleSelection', () => {
  it('moneyline, spread with push, totals with push', () => {
    expect(settleSelection('nfl', final(24, 21), sel({}))).toBe('won');
    expect(settleSelection('nfl', final(24, 21), sel({ side: 'away' }))).toBe(
      'lost'
    );
    expect(
      settleSelection('nfl', final(24, 21), sel({ market: 'spread', line: -3 }))
    ).toBe('push');
    expect(
      settleSelection(
        'nfl',
        final(24, 21),
        sel({ market: 'spread', side: 'away', line: 3.5 })
      )
    ).toBe('won');
    expect(
      settleSelection(
        'nfl',
        final(24, 21),
        sel({ market: 'total', kind: 'under', side: null, line: 45 })
      )
    ).toBe('push');
    expect(
      settleSelection(
        'nfl',
        final(24, 21),
        sel({ market: 'total', kind: 'over', side: null, line: 44.5 })
      )
    ).toBe('won');
  });

  it('recorded finals: Mississippi State +5.5 lost 23-56; UCF +10.5 covered 17-27', () => {
    expect(
      settleSelection(
        'ncaaf',
        final(23, 56),
        sel({ market: 'spread', line: 5.5 })
      )
    ).toBe('lost');
    expect(
      settleSelection(
        'ncaaf',
        final(27, 17),
        sel({ market: 'spread', side: 'away', line: 10.5 })
      )
    ).toBe('won');
  });

  it('soccer 3-way draw and MMA draw push', () => {
    const s = state('soccer', {
      status: 'final',
      homeScore: 1,
      awayScore: 1,
      winner: 'draw',
    });
    expect(
      settleSelection(
        'soccer',
        s,
        sel({ market: 'moneyline3way', kind: 'draw', side: null })
      )
    ).toBe('won');
    expect(settleSelection('soccer', s, sel({ market: 'moneyline3way' }))).toBe(
      'lost'
    );
    const fight = state('mma', { status: 'final', winner: 'draw' });
    expect(settleSelection('mma', fight, sel({}))).toBe('push');
    expect(
      settleSelection(
        'mma',
        state('mma', { status: 'final', winner: 'away' }),
        sel({ side: 'away' })
      )
    ).toBe('won');
  });

  it('cancelled games void', () => {
    expect(
      settleSelection('mlb', final(0, 0, { cancelled: true }), sel({}))
    ).toBe('void');
  });
});

describe('evaluateEvent', () => {
  const opts = { params: PARAMS, rng: seededRng(1) };

  it('settles every selection on a final game', () => {
    const r = evaluateEvent(
      'nfl',
      final(24, 21),
      prior(),
      [sel({}), sel({ market: 'spread', line: -3 })],
      opts
    );
    expect(r.map((x) => x.status)).toEqual(['won', 'push']);
    expect(r[1]!.outcome).toEqual({ win: 0, push: 1 });
    expect(r[0]!.model).toBe('settled');
  });

  it('MMA holds the prior until final', () => {
    const r = evaluateEvent(
      'mma',
      state('mma', { status: 'in' }),
      prior({ homeWin: 0.7, awayWin: 0.3 }),
      [sel({ side: 'away' })],
      opts
    );
    expect(r[0]).toMatchObject({
      outcome: { win: 0.3, push: 0 },
      model: 'mma_prior',
      status: 'open',
    });
  });

  it('runs one MLB simulation for all selections on the event', () => {
    const s = state('mlb', { status: 'pre' });
    const r = evaluateEvent(
      'mlb',
      s,
      prior({ expectedTotal: 8.8 }),
      [sel({}), sel({ side: 'away' })],
      { params: { ...PARAMS, mlb: { simulations: 5000 } }, rng: seededRng(3) }
    );
    expect(r[0]!.outcome.win + r[1]!.outcome.win).toBeCloseTo(1, 10);
    expect(r[0]!.inputs.simulations).toBe(5000);
  });
});

const leg = (over: Partial<LegValueInput>): LegValueInput => ({
  priceAmerican: -110,
  status: 'open',
  outcome: { win: 0.5, push: 0 },
  eventId: null,
  ...over,
});
const BET = {
  stakeCents: 1000,
  priceAmerican: 160,
  boostPct: null,
  boostedPriceAmerican: null,
  statedPayoutCents: 2600,
};

describe('valueBet', () => {
  it('single: value = P(win) x payout; EV = value - stake', () => {
    const v = valueBet(BET, [leg({ outcome: { win: 0.4, push: 0 } })]);
    expect(v.valueCents).toBeCloseTo(1040, 10);
    expect(v.evCents).toBeCloseTo(40, 10);
    expect(v.status).toBe('open');
  });

  it('single that can push refunds the stake on the push', () => {
    // 0.45 x 2600 + 0.1 x 1000
    const v = valueBet(BET, [leg({ outcome: { win: 0.45, push: 0.1 } })]);
    expect(v.valueCents).toBeCloseTo(1270, 10);
    expect(v.pPush).toBeCloseTo(0.1, 10);
  });

  it('parlay: product of legs x stated payout', () => {
    const bet = { ...BET, priceAmerican: 785, statedPayoutCents: 11199 };
    const v = valueBet(bet, [
      leg({ outcome: { win: 0.5, push: 0 } }),
      leg({ outcome: { win: 0.6, push: 0 } }),
      leg({ outcome: { win: 0.7, push: 0 } }),
    ]);
    // 0.21 x 11199
    expect(v.pWin).toBeCloseTo(0.21, 10);
    expect(v.valueCents).toBeCloseTo(2351.79, 6);
  });

  it('parlay: a won leg counts as 1, a lost leg zeroes it', () => {
    const bet = { ...BET, priceAmerican: 785, statedPayoutCents: 11199 };
    const won = valueBet(bet, [
      leg({ status: 'won' }),
      leg({ outcome: { win: 0.6, push: 0 } }),
    ]);
    expect(won.valueCents).toBeCloseTo(0.6 * 11199, 6);
    const lost = valueBet(bet, [leg({ status: 'lost' }), leg({})]);
    expect(lost).toMatchObject({
      status: 'lost',
      valueCents: 0,
      evCents: -1000,
      pWin: 0,
    });
  });

  it('parlay: a leg that may push adds the recomputed-payout path', () => {
    const bet = {
      stakeCents: 1000,
      priceAmerican: 464,
      boostPct: null,
      boostedPriceAmerican: null,
      statedPayoutCents: null,
    };
    const legs = [
      leg({ priceAmerican: 100, outcome: { win: 0.5, push: 0 } }),
      leg({ priceAmerican: 182, outcome: { win: 0.4, push: 0.1 } }),
    ];
    // Book priced exactly the product (2 x 2.82 = 5.64), factor 1.
    expect(parlayPriceFactor(bet, legs)).toBeCloseTo(1, 10);
    // 0.5 x 0.4 x $56.40 + 0.1 x 0.5 x $20.00 = 11.28 + 1.00
    expect(valueBet(bet, legs).valueCents).toBeCloseTo(1228, 6);
  });

  it('flags same-game legs', () => {
    const v = valueBet(BET, [
      leg({ eventId: 'e1' }),
      leg({ eventId: 'e1' }),
      leg({ eventId: 'e2' }),
    ]);
    expect(v.sameGameEventIds).toEqual(['e1']);
  });
});

describe('push/void recompute with the book discount', () => {
  it('UFC parlay: Ribovics fight voids -> remaining legs x 0.8022, boosted 30%', () => {
    // legs multiply to 7.990559; book priced +541 (6.41) -> factor 0.802197.
    // 3.16 x 1.578035 x 0.802197 = 4.000; 1 + 3.000 x 1.3 = 4.900 -> $49.00
    const bet = {
      stakeCents: 1000,
      priceAmerican: 541,
      boostPct: 30,
      boostedPriceAmerican: 703,
      statedPayoutCents: 8032,
    };
    const legs = [
      { priceAmerican: 216, status: 'open' as const },
      { priceAmerican: -166, status: 'void' as const },
      { priceAmerican: -173, status: 'open' as const },
    ];
    expect(parlayPriceFactor(bet, legs)).toBeCloseTo(0.8021967, 6);
    expect(winPayout(bet, legs)).toEqual({
      cents: 4900,
      source: 'recomputed_after_push',
    });
  });
});

describe('betStatus', () => {
  it.each([
    [['won', 'open'], 'open'],
    [['won', 'lost', 'open'], 'lost'],
    [['won', 'push'], 'won'],
    [['push', 'void'], 'push'],
    [['void', 'void'], 'void'],
  ] as const)('%j -> %s', (statuses, expected) => {
    expect(betStatus(statuses.map((status) => ({ status })))).toBe(expected);
  });
});
