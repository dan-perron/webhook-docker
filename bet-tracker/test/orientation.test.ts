import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet, settleBet, updateLeg } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import {
  bets,
  eventLines,
  events,
  legs,
  predictionSnapshots,
} from '../src/db/schema.js';
import type { BetInput } from '../src/domain/betInput.js';
import {
  parseEvents,
  parseScoreboard,
  type EspnScoreboard,
} from '../src/gamestate/espn.js';
import type { GameState } from '../src/gamestate/types.js';
import { createProviders } from '../src/gamestate/registry.js';
import { matchLegs, upsertEvent } from '../src/matching/service.js';
import { devig } from '../src/odds/math.js';
import {
  alignLines,
  flipLines,
  isSwapped,
  reorientEvent,
  sideOfTeam,
} from '../src/tracker/orientation.js';
import { scanSides } from '../src/tracker/sideScan.js';
import { Tracker, type StateChange } from '../src/tracker/tracker.js';
import { legWarnings } from '../src/tracker/views.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

// Bet 195: "Duke ML" at DraftKings from the promo "UConn @ Duke", 2026-11-25,
// a neutral-site game (T-Mobile Arena). That morning ESPN listed Duke at home
// (DK: Duke +120 / UConn -142, Duke +2.5); by tip-off it had swapped to
// UConn home (close UConn -115 / Duke -105). Duke won 77-63.
// ncaab-20261125-final.json and summary-ncaab-401909568-final.json are the
// real responses, trimmed. Derived from them: -live (UConn 62 Duke 72, 1:26
// left in the 2nd half, ESPN win probability Duke 0.991) and -pre-duke-home
// (the morning listing: home/away swapped back, pregame, the DK line above).
const EVENT = 'espn:ncaab:401909568';
const BOARD = 'mens-college-basketball/scoreboard?dates=20261125';
const SUMMARY = 'mens-college-basketball/summary?event=401909568';

const dukeMl = (
  participants: [string, string] = ['UConn', 'Duke'],
  over: Partial<BetInput['legs'][number]> = {}
): BetInput => ({
  book: 'DraftKings',
  placedAt: '2026-11-25T14:50:23.000Z',
  stake: 20.5,
  price: 120,
  origin: 'recommended',
  legs: [
    {
      sport: 'ncaab',
      eventDate: '2026-11-25',
      participants,
      market: 'moneyline',
      selection: { kind: 'team', team: 'Duke' },
      price: 120,
      ...over,
    },
  ],
});

let db: Db;
let clock: Date;
let routes: Record<string, string>;
let tracker: Tracker;

const leg = (betId: number) => getBet(db, betId)!.legs[0]!;
const eventRow = () =>
  db.select().from(events).where(eq(events.id, EVENT)).get()!;

beforeEach(() => {
  db = openDb(':memory:');
  routes = {
    [BOARD]: 'espn/ncaab-20261125-pre-duke-home.json',
    [SUMMARY]: 'espn/summary-ncaab-401909568-pre-duke-home.json',
  };
  const providers = createProviders(fakeFetcher(routes).fetcher);
  clock = new Date('2026-11-25T14:53:54.000Z');
  tracker = new Tracker(db, providers, {
    params: PARAMS,
    polling: { liveSeconds: 30, scheduledSeconds: 600 },
    now: () => clock,
  });
});

/** Place, match and tick in the morning (Duke home). */
async function placeInTheMorning(input = dukeMl()) {
  const { bet } = createBet(db, input);
  await matchLegs(db, createProviders(fakeFetcher(routes).fetcher));
  // upsertEvent stamps the listing's lines with the wall clock: put them
  // at the morning clock this test runs on.
  const at = clock.toISOString();
  db.update(events).set({ providerLinesAt: at }).run();
  db.update(eventLines).set({ fetchedAt: at }).run();
  await tracker.tick();
  return bet.id;
}

/** A board's (only) game state. */
const boardState = (board: string): GameState =>
  parseScoreboard(
    'ncaab',
    fixture<EspnScoreboard>(`espn/ncaab-20261125-${board}.json`)
  )[0]!;

/** ESPN at tip-off and after: UConn home. */
function espnSwaps(board: 'live' | 'final', at: string) {
  routes[BOARD] = `espn/ncaab-20261125-${board}.json`;
  routes[SUMMARY] = 'espn/summary-ncaab-401909568-final.json';
  clock = new Date(at);
}

