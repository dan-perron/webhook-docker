import { beforeEach, describe, expect, it } from 'vitest';
import { listBets } from '../src/db/bets.js';
import { openDb, type Db } from '../src/db/client.js';
import { events } from '../src/db/schema.js';
import { parseEvents, type EspnScoreboard } from '../src/gamestate/espn.js';
import { createProviders } from '../src/gamestate/registry.js';
import {
  matchEvent,
  nameScore,
  normalizeName,
  teamAliases,
} from '../src/matching/match.js';
import { confirmLegMatch, matchLegs } from '../src/matching/service.js';
import { loadSeed } from '../src/seed/load.js';
import { fakeFetcher, fixture, SEED_ROUTES } from './helpers/fixtures.js';

const cfbEvents = parseEvents(
  'ncaaf',
  'college-football',
  fixture<EspnScoreboard>('espn/ncaaf-20261003-afternoon.json')
);

describe('name scoring', () => {
  it('normalizes accents, punctuation and filler words', () => {
    expect(normalizeName('Roberto Soldić')).toBe('roberto soldic');
    expect(normalizeName('Miami (OH) RedHawks')).toBe('miami oh redhawks');
    expect(normalizeName('The University of Texas')).toBe('texas');
  });

  it('exact alias 1.0; leading words 0.9; unrelated low', () => {
    const minn = ['Minnesota Golden Gophers', 'Minnesota', 'MINN'];
    expect(nameScore('Minnesota', minn)).toBe(1);
    expect(nameScore('Minnesota Golden', minn)).toBe(0.9);
    expect(nameScore('Michigan', minn)).toBeLessThan(0.5);
  });

  it('"Michigan" partially matches Michigan State but needs both teams', () => {
    const msu = ['Michigan State Spartans', 'Michigan State', 'MSU'];
    expect(nameScore('Michigan', msu)).toBe(0.9);
    // Only one event has both Michigan and Minnesota.
    const r = matchEvent(['Michigan', 'Minnesota'], cfbEvents);
    expect(r.status).toBe('matched');
    if (r.status === 'matched')
      expect(r.candidate.event.id).toBe('espn:ncaaf:401858474');
  });

  it('tolerates a typo', () => {
    const r = matchEvent(['Mississipi State', 'Alabama'], cfbEvents);
    expect(r.status).toBe('matched');
  });
});

describe('matchEvent never guesses', () => {
  it('returns candidates when two events fit', () => {
    // Duplicate the game under another id: two confident events.
    const twin = {
      ...cfbEvents.find((e) => e.id === 'espn:ncaaf:401858474')!,
      id: 'x',
    };
    const r = matchEvent(['Michigan', 'Minnesota'], [...cfbEvents, twin]);
    expect(r.status).toBe('needs_confirmation');
    if (r.status === 'needs_confirmation') expect(r.candidates).toHaveLength(2);
  });

  it('returns candidates, not a match, when only one team matches', () => {
    const r = matchEvent(['Minnesota', 'Ohio State'], cfbEvents);
    expect(r.status).not.toBe('matched');
  });

  it('unmatched when nothing resembles the teams', () => {
    expect(matchEvent(['Zzyzx', 'Qwerty'], cfbEvents).status).toBe('unmatched');
  });
});

