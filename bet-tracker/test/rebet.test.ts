import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createBet,
  getBet,
  settleBet,
  updateBet,
  updateLeg,
  type BetWithLegs,
} from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { bets, events, predictionSnapshots } from '../src/db/schema.js';
import type { BetInput } from '../src/domain/betInput.js';
import type { EspnScoreboard } from '../src/gamestate/espn.js';
import { createProviders } from '../src/gamestate/registry.js';
import { recordLines } from '../src/tracker/lines.js';
import { Tracker } from '../src/tracker/tracker.js';
import { valueBetRow } from '../src/tracker/valuation.js';
import { fixture } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

// Bet #5 / #23: the same UFC 3-leg parlay entered twice with different leg
// prices. One-sided de-vig at the 4.5% hold: (1 / decimal) / 1.045.
const devig1 = (american: number) =>
  1 / (american > 0 ? 1 + american / 100 : 1 + 100 / -american) / 1.045;

const fight = (fighter: string, opponent: string, price: number) => ({
  sport: 'mma' as const,
  eventDate: '2026-10-03',
  participants: [fighter, opponent] as [string, string],
  market: 'moneyline' as const,
  selection: { kind: 'team' as const, team: fighter },
  price,
});
const parlay = (prices: [number, number, number]): BetInput => ({
  book: 'FanDuel',
  stake: 10,
  price: 541,
  boostPct: 30,
  boostKind: 'profit_boost',
  boostedPrice: 703,
  statedPayout: 80.32,
  legs: [
    fight('Roman Kopylov', 'Ateba Gautier', prices[0]),
    fight('Esteban Ribovics', 'King Green', prices[1]),
    fight('Natalia Silva', 'Wang Cong', prices[2]),
  ],
});

/** The recorded 10/3 UFC card, optionally with every fight final (fighter A wins). */
function card(final: boolean): EspnScoreboard {
  const board = fixture<EspnScoreboard>('espn/ufc-20261003-pre.json');
  if (final) {
    for (const ev of board.events!) {
      for (const c of ev.competitions) {
        c.status = {
          type: {
            name: 'STATUS_FINAL',
            state: 'post',
            completed: true,
            shortDetail: 'Final',
          },
        };
        // Kopylov, Ribovics and Silva all won.
        for (const x of c.competitors) {
          x.winner = [
            'Roman Kopylov',
            'Esteban Ribovics',
            'Natalia Silva',
          ].includes(x.athlete!.displayName);
        }
      }
    }
  }
  return board;
}

let db: Db;
let clock: Date;
function trackerFor(final: boolean) {
  const board = card(final);
  const providers = createProviders(async (url) =>
    url.includes('mma/ufc/scoreboard?dates=20261003') ? board : { events: [] }
  );
  return new Tracker(db, providers, {
    params: PARAMS,
    polling: { liveSeconds: 30, scheduledSeconds: 600 },
    now: () => clock,
  });
}
const priorDetail = (b: BetWithLegs, i: number) =>
  JSON.parse(b.legs[i]!.priorJson!).detail as string;

beforeEach(() => {
  db = openDb(':memory:');
  clock = new Date('2026-10-03T20:00:00.000Z');
});

describe('re-entering a bet on an event that already has one', () => {
  it.each([
    ['before the fights', false],
    ['after the fights are final (the #23 case)', true],
  ])('%s: each bet uses its own leg prices', async (_name, final) => {
    const t = trackerFor(final);
    const first = createBet(db, parlay([216, -166, -173]));
    await t.tick();
    clock = new Date(clock.getTime() + 60_000);
    const second = createBet(db, parlay([194, -205, -215]));
    await t.tick();

    const a = getBet(db, first.bet.id)!;
    const b = getBet(db, second.bet.id)!;
    expect(priorDetail(b, 0)).toBe('entered odds: away ML +194');
    // ESPN lists King Green first, so Ribovics is the "away" fighter.
    expect(priorDetail(b, 1)).toBe('entered odds: away ML -205');
    expect(priorDetail(b, 2)).toBe('entered odds: home ML -215');
    expect(b.legs.map((l) => l.pWinPlacement)).toEqual(
      [devig1(194), devig1(-205), devig1(-215)].map((x) => expect.closeTo(x, 9))
    );
    // The first bet is untouched by the second.
    expect(priorDetail(a, 0)).toBe('entered odds: away ML +216');
    expect(a.legs[0]!.pWinPlacement).toBeCloseTo(devig1(216), 9);

    // Bet #23's numbers: 0.325489 x 0.643188 x 0.653148 = 0.136737; EV = 0.136737 x $80.32 - $10.
    const v = valueBetRow(b.bet, b.legs).atPlacement!;
    expect(v.pWin).toBeCloseTo(0.136737, 5);
    expect(v.evCents / 100).toBeCloseTo(0.9827, 3);
    if (final) expect(b.bet.status).toBe('won');
  });
});

