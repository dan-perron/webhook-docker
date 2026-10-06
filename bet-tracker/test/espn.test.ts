import { describe, expect, it } from 'vitest';
import {
  EspnProvider,
  parseAmerican,
  parseEvents,
  parseScoreboard,
  type EspnScoreboard,
} from '../src/gamestate/espn.js';
import type { GameState } from '../src/gamestate/types.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';

const cfb = fixture<EspnScoreboard>('espn/ncaaf-20261003-afternoon.json');
const byId = (states: GameState[], id: string) =>
  states.find((s) => s.eventId === id)!;

describe('ESPN football scoreboard', () => {
  const states = parseScoreboard('ncaaf', cfb, '2026-10-03T19:30:00.000Z');

  it('UCF @ Houston, 1:08 4th, UCF ball 4th & 6 at own 29', () => {
    const s = byId(states, 'espn:ncaaf:401856819');
    expect(s.status).toBe('in');
    expect(s.home).toEqual({ name: 'Houston Cougars', abbr: 'HOU', score: 27 });
    expect(s.away.score).toBe(17);
    expect(s.period).toBe(4);
    expect(s.clockSeconds).toBe(68);
    // 68 s of 3600 left
    expect(s.fractionRemaining).toBeCloseTo(68 / 3600, 10);
    expect(s.situation).toEqual({
      kind: 'football',
      possession: 'away',
      down: 4,
      distance: 6,
      yardsToGoal: 71,
      text: '4th & 6 at UCF 29',
    });
    expect(s.providerWinProb?.home).toBe(0.999);
  });

  it('home team in opponent territory: UConn at SYR 42 is 42 to go', () => {
    const s = byId(states, 'espn:ncaaf:401858252');
    expect(s.situation).toMatchObject({
      possession: 'home',
      down: 2,
      yardsToGoal: 42,
    });
    // 2:43 left in the 4th
    expect(s.fractionRemaining).toBeCloseTo(163 / 3600, 10);
  });

  it('home team on own side: Buffalo at BUF 28 is 72 to go', () => {
    const s = byId(states, 'espn:ncaaf:401866432');
    expect(s.situation).toMatchObject({ possession: 'home', yardsToGoal: 72 });
  });

  it('halftime has no down/distance', () => {
    const s = states.find((x) => x.detail === 'Halftime')!;
    expect(s.fractionRemaining).toBeCloseTo(0.5, 10);
    expect(s.situation).toMatchObject({
      possession: null,
      down: null,
      distance: null,
    });
  });

  it('final: Minnesota 20 Michigan 14, home wins', () => {
    const s = byId(states, 'espn:ncaaf:401858474');
    expect(s.status).toBe('final');
    expect(s.winner).toBe('home');
    expect(s.fractionRemaining).toBe(0);
    expect(s.situation).toBeNull();
  });

  it('scheduled game is pre with full fraction remaining', () => {
    const s = byId(states, 'espn:ncaaf:401871089');
    expect(s.status).toBe('pre');
    expect(s.fractionRemaining).toBe(1);
  });
});

describe('ESPN pregame lines', () => {
  it('NFL: LAR @ PHI, home +154 / away -185, PHI +3.5, total 42.5', () => {
    const events = parseEvents(
      'nfl',
      'nfl',
      fixture('espn/nfl-20261004-pre.json')
    );
    const e = events.find((x) => x.id === 'espn:nfl:401872970')!;
    expect(e.home.name).toBe('Philadelphia Eagles');
    expect(e.away.aliases).toContain('LAR');
    expect(e.pregameLines).toEqual({
      source: 'espn:DraftKings',
      homeMoneyline: 154,
      awayMoneyline: -185,
      drawMoneyline: null,
      spreadHome: 3.5,
      total: 42.5,
      // This recording predates price capture: no spread/total prices.
      spreadHomePrice: null,
      spreadAwayPrice: null,
      overPrice: null,
      underPrice: null,
    });
  });

  it('soccer: Portugal -165 / Norway +330 / draw +330, total 3.5', () => {
    const events = parseEvents(
      'soccer',
      'uefa.nations',
      fixture('espn/soccer-uefa.nations-20261004-pre.json')
    );
    const e = events.find((x) => x.id === 'espn:soccer:401861126')!;
    expect(e.league).toBe('uefa.nations');
    expect(e.pregameLines).toMatchObject({
      homeMoneyline: -165,
      awayMoneyline: 330,
      drawMoneyline: 330,
      total: 3.5,
    });
  });

  it('parses ESPN odds strings', () => {
    expect(parseAmerican('+154')).toBe(154);
    expect(parseAmerican('-212')).toBe(-212);
    expect(parseAmerican('EVEN')).toBe(100);
    expect(parseAmerican('o3.5')).toBeNull();
    expect(parseAmerican(undefined)).toBeNull();
  });
});

