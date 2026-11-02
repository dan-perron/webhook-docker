import { beforeEach, describe, expect, it } from 'vitest';
import { createBet, getBet } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import type { BetInput } from '../src/domain/betInput.js';
import {
  parseEvents,
  parseScoreboard,
  type EspnScoreboard,
} from '../src/gamestate/espn.js';
import { createProviders } from '../src/gamestate/registry.js';
import { matchEvent, nameScore } from '../src/matching/match.js';
import { matchLegs } from '../src/matching/service.js';
import { evaluateEvent } from '../src/models/evaluate.js';
import { normalCdf } from '../src/models/stats.js';
import { sportKey } from '../src/odds/oddsApi.js';
import { Tracker } from '../src/tracker/tracker.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { PARAMS, prior, state } from './helpers/states.js';

// Men's college basketball. 2026-11-02 board (groups=50, all of D-I):
// UTSA @ San José State, UAB @ McNeese, Bowling Green @ Georgia State,
// Miami @ Florida, Miami (OH) @ James Madison, and Miami (OH) Middletown @
// IU Indianapolis live (4:11 1st half, 42-24).
const board = fixture<EspnScoreboard>('espn/ncaab-20261102.json');
const nov2 = parseEvents('ncaab', 'mens-college-basketball', board);
const id = (n: string) => `espn:ncaab:${n}`;

describe('ncaab is a bet sport', () => {
  it('maps to the Odds API key basketball_ncaab', () => {
    expect(sportKey('ncaab')).toBe('basketball_ncaab');
    expect(sportKey('basketball_ncaab')).toBe('basketball_ncaab');
  });

  it('reads the live clock in 20-minute halves, and ESPN win probability', () => {
    const live = parseScoreboard('ncaab', board).find(
      (s) => s.eventId === id('401921173')
    )!;
    expect(live).toMatchObject({
      status: 'in',
      period: 1,
      clockSeconds: 251,
      home: { score: 42 },
      away: { score: 24 },
      situation: { kind: 'basketball', period: 1, clock: 251 },
      providerWinProb: { home: 0.945 },
    });
    // (20:00 of the 2nd half + 4:11) / 40:00 = 1451 / 2400
    expect(live.fractionRemaining).toBeCloseTo(1451 / 2400, 10);
  });

  it('overtime runs on the same 40-minute scale (5-minute periods)', () => {
    const ev = structuredClone(
      board.events!.find((e) => e.id === '401921173')!
    );
    const c = ev.competitions[0]!;
    c.status = { ...c.status!, period: 3, clock: 120 };
    const [ot] = parseScoreboard('ncaab', { events: [ev] });
    // 2:00 left in OT: 120 / 2400
    expect(ot!.fractionRemaining).toBeCloseTo(0.05, 10);
  });
});