describe('sideOfTeam', () => {
  const home = { name: 'UConn Huskies', abbr: 'CONN' };
  const away = { name: 'Duke Blue Devils', abbr: 'DUKE' };
  it('matches the short name, the full name and the abbreviation', () => {
    for (const t of ['Duke', 'Duke Blue Devils', 'DUKE'])
      expect(sideOfTeam(t, home, away)).toBe('away');
    expect(sideOfTeam('UConn', home, away)).toBe('home');
  });
  it('is null when neither side is a confident match', () => {
    expect(sideOfTeam('Kentucky', home, away)).toBeNull();
  });
});

describe('lines orientation', () => {
  const morning = {
    homeMoneyline: 120,
    awayMoneyline: -142,
    spreadHome: 2.5,
    spreadHomePrice: -112,
    spreadAwayPrice: -108,
    homeName: 'Duke Blue Devils',
    awayName: 'UConn Huskies',
  };
  it('flips moneylines, the spread sign and prices, and the tag', () => {
    expect(flipLines(morning)).toEqual({
      homeMoneyline: -142,
      awayMoneyline: 120,
      spreadHome: -2.5,
      spreadHomePrice: -108,
      spreadAwayPrice: -112,
      homeName: 'UConn Huskies',
      awayName: 'Duke Blue Devils',
    });
  });
  it('aligns tagged lines to the event, leaves untagged ones', () => {
    const e = { homeName: 'UConn Huskies', awayName: 'Duke Blue Devils' };
    expect(alignLines(morning, e).homeMoneyline).toBe(-142);
    const { homeName: _h, awayName: _a, ...untagged } = morning;
    expect(alignLines(untagged, e)).toBe(untagged);
  });
  it('detects a swap by exact names', () => {
    const stored = {
      homeName: 'Duke Blue Devils',
      awayName: 'UConn Huskies',
      homeAbbr: 'DUKE',
      awayAbbr: 'CONN',
    };
    expect(
      isSwapped(
        stored,
        { name: 'UConn Huskies', abbr: 'CONN' },
        { name: 'Duke Blue Devils', abbr: 'DUKE' }
      )
    ).toBe(true);
    expect(
      isSwapped(
        stored,
        { name: 'Duke Blue Devils', abbr: 'DUKE' },
        { name: 'UConn Huskies', abbr: 'CONN' }
      )
    ).toBe(false);
  });
});

