import { describe, expect, it } from 'vitest';
import { winPayout, parlayPriceFactor } from '../src/domain/payout.js';
import {
  betStatus,
  valueBet,
  type LegValueInput,
} from '../src/domain/value.js';
import {
  anchorShift,
  applyAnchor,
  conditionalWin,
  evaluateEvent,
  settleSelection,
} from '../src/models/evaluate.js';
import { logit } from '../src/models/stats.js';
import type { BetRow, LegRow } from '../src/db/schema.js';
import { valueBetRow } from '../src/tracker/valuation.js';
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
  const opts = { params: PARAMS };

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
      { params: PARAMS }
    );
    expect(r[0]!.outcome.win + r[1]!.outcome.win).toBeCloseTo(1, 10);
    expect(r[0]!.model).toBe('mlb_exact');
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

describe('valueBet: same-game groups', () => {
  const sgp = {
    stakeCents: 1000,
    priceAmerican: 1153,
    boostPct: null,
    boostedPriceAmerican: null,
    statedPayoutCents: 15984,
  };
  const sg = (over: Partial<LegValueInput>) => leg({ eventId: 'g', ...over });

  it('without a joint model: falls back to the book price (unboosted)', () => {
    const v = valueBet(sgp, [sg({}), sg({}), leg({ eventId: 'other' })]);
    expect(v.pWinSource).toBe('book_implied');
    // +1153 -> 1 / 12.53
    expect(v.pWin).toBeCloseTo(1 / 12.53, 10);
    expect(v.valueCents).toBeCloseTo(15984 / 12.53, 6);
  });

  it('with a joint model: the group is one unit, other legs multiply', () => {
    const joint = new Map([['g', [{ p: 0.07, pushed: [] }]]]);
    const v = valueBet(
      sgp,
      [
        sg({}),
        sg({}),
        leg({ eventId: 'other', outcome: { win: 0.5, push: 0 } }),
      ],
      joint
    );
    expect(v.pWinSource).toBe('model');
    // 0.07 x 0.5
    expect(v.pWin).toBeCloseTo(0.035, 12);
    expect(v.valueCents).toBeCloseTo(0.035 * 15984, 6);
  });

  it('joint push outcomes recompute the payout without the pushed leg', () => {
    const bet = {
      stakeCents: 1000,
      priceAmerican: 300,
      boostPct: null,
      boostedPriceAmerican: null,
      statedPayoutCents: null,
    };
    // Two legs on g at +100 each (product 4.0 = +300, factor 1).
    const legs = [sg({ priceAmerican: 100 }), sg({ priceAmerican: 100 })];
    const joint = new Map([
      [
        'g',
        [
          { p: 0.2, pushed: [] },
          { p: 0.1, pushed: [1] },
          { p: 0.05, pushed: [0, 1] },
        ],
      ],
    ]);
    const v = valueBet(bet, legs, joint);
    // 0.2 x $40 + 0.1 x $20 (one leg left) + 0.05 x $10 refund
    expect(v.valueCents).toBeCloseTo(0.2 * 4000 + 0.1 * 2000 + 0.05 * 1000, 6);
    expect(v.pWin).toBeCloseTo(0.3, 12);
    expect(v.pPush).toBeCloseTo(0.05, 12);
  });

  it('a group down to one open leg needs no joint model', () => {
    const v = valueBet(sgp, [
      sg({ status: 'won' }),
      sg({ outcome: { win: 0.4, push: 0 } }),
    ]);
    expect(v.pWinSource).toBe('model');
    expect(v.pWin).toBeCloseTo(0.4, 12);
  });

  it('two independent push-able legs: exact over all four paths', () => {
    const bet = {
      stakeCents: 1000,
      priceAmerican: 300,
      boostPct: null,
      boostedPriceAmerican: null,
      statedPayoutCents: null,
    };
    const legs = [
      leg({
        priceAmerican: 100,
        outcome: { win: 0.4, push: 0.1 },
        eventId: 'a',
      }),
      leg({
        priceAmerican: 100,
        outcome: { win: 0.5, push: 0.2 },
        eventId: 'b',
      }),
    ];
    // ww 0.2 x $40, wp 0.08 x $20, pw 0.05 x $20, pp 0.02 x $10 refund
    expect(valueBet(bet, legs).valueCents).toBeCloseTo(
      0.2 * 4000 + 0.08 * 2000 + 0.05 * 2000 + 0.02 * 1000,
      6
    );
  });
});