describe('college name matching', () => {
  const ev = (n: string) => nov2.find((e) => e.id === id(n))!;

  it('takes ESPN abbreviations, short names and places', () => {
    expect(nameScore('UTSA', ev('401911469').away.aliases)).toBe(1);
    expect(nameScore('UAB', ev('401919014').away.aliases)).toBe(1);
    expect(nameScore('McNeese', ev('401919014').home.aliases)).toBe(1);
    // "St" = State, accents dropped: ESPN's "San José St".
    expect(nameScore('San Jose St', ev('401911469').home.aliases)).toBe(1);
    expect(nameScore('Georgia St.', ev('401910994').home.aliases)).toBe(1);
    // Written out: UT San Antonio = UTSA, Alabama-Birmingham = UAB.
    expect(
      nameScore('UT San Antonio Roadrunners', ev('401911469').away.aliases)
    ).toBe(1);
    expect(nameScore('Alabama-Birmingham', ev('401919014').away.aliases)).toBe(
      1
    );
    // Saint at the front: St. Mary's = Saint Mary's.
    expect(
      nameScore("St. Mary's", ["Saint Mary's Gaels", "Saint Mary's"])
    ).toBe(1);
  });

  it('a name that leads another school only makes it a candidate', () => {
    const miamiOh = ev('401911002').away.aliases;
    expect(nameScore('Miami', miamiOh)).toBe(0.8);
    expect(nameScore('Miami (OH)', miamiOh)).toBe(1);
    expect(nameScore('Miami Ohio', miamiOh)).toBe(1);
    const miamiFl = ev('401906769').away.aliases;
    expect(nameScore('Miami', miamiFl)).toBe(1);
    expect(nameScore('Miami (FL)', miamiFl)).toBe(1);
    expect(nameScore('Miami (OH)', miamiFl)).toBeLessThan(0.85);
    expect(nameScore('Georgia', ev('401910994').home.aliases)).toBe(0.8);
  });

  it.each([
    [['UTSA', 'San Jose St'], '401911469', ['away', 'home']],
    [
      ['UT San Antonio', 'San José State Spartans'],
      '401911469',
      ['away', 'home'],
    ],
    [['UAB', 'McNeese'], '401919014', ['away', 'home']],
    [['UAB Blazers', 'McNeese Cowboys'], '401919014', ['away', 'home']],
    [['Bowling Green', 'Georgia St'], '401910994', ['away', 'home']],
    [['Miami', 'Florida'], '401906769', ['away', 'home']],
    [['Miami (FL)', 'Florida'], '401906769', ['away', 'home']],
    [['Miami (OH)', 'James Madison'], '401911002', ['away', 'home']],
  ] as const)('%j -> %s', (names, eventId, sides) => {
    const r = matchEvent([...names] as [string, string], nov2);
    expect(r.status).toBe('matched');
    if (r.status === 'matched') {
      expect(r.candidate.event.id).toBe(id(eventId));
      expect(r.candidate.sides).toEqual(sides);
    }
  });

  it.each([
    // Miami (OH) plays JMU; plain "Miami" is the Hurricanes.
    [['Miami', 'James Madison'], '401911002'],
    // Georgia State, not Georgia.
    [['Georgia', 'Bowling Green'], '401910994'],
  ] as const)('%j is ambiguous: candidates, top %s', (names, eventId) => {
    const r = matchEvent([...names] as [string, string], nov2);
    expect(r.status).toBe('needs_confirmation');
    if (r.status === 'needs_confirmation')
      expect(r.candidates[0]!.event.id).toBe(id(eventId));
  });
});

describe('ncaab live model (basketball_normal, 40 minutes)', () => {
  // Halftime, home up 38-30, home favored by 2 pregame (prior P 0.6),
  // league σ 11. f = 1/2:
  //   mean = 8 + 2 x 0.5 = 9, sd = 11 x sqrt(0.5) = 7.778
  //   P(m >= 1) ≈ Φ((9 - 0.5) / 7.778) = Φ(1.0928) = 0.8628
  //   P(m = 0) ≈ φ(9 / 7.778) / 7.778 = φ(1.1571) / 7.778 = 0.0263,
  //   won in OT by home with 0.5 + (0.6 - 0.5) x 0.5 = 0.55
  //   P(home ML) ≈ 0.8628 + 0.0263 x 0.55 = 0.8773
  const half = state('ncaab', {
    homeScore: 38,
    awayScore: 30,
    period: 1,
    clockSeconds: 0,
    fractionRemaining: 0.5,
    situation: { kind: 'basketball', period: 1, clock: 0 },
  });
  const pre = prior({ homeWin: 0.6, awayWin: 0.4, expectedMargin: 2 });
  const evalAt = (s = half) =>
    evaluateEvent(
      'ncaab',
      s,
      pre,
      [
        { market: 'moneyline', kind: 'team', side: 'home', line: null },
        { market: 'spread', kind: 'team', side: 'away', line: 6.5 },
      ],
      { params: PARAMS }
    );

  it('halftime: moneyline and spread from Normal(9, 7.78)', () => {
    const [ml, spread] = evalAt();
    expect(ml!.model).toBe('basketball_normal');
    expect(ml!.inputs).toMatchObject({
      marginMean: 9,
      marginSd: 7.78,
      sigma: 11,
      fractionRemaining: 0.5,
    });
    const sd = 11 * Math.sqrt(0.5);
    const phi = (z: number) => Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
    const hand =
      normalCdf((9 - 0.5) / sd) + (phi(9 / sd) / sd) * (0.5 + 0.1 * 0.5);
    expect(hand).toBeCloseTo(0.8773, 3);
    expect(ml!.outcome.win).toBeCloseTo(hand, 3);
    // Away +6.5 covers when home wins by 6 or less: P(m <= 6) ≈
    // Φ((6.5 - 9) / 7.778) = Φ(-0.3214) = 0.374 (an OT game ends ±3: covers).
    expect(spread!.outcome.win).toBeCloseTo(normalCdf((6.5 - 9) / sd), 2);
    expect(spread!.outcome.push).toBe(0);
  });

  it('is tighter than the NBA at the same state (σ 11 vs 13)', () => {
    const nba = evaluateEvent(
      'nba',
      { ...half, sport: 'nba' },
      pre,
      [{ market: 'moneyline', kind: 'team', side: 'home', line: null }],
      { params: PARAMS }
    )[0]!;
    expect(evalAt()[0]!.outcome.win).toBeGreaterThan(nba.outcome.win);
  });

  it('postponed/canceled stays open at its pregame value for settle_bet', () => {
    const [ml] = evalAt({ ...half, status: 'final', cancelled: true });
    expect(ml!.status).toBe('open');
    expect(ml!.model).toBe('postponed');
    // Pregame: mean 2, sd 11 -> P(home) ≈ Φ(1.5 / 11) + tie share ≈ 0.57
    expect(ml!.outcome.win).toBeGreaterThan(0.5);
    expect(ml!.outcome.win).toBeLessThan(0.65);
  });
});