describe('matchLegs on the seed bets (recorded 10/3-10/4 data)', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    loadSeed(db);
  });

  it('matches all 24 legs with the right event and side', async () => {
    const { fetcher } = fakeFetcher(SEED_ROUTES);
    const out = await matchLegs(db, createProviders(fetcher));
    expect(out).toHaveLength(24);
    const unmatched = out.filter((o) => o.status !== 'matched');
    expect(unmatched).toEqual([]);

    const legs = listBets(db).flatMap((b) => b.legs);
    const leg = (team: string | null, label?: string) =>
      legs.find(
        (l) => l.selectionTeam === team && (!label || l.eventLabel === label)
      )!;

    expect(leg('Chicago White Sox')).toMatchObject({
      eventId: 'mlb:849829',
      side: 'away',
    });
    expect(leg('Cleveland Guardians')).toMatchObject({
      eventId: 'mlb:849829',
      side: 'home',
    });
    expect(leg('Milwaukee Brewers')).toMatchObject({
      eventId: 'mlb:849830',
      side: 'home',
    });
    expect(leg('San Diego Padres')).toMatchObject({
      eventId: 'mlb:849830',
      side: 'away',
    });
    expect(leg('Roman Kopylov')).toMatchObject({
      eventId: 'espn:mma:401907088',
      side: 'away',
    });
    expect(leg('Natalia Silva')).toMatchObject({
      eventId: 'espn:mma:401912278',
      side: 'home',
    });
    expect(leg('Minnesota')).toMatchObject({
      eventId: 'espn:ncaaf:401858474',
      side: 'home',
    });
    expect(leg('Mississippi State')).toMatchObject({
      eventId: 'espn:ncaaf:401856707',
      side: 'home',
    });
    expect(leg('UCF')).toMatchObject({
      eventId: 'espn:ncaaf:401856819',
      side: 'away',
    });
    expect(leg('Los Angeles Rams')).toMatchObject({
      eventId: 'espn:nfl:401872970',
      side: 'away',
    });

    const draw = legs.find((l) => l.selectionKind === 'draw')!;
    expect(draw).toMatchObject({
      eventId: 'espn:soccer:401861126',
      side: null,
    });
    const over = legs.find(
      (l) => l.selectionKind === 'over' && l.line === 41.5
    )!;
    expect(over).toMatchObject({ eventId: 'espn:ncaaf:401858474', side: null });
  });

  it('stores events once, with free pregame lines for pre-game events', async () => {
    const { fetcher } = fakeFetcher(SEED_ROUTES);
    await matchLegs(db, createProviders(fetcher));
    const rows = db.select().from(events).all();
    // 4 MLB + 3 UFC + 11 distinct NCAAF + 1 NFL + 1 soccer
    expect(rows).toHaveLength(20);
    const rams = rows.find((r) => r.id === 'espn:nfl:401872970')!;
    expect(JSON.parse(rams.providerLinesJson!)).toMatchObject({
      spreadHome: 3.5,
    });
  });

  it('lists each sport/date once for the whole batch', async () => {
    const { fetcher, requested } = fakeFetcher(SEED_ROUTES);
    await matchLegs(db, createProviders(fetcher));
    const cfbCalls = requested.filter((u) => u.includes('college-football'));
    expect(cfbCalls).toHaveLength(2); // 10/3 plus the next ESPN day
  });

  it('holds ambiguous legs for confirmation, then confirms one', async () => {
    // A board listing the Minnesota game twice (e.g. a duplicate feed entry).
    const board = fixture<EspnScoreboard>('espn/ncaaf-20261003-afternoon.json');
    const game = board.events!.find((e) => e.id === '401858474')!;
    const dup = structuredClone(game);
    dup.id = dup.competitions[0]!.id = '999';
    board.events!.push(dup);
    const fetcher = async (url: string) =>
      url.includes('dates=20261003') ? board : { events: [] };

    const legId = listBets(db)
      .flatMap((b) => b.legs)
      .find((l) => l.selectionTeam === 'Minnesota')!.id;
    const [out] = await matchLegs(db, createProviders(fetcher), [legId]);
    expect(out!.status).toBe('needs_confirmation');
    expect(out!.candidates.map((c) => c.eventId).sort()).toEqual([
      'espn:ncaaf:401858474',
      'espn:ncaaf:999',
    ]);
    expect(out!.candidates[0]!.label).toBe(
      'Michigan Wolverines @ Minnesota Golden Gophers'
    );

    expect(() => confirmLegMatch(db, legId, 'espn:ncaaf:401856707')).toThrow(
      /not a candidate/
    );
    const confirmed = confirmLegMatch(db, legId, 'espn:ncaaf:401858474');
    expect(confirmed).toMatchObject({
      status: 'matched',
      side: 'home',
      candidates: [],
    });
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.id)
    ).toEqual(['espn:ncaaf:401858474']);
  });
});

describe('teamAliases', () => {
  it('derives nickname and place from a full name', () => {
    expect(teamAliases('Los Angeles Rams')).toEqual([
      'Los Angeles Rams',
      'Rams',
      'Angeles Rams',
      'Los Angeles',
    ]);
    expect(nameScore('White Sox', teamAliases('Chicago White Sox'))).toBe(1);
    expect(teamAliases('Portugal')).toEqual(['Portugal']);
  });
});