describe('editing a leg and recomputing', () => {
  it('a corrected price changes that leg’s prior and placement; calibration snapshots stay', async () => {
    const t = trackerFor(false);
    const { bet } = createBet(db, parlay([216, -166, -173]));
    await t.tick();
    const legId = getBet(db, bet.id)!.legs[0]!.id;
    const snapsBefore = db
      .select()
      .from(predictionSnapshots)
      .all()
      .filter((s) => s.legId === legId).length;
    expect(snapsBefore).toBe(1);

    updateLeg(db, legId, { price: 194 });
    t.recomputeBet(bet.id);
    const b = getBet(db, bet.id)!;
    expect(b.legs[0]!.priceAmerican).toBe(194);
    expect(priorDetail(b, 0)).toBe('entered odds: away ML +194');
    expect(b.legs[0]!.pWinPlacement).toBeCloseTo(devig1(194), 9);
    expect(b.legs[0]!.pWin).toBeCloseTo(devig1(194), 9);
    // A price fix doesn't change what was predicted.
    expect(
      db
        .select()
        .from(predictionSnapshots)
        .all()
        .filter((s) => s.legId === legId)
    ).toHaveLength(1);
  });

  it('switching the selection flips the side and drops the old snapshots', async () => {
    const t = trackerFor(false);
    const { bet } = createBet(db, parlay([216, -166, -173]));
    await t.tick();
    const leg = getBet(db, bet.id)!.legs[0]!;
    expect(leg.side).toBe('away');
    updateLeg(db, leg.id, {
      selection: { kind: 'team', team: 'Ateba Gautier' },
      price: -260,
    });
    t.recomputeBet(bet.id);
    const after = getBet(db, bet.id)!.legs[0]!;
    expect(after).toMatchObject({
      selectionTeam: 'Ateba Gautier',
      side: 'home',
      priceAmerican: -260,
    });
    expect(after.pWinPlacement).toBeCloseTo(devig1(-260), 9);
    // The Kopylov snapshot is gone; the only one now predicts Gautier.
    const snaps = db
      .select()
      .from(predictionSnapshots)
      .all()
      .filter((x) => x.legId === leg.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.probability).toBeCloseTo(devig1(-260), 9);
  });

  it('rejects an invalid edit', () => {
    const { bet } = createBet(db, parlay([216, -166, -173]));
    const legId = getBet(db, bet.id)!.legs[0]!.id;
    expect(() => updateLeg(db, legId, { price: 50 })).toThrow();
    expect(() =>
      updateLeg(db, legId, {
        selection: { kind: 'team', team: 'Someone Else' },
      })
    ).toThrow(/not one of participants/);
    expect(() => updateLeg(db, legId, { line: 2.5 })).toThrow(/takes no line/);
  });

  it('a single bet’s price follows its leg', () => {
    const { bet } = createBet(db, {
      book: 'FanDuel',
      stake: 10,
      price: 216,
      legs: [fight('Roman Kopylov', 'Ateba Gautier', 216)],
    });
    updateLeg(db, getBet(db, bet.id)!.legs[0]!.id, { price: 194 });
    expect(getBet(db, bet.id)!.bet.priceAmerican).toBe(194);
  });
});

// The three fights are listed at the main card's 00:00Z start, and ESPN has
// no end time: settled at 00:00Z + 150 min (MMA estimate) = 02:30Z.
const FIGHTS_FINAL = '2026-10-04T02:30:00.000Z';