describe('settling an ncaab parlay from ESPN finals', () => {
  // 2025-11-15 finals: UConn 86 BYU 84, Louisville 106 Ohio 81,
  // St. John's 93 William & Mary 60 (total 153).
  let db: Db;
  const parlay = (uconnLine: number | null): BetInput => ({
    book: 'FanDuel',
    placedAt: '2025-11-15T16:00:00.000Z',
    stake: 10,
    price: 596,
    origin: 'own',
    legs: [
      {
        sport: 'ncaab',
        eventDate: '2025-11-15',
        participants: ['BYU', 'UConn'],
        market: uconnLine == null ? 'moneyline' : 'spread',
        selection: { kind: 'team', team: 'UConn' },
        line: uconnLine,
        price: -150,
      },
      {
        sport: 'ncaab',
        eventDate: '2025-11-15',
        participants: ['Ohio', 'Louisville'],
        market: 'spread',
        selection: { kind: 'team', team: 'Louisville' },
        line: -20.5,
        price: -110,
      },
      {
        sport: 'ncaab',
        eventDate: '2025-11-15',
        participants: ['William & Mary', "St. John's"],
        market: 'total',
        selection: { kind: 'over' },
        line: 150.5,
        price: -110,
      },
    ],
  });

  beforeEach(() => {
    db = openDb(':memory:');
  });

  const run = async (input: BetInput) => {
    const { bet } = createBet(db, input);
    const { fetcher } = fakeFetcher({
      'mens-college-basketball/scoreboard?dates=2025111':
        'espn/ncaab-20251115-final.json',
    });
    const providers = createProviders(fetcher);
    await matchLegs(db, providers);
    const tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => new Date('2025-11-16T08:00:00.000Z'),
    });
    await tracker.tick();
    return getBet(db, bet.id)!;
  };

  it('UConn ML, Louisville -20.5 (won by 25), over 150.5 (153): won', async () => {
    const b = await run(parlay(null));
    expect(b.legs.map((l) => l.matchStatus)).toEqual([
      'matched',
      'matched',
      'matched',
    ]);
    expect(b.legs.map((l) => l.status)).toEqual(['won', 'won', 'won']);
    expect(b.bet.status).toBe('won');
  });

  it('UConn -2.5 (won by 2) loses the parlay', async () => {
    const b = await run(parlay(-2.5));
    expect(b.legs.map((l) => l.status)).toEqual(['lost', 'won', 'won']);
    expect(b.bet.status).toBe('lost');
  });
});