describe('ESPN swaps home/away on a matched event (bet 195)', () => {
  it('derives the side from ESPN, never from the label order', async () => {
    routes[BOARD] = 'espn/ncaab-20261125-final.json';
    for (const p of [
      ['UConn', 'Duke'],
      ['Duke', 'UConn'],
    ] as [string, string][]) {
      const { bet } = createBet(db, dukeMl(p));
      await matchLegs(db, createProviders(fakeFetcher(routes).fetcher));
      // ESPN (final board): DUKE @ CONN, so Duke is away either way round.
      expect(leg(bet.id)).toMatchObject({ eventId: EVENT, side: 'away' });
    }
  });

  it('re-orients at tip-off: Duke priced live, settled won, placement kept', async () => {
    const id = await placeInTheMorning();
    // Morning: ESPN had Duke at home.
    expect(eventRow().homeName).toBe('Duke Blue Devils');
    expect(leg(id).side).toBe('home');
    // Placement: Duke +120 de-vigged against UConn -142 (anchored to it).
    const dukeFair = devig([120, -142]).fair[0]!;
    const placement = leg(id).pWinPlacement!;
    expect(Math.abs(placement - dukeFair)).toBeLessThan(0.03);

    // Live, 1:26 left, Duke up 10; ESPN now lists DUKE @ CONN.
    espnSwaps('live', '2026-11-26T01:55:00.000Z');
    const r = await tracker.tick();
    expect(r.reoriented?.map((x) => x.eventId)).toEqual([EVENT]);
    expect(eventRow()).toMatchObject({
      homeName: 'UConn Huskies',
      awayName: 'Duke Blue Devils',
      homeAbbr: 'CONN',
      awayAbbr: 'DUKE',
    });
    const live = leg(id);
    expect(live.side).toBe('away');
    // Duke, not UConn: a 10-point lead with 86 s left is near certain
    // (ESPN: 0.991). Before the fix this was 0.0006.
    expect(live.pWin!).toBeGreaterThan(0.95);
    expect(legWarnings(live, eventRow())).toEqual([]);
    // Placement is not recomputed and still prices Duke.
    expect(live.pWinPlacement).toBe(placement);
    // Prior from the close (UConn -115 home / Duke -105 away): Duke's side.
    const prior = JSON.parse(live.priorJson!);
    expect(prior.awayWin).toBeCloseTo(devig([-115, -105]).fair[1]!, 2);
    // History re-oriented: the morning line now reads UConn at home -142.
    const history = db
      .select()
      .from(eventLines)
      .where(eq(eventLines.eventId, EVENT))
      .all()
      .map((l) => JSON.parse(l.linesJson));
    expect(history[0]).toMatchObject({
      homeMoneyline: -142,
      awayMoneyline: 120,
      spreadHome: -2.5,
      homeName: 'UConn Huskies',
    });
    expect(history.every((l) => l.homeName === 'UConn Huskies')).toBe(true);

    // Final: Duke 77-63.
    espnSwaps('final', '2026-11-26T02:30:00.000Z');
    await tracker.tick();
    expect(leg(id).status).toBe('won');
    expect(getBet(db, id)!.bet.status).toBe('won');

    // A recompute (placement from the re-oriented history) agrees.
    const rc = tracker.recomputeBet(id);
    expect(rc.warnings).toBeUndefined();
    expect(leg(id)).toMatchObject({ side: 'away', status: 'won' });
    expect(leg(id).pWinPlacement!).toBeCloseTo(placement, 6);
    expect(getBet(db, id)!.bet.status).toBe('won');
  });

  it('a spread leg follows the swap (Duke +1.5 from its own side)', async () => {
    const id = await placeInTheMorning({
      ...dukeMl(['UConn', 'Duke'], {
        market: 'spread',
        line: 1.5,
        price: -110,
      }),
      price: -110,
    });
    espnSwaps('live', '2026-11-26T01:55:00.000Z');
    await tracker.tick();
    expect(leg(id).side).toBe('away');
    expect(leg(id).pWin!).toBeGreaterThan(0.95);
    espnSwaps('final', '2026-11-26T02:30:00.000Z');
    await tracker.tick();
    expect(leg(id).status).toBe('won');
  });

  /** What the old code left behind: stale row, UConn-home state, side home. */
  async function legacyBadLeg(board: 'live' | 'final') {
    const id = await placeInTheMorning();
    const [state] = parseScoreboard(
      'ncaab',
      fixture<EspnScoreboard>(`espn/ncaab-20261125-${board}.json`)
    );
    db.update(events)
      .set({ stateJson: JSON.stringify(state), status: state!.status })
      .where(eq(events.id, EVENT))
      .run();
    db.insert(predictionSnapshots)
      .values({
        betId: id,
        legId: leg(id).id,
        sport: 'ncaab',
        market: 'moneyline',
        takenAt: '2026-11-26T02:15:27.750Z',
        gameStatus: 'in',
        fractionRemaining: 0.055,
        probability: 0.031, // UConn's, priced as the Duke leg
      })
      .run();
    db.update(legs)
      .set({
        pWin: board === 'final' ? 0 : 0.0006,
        status: board === 'final' ? 'lost' : 'open',
      })
      .where(eq(legs.id, leg(id).id))
      .run();
    return id;
  }

  it('flags a live leg whose side disagrees with ESPN', async () => {
    const id = await legacyBadLeg('live');
    const w = legWarnings(leg(id), eventRow());
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/differs from the latest state/);
    // ESPN's number for Duke, by name, not for the stored (wrong) side.
    expect(w[1]).toMatch(
      /likely side mismatch: pWin 0\.001 vs ESPN 0\.991 for Duke \(away/
    );
  });

  it('recompute re-orients an existing bad leg and agrees with a manual won', async () => {
    const id = await legacyBadLeg('final');
    settleBet(db, id, 'won'); // Dan's override
    const r = tracker.recomputeBet(id);
    expect(r.reoriented?.map((x) => x.eventId)).toEqual([EVENT]);
    // Reported, but no conflict with Dan's result. Only the pregame
    // snapshot (taken before the swap) survives.
    expect(r.warnings).toEqual([
      `event ${EVENT} re-oriented: UConn Huskies @ Duke Blue Devils -> Duke Blue Devils @ UConn Huskies; 1 in-game snapshot(s) dropped`,
    ]);
    expect(
      db
        .select()
        .from(predictionSnapshots)
        .all()
        .map((x) => [x.gameStatus, x.outcome])
    ).toEqual([['pre', 1]]);
    expect(leg(id)).toMatchObject({ side: 'away', status: 'won' });
    expect(getBet(db, id)!.bet.status).toBe('won');
  });

  it('recompute keeps a manual result that disagrees, with a warning', async () => {
    const id = await legacyBadLeg('final');
    tracker.recomputeBet(id); // legs: won
    settleBet(db, id, 'void'); // e.g. the book voided it
    const r = tracker.recomputeBet(id);
    expect(getBet(db, id)!.bet.status).toBe('void');
    expect(r.warnings).toEqual([
      'bet ' +
        id +
        ': kept the manual result void; its legs now say won (settle_bet won to accept that)',
    ]);
  });

  it('update_leg re-derives the side from the event by name', async () => {
    const id = await placeInTheMorning();
    // Corrupt the side the way the bug left it, then restate the selection.
    db.update(legs)
      .set({ side: 'away' })
      .where(eq(legs.id, leg(id).id))
      .run();
    const updated = updateLeg(db, leg(id).id, {
      selection: { kind: 'team', team: 'Duke' },
    });
    expect(updated.side).toBe('home'); // Duke is home in the stored row
  });

  it('a second re-orient holding an old row does nothing', async () => {
    const id = await placeInTheMorning();
    const live = boardState('live'); // UConn home
    expect(reorientEvent(db, EVENT, live)).not.toBeNull();
    // e.g. the tick that read the row before add_bet re-oriented it.
    expect(reorientEvent(db, EVENT, live)).toBeNull();
    expect(eventRow().homeName).toBe('UConn Huskies');
    expect(leg(id).side).toBe('away');
  });

  it('a listing re-orient flips the stored state, so recompute keeps it', async () => {
    const id = await placeInTheMorning();
    const [listed] = parseEvents(
      'ncaab',
      'mens-college-basketball',
      fixture<EspnScoreboard>('espn/ncaab-20261125-final.json')
    );
    upsertEvent(db, listed!); // e.g. add_bet on the same game
    const row = eventRow();
    expect(row.homeName).toBe('UConn Huskies');
    const st = JSON.parse(row.stateJson!) as GameState;
    expect(st.home.name).toBe('UConn Huskies');
    expect(row.nextPollAt).toBeNull(); // refetched on the next tick
    const r = tracker.recomputeBet(id);
    expect(r.reoriented).toBeUndefined();
    expect(leg(id).side).toBe('away');
  });

  it('recompute re-settles every bet on a re-oriented event; the scan finds wrong results', async () => {
    const first = createBet(db, dukeMl()).bet.id;
    const second = await placeInTheMorning();
    db.update(events)
      .set({ stateJson: JSON.stringify(boardState('final')), status: 'final' })
      .where(eq(events.id, EVENT))
      .run();
    db.update(legs).set({ pWin: 0, status: 'lost' }).run();
    db.update(bets).set({ status: 'lost' }).run();
    expect(scanSides(db).map((x) => x.betId)).toEqual([first, second]);

    const r = tracker.recomputeBet(first);
    expect(r.warnings).toContain(
      `bet ${second} recomputed too (shares a re-oriented event)`
    );
    for (const id of [first, second]) {
      expect(leg(id)).toMatchObject({ side: 'away', status: 'won' });
      expect(getBet(db, id)!.bet.status).toBe('won');
    }
    expect(scanSides(db)).toEqual([]);
    // A right side with a stale result is still listed.
    db.update(legs).set({ status: 'lost' }).where(eq(legs.betId, second)).run();
    expect(scanSides(db)).toMatchObject([
      { betId: second, problem: 'leg lost, the final says won' },
    ]);
  });

  it('keeps start alerts across a swap: the previous state is flipped, not dropped', async () => {
    await placeInTheMorning();
    const seen: StateChange[] = [];
    tracker.on('state', (c: StateChange) => seen.push(c));
    espnSwaps('live', '2026-11-26T01:55:00.000Z');
    await tracker.tick();
    const c = seen.find((x) => x.next.eventId === EVENT)!;
    expect(c.prev).toMatchObject({
      status: 'pre',
      home: { name: 'UConn Huskies' },
      away: { name: 'Duke Blue Devils' },
    });
    expect(c.event.homeName).toBe('UConn Huskies');
  });

  it('a manual result before the games are final: no "settle_bet open" advice', async () => {
    const id = await placeInTheMorning();
    settleBet(db, id, 'won'); // e.g. a cash-out
    const r = tracker.recomputeBet(id);
    expect(getBet(db, id)!.bet.status).toBe('won');
    expect(r.warnings).toEqual([
      `bet ${id}: kept the manual result won; its games are not all final yet`,
    ]);
  });

  it('no side warnings on a total', async () => {
    const id = await placeInTheMorning({
      ...dukeMl(['UConn', 'Duke'], {
        market: 'total',
        selection: { kind: 'over' },
        line: 146.5,
        price: -110,
      }),
      price: -110,
    });
    db.update(events)
      .set({ stateJson: JSON.stringify(boardState('live')), status: 'in' })
      .where(eq(events.id, EVENT))
      .run();
    expect(leg(id).side).toBeNull();
    expect(legWarnings(leg(id), eventRow())).toEqual([]);
  });
});