describe('settle time comes from the games, not from when settlement ran', () => {
  it('a bet re-entered days after its fights settles on the fight night (#23)', async () => {
    clock = new Date('2026-10-07T05:23:00.000Z');
    const t = trackerFor(true);
    const { bet } = createBet(db, parlay([194, -205, -215]));
    await t.tick();
    expect(getBet(db, bet.id)!.bet).toMatchObject({
      status: 'won',
      settledAt: FIGHTS_FINAL,
    });
  });

  it('recompute re-derives it from the games', async () => {
    const t = trackerFor(true);
    const { bet } = createBet(db, parlay([194, -205, -215]));
    clock = new Date('2026-10-04T04:00:00.000Z');
    await t.tick();
    clock = new Date('2026-10-07T05:23:00.000Z');
    t.recomputeBet(bet.id);
    expect(getBet(db, bet.id)!.bet).toMatchObject({
      status: 'won',
      settledAt: FIGHTS_FINAL,
    });
  });

  it('backfill fixes score-settled bets and leaves manual results alone', async () => {
    clock = new Date('2026-10-07T05:23:00.000Z');
    const t = trackerFor(true);
    const auto = createBet(db, parlay([194, -205, -215])).bet.id;
    const manual = createBet(db, parlay([216, -166, -173])).bet.id;
    await t.tick();
    // As the old code stamped them: the time settlement ran.
    db.update(bets)
      .set({ settledAt: '2026-10-07T05:23:00.000Z' })
      .where(eq(bets.id, auto))
      .run();
    settleBet(db, manual, 'void'); // legs say won: a hand override
    const manualAt = getBet(db, manual)!.bet.settledAt;

    expect(await t.backfillSettledAt({ dryRun: true })).toEqual([
      { id: auto, from: '2026-10-07T05:23:00.000Z', to: FIGHTS_FINAL },
    ]);
    expect(getBet(db, auto)!.bet.settledAt).toBe('2026-10-07T05:23:00.000Z');
    await t.backfillSettledAt();
    expect(getBet(db, auto)!.bet.settledAt).toBe(FIGHTS_FINAL);
    expect(getBet(db, manual)!.bet).toMatchObject({
      status: 'void',
      settledAt: manualAt,
    });
    expect(await t.backfillSettledAt()).toEqual([]);

    // An old stamp before the estimate is a tighter bound: kept. And ESPN
    // re-fetches (no end time) don't replace the stored state.
    const stateBefore = db.select().from(events).all();
    db.update(bets)
      .set({ settledAt: '2026-10-04T02:10:00.000Z' })
      .where(eq(bets.id, auto))
      .run();
    expect(await t.backfillSettledAt()).toEqual([]);
    expect(db.select().from(events).all()).toEqual(stateBefore);
  });

  it('update_bet can correct it by hand; open bets refuse one', async () => {
    const t = trackerFor(true);
    const { bet } = createBet(db, parlay([194, -205, -215]));
    await t.tick();
    updateBet(db, bet.id, { settledAt: '2026-10-03T22:05:00-05:00' });
    expect(getBet(db, bet.id)!.bet.settledAt).toBe('2026-10-04T03:05:00.000Z');

    const open = createBet(db, parlay([216, -166, -173])).bet.id;
    expect(() =>
      updateBet(db, open, { settledAt: '2026-10-04T03:05:00Z' })
    ).toThrow(/is open/);
  });
});

describe('placement uses the market lines as of when the bet was placed', () => {
  it('picks the line in effect at placedAt from the history', async () => {
    const t = trackerFor(false);
    const { bet } = createBet(db, {
      ...parlay([194, -205, -215]),
      placedAt: '2026-10-03T15:30:00-05:00',
    });
    await t.tick(); // matches the fights (events now exist)
    const eventId = getBet(db, bet.id)!.legs[0]!.eventId!;
    // Two line fetches either side of 20:30Z placement.
    const line = (home: number, away: number) => ({
      homeMoneyline: home,
      awayMoneyline: away,
      drawMoneyline: null,
      spreadHome: null,
      total: null,
    });
    recordLines(
      db,
      eventId,
      'snapshot',
      line(-150, 130),
      '2026-10-03T20:00:00.000Z'
    );
    recordLines(
      db,
      eventId,
      'snapshot',
      line(-250, 205),
      '2026-10-03T21:00:00.000Z'
    );
    db.update(events)
      .set({ pregameOddsJson: JSON.stringify(line(-250, 205)) })
      .run();
    t.recomputeBet(bet.id);
    const leg = getBet(db, bet.id)!.legs[0]!;
    const placement = JSON.parse(leg.placementJson!);
    expect(placement.source).toBe('pregame_snapshot');
    expect(placement.detail).toContain('ML -150/+130');
    expect(placement.linesAsOf).toBe('2026-10-03T20:30:00.000Z');
  });
});