describe('ESPN spread and total prices', () => {
  it('NHL: CAR @ MTL puck line and total prices (pointSpread / total objects)', () => {
    const e = parseEvents(
      'nhl',
      'nhl',
      fixture('espn/nhl-20261006-pre.json')
    ).find((x) => x.home.name.includes('Canadiens'))!;
    expect(e.pregameLines).toEqual({
      source: 'espn:DraftKings',
      homeMoneyline: 100,
      awayMoneyline: -120,
      drawMoneyline: null,
      spreadHome: 1.5,
      spreadHomePrice: -250,
      spreadAwayPrice: 205,
      total: 6.5,
      overPrice: 110,
      underPrice: -130,
    });
  });

  it('WNBA: LV @ GSV spread -1.5 -110/-110, o/u 157.5', () => {
    const e = parseEvents(
      'wnba',
      'wnba',
      fixture('espn/wnba-20261007-pre.json')
    ).find((x) => x.home.name.includes('Valkyries'))!;
    expect(e.pregameLines).toMatchObject({
      spreadHome: -1.5,
      spreadHomePrice: -110,
      spreadAwayPrice: -110,
      total: 157.5,
      overPrice: -105,
      underPrice: -115,
    });
  });
});

describe('ESPN NHL and WNBA games', () => {
  it('NHL finals: OT and shootout winners by one, shootout goal counted', () => {
    const states = parseScoreboard(
      'nhl',
      fixture('espn/nhl-20260301-final.json')
    );
    const so = states.find((s) => s.detail === 'Final/SO')!;
    expect(so).toMatchObject({
      status: 'final',
      winner: 'home',
      home: { score: 3 },
      away: { score: 2 },
    });
    const ot = states.find((s) => s.detail === 'Final/OT')!;
    expect(Math.abs(ot.home.score - ot.away.score)).toBe(1);
  });

  it('NHL live clock: 2nd period, 12:00 left -> 32 of 60 minutes remain', () => {
    const board = fixture<EspnScoreboard>('espn/nhl-20261006-pre.json');
    const c = board.events![0]!.competitions[0]!;
    c.status = {
      clock: 720,
      period: 2,
      type: {
        name: 'STATUS_IN_PROGRESS',
        state: 'in',
        completed: false,
        shortDetail: '12:00 - 2nd',
      },
    };
    const [s] = parseScoreboard('nhl', { events: [board.events![0]!] });
    expect(s!.fractionRemaining).toBeCloseTo(1920 / 3600, 10);
    expect(s!.situation).toEqual({
      kind: 'hockey',
      period: 2,
      clock: 720,
      postseason: false,
    });
  });

  it('WNBA live clock: 4th quarter, 2:00 left; postseason flagged', () => {
    const board = fixture<EspnScoreboard>('espn/wnba-20261007-pre.json');
    const c = board.events![0]!.competitions[0]!;
    c.status = {
      clock: 120,
      period: 4,
      type: {
        name: 'STATUS_IN_PROGRESS',
        state: 'in',
        completed: false,
        shortDetail: '2:00 - 4th',
      },
    };
    const [s] = parseScoreboard('wnba', { events: [board.events![0]!] });
    expect(s!.fractionRemaining).toBeCloseTo(120 / 2400, 10);
    expect(s!.postseason).toBe(true);
  });
});

describe('ESPN MMA and MLB', () => {
  it('each UFC fight is its own event; fight order 1 is "home"', () => {
    const events = parseEvents(
      'mma',
      'ufc',
      fixture('espn/ufc-20261003-pre.json')
    );
    expect(events).toHaveLength(14);
    const f = events.find((x) => x.id === 'espn:mma:401907088')!;
    expect(f.home.name).toBe('Ateba Gautier');
    expect(f.away.name).toBe('Roman Kopylov');
    expect(f.pregameLines).toBeNull();
  });

  it('MLB Top 8th, 0 out, bases empty', () => {
    const [s] = parseScoreboard(
      'mlb',
      fixture('espn/mlb-20261003-top8.json')
    ).filter((x) => x.status === 'in');
    expect(s!.situation).toEqual({
      kind: 'baseball',
      inning: 8,
      half: 'top',
      outs: 0,
      first: false,
      second: false,
      third: false,
      scheduledInnings: 9,
      // ALDS: postseason extras have no runner on 2nd
      extraInningRunner: false,
    });
    // 14 of 18 half-innings done
    expect(s!.fractionRemaining).toBeCloseTo(4 / 18, 10);
  });
});

describe('EspnProvider', () => {
  it('lists events by local date, reading the next ESPN day too', async () => {
    const { fetcher, requested } = fakeFetcher({
      'college-football/scoreboard?dates=20261003':
        'espn/ncaaf-20261003-afternoon.json',
    });
    const events = await new EspnProvider(fetcher).listEvents(
      'ncaaf',
      '2026-10-03'
    );
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain('dates=20261004');
    expect(events.length).toBeGreaterThan(40);
    expect(events.every((e) => e.league === 'college-football')).toBe(true);
  });

  it('batches state polling into one scoreboard call per sport/date', async () => {
    const { fetcher, requested } = fakeFetcher({
      'college-football/scoreboard?dates=20261003':
        'espn/ncaaf-20261003-afternoon.json',
    });
    const refs = ['401856819', '401858474', '401858252'].map((id) => ({
      id: `espn:ncaaf:${id}`,
      sport: 'ncaaf' as const,
      league: 'college-football',
      startTime: '2026-10-03T16:00:00.000Z',
    }));
    const states = await new EspnProvider(fetcher).getStates(refs);
    expect(requested).toHaveLength(1);
    expect([...states.keys()].sort()).toEqual(refs.map((r) => r.id).sort());
  });
});