describe('market anchor', () => {
  it('pregame: the shift moves the model exactly to the market', () => {
    const model = { win: 0.32, push: 0 };
    const shift = anchorShift(model, 0.352)!;
    expect(shift).toBeCloseTo(logit(0.352) - logit(0.32), 12);
    expect(applyAnchor(model, shift, 1).win).toBeCloseTo(0.352, 12);
  });

  it('fades linearly in log-odds with the share of the game left', () => {
    const model = { win: 0.32, push: 0 };
    const shift = anchorShift(model, 0.352)!;
    const half = applyAnchor(model, shift, 0.5).win;
    expect(logit(half)).toBeCloseTo(logit(0.32) + shift / 2, 12);
    expect(applyAnchor(model, shift, 0)).toEqual(model);
  });

  it('works on P(win | no push) and keeps the push probability', () => {
    const model = { win: 0.45, push: 0.1 };
    const shift = anchorShift(model, 0.55)!;
    const a = applyAnchor(model, shift, 1);
    expect(a.push).toBe(0.1);
    expect(conditionalWin(a)).toBeCloseTo(0.55, 12);
  });
});

describe('multi-sport parlays', () => {
  it('NHL + MLB legs on different games: P(win) is the product of the legs', () => {
    const bet = {
      stakeCents: 1000,
      priceAmerican: 600,
      boostPct: null,
      boostedPriceAmerican: null,
      statedPayoutCents: 7000,
    };
    const legs = [
      leg({ eventId: 'espn:nhl:401892453', outcome: { win: 0.51, push: 0 } }),
      leg({ eventId: 'espn:nhl:401891815', outcome: { win: 0.315, push: 0 } }),
      leg({ eventId: 'mlb:849833', outcome: { win: 0.352, push: 0 } }),
    ];
    const v = valueBet(bet, legs);
    expect(v.pWinSource).toBe('model');
    expect(v.pWin).toBeCloseTo(0.51 * 0.315 * 0.352, 12);
    expect(v.valueCents).toBeCloseTo(0.51 * 0.315 * 0.352 * 7000, 9);
  });
});

describe('parlays with an unmatched leg', () => {
  // Bet 29: Draw ATL/CIN +365 (modeled 0.2479) x Corinthians +637 (not
  // matched to a game), $10 at +2565 boosted 30%, stated payout $343.46.
  const bet = {
    stakeCents: 1000,
    priceAmerican: 2565,
    boostPct: 30,
    boostedPriceAmerican: 3334,
    statedPayoutCents: 34346,
    jointJson: null,
    jointPlacementJson: null,
  } as BetRow;
  const legRow = (over: Partial<LegRow>) =>
    ({
      market: 'moneyline3way',
      status: 'open',
      pWin: null,
      pPush: null,
      pWinPlacement: null,
      pPushPlacement: null,
      ...over,
    }) as LegRow;
  const legs = [
    legRow({
      id: 56,
      priceAmerican: 365,
      eventId: 'espn:soccer:761850',
      matchStatus: 'matched',
      pWin: 0.2479,
      pPush: 0,
      pWinPlacement: 0.2479,
      pPushPlacement: 0,
    }),
    legRow({
      id: 57,
      priceAmerican: 637,
      eventId: null,
      matchStatus: 'unmatched',
    }),
  ];
  // +637 implies 100/737; 3-way hold 6% -> 100/737/1.06 = 0.1280049...
  const corinthians = 100 / 737 / 1.06;

  it('values the unmatched leg at its de-vigged price, not a coin flip', () => {
    const v = valueBetRow(bet, legs);
    expect(v.unmatchedLegIds).toEqual([57]);
    expect(v.now.pWinSource).toBe('entered_price');
    // 0.2479 x 0.1280049 = 0.0317324
    expect(v.now.pWin).toBeCloseTo(0.2479 * corinthians, 12);
    expect(v.now.valueCents).toBeCloseTo(0.2479 * corinthians * 34346, 8);
    expect(v.now.evCents).toBeCloseTo(0.2479 * corinthians * 34346 - 1000, 8);
  });

  it('values at placement the same way instead of leaving it null', () => {
    const v = valueBetRow(bet, legs);
    expect(v.atPlacement).not.toBeNull();
    expect(v.atPlacement!.pWinSource).toBe('entered_price');
    expect(v.atPlacement!.pWin).toBeCloseTo(0.2479 * corinthians, 12);
  });

  it('is a plain model valuation once every leg is matched', () => {
    const v = valueBetRow(bet, [
      legs[0]!,
      {
        ...legs[1]!,
        eventId: 'espn:soccer:401841261',
        matchStatus: 'matched',
        pWin: 0.15,
        pPush: 0,
      },
    ]);
    expect(v.unmatchedLegIds).toEqual([]);
    expect(v.now.pWinSource).toBe('model');
    expect(v.now.pWin).toBeCloseTo(0.2479 * 0.15, 12);
  });
});
