import { describe, expect, it, vi } from 'vitest';
import {
  NflWatchGuide,
  nflWatchInfo,
  parseNflGuide,
  type NflCoverage,
} from '../src/gamestate/nflWatch.js';
import { fixture } from './helpers/fixtures.js';
import { state } from './helpers/states.js';
import { EspnProvider, type EspnScoreboard } from '../src/gamestate/espn.js';

const location = { zipCode: '60640', name: 'Chicago', dmaCode: '602' };
const checkedAt = '2026-10-13T19:00:00.000Z';
const raw = fixture<unknown>('nfl/watch-week6.json');
const flight = `a:${JSON.stringify(raw)}\n`;
// Production pages split Flight records across script blocks.
const html = [flight.slice(0, 171), flight.slice(171)]
  .map((c) => `<script>self.__next_f.push([1,${JSON.stringify(c)}])</script>`)
  .join('');
const games = parseNflGuide(html);
const gameState = (home: string, away: string) => {
  const g = games.find((g) => g.home === home && g.away === away)!;
  return state('nfl', {
    startTime: g.startTime,
    status: 'pre',
    home: {
      name: home,
      abbr: home.includes('Chicago') ? 'CHI' : 'HOME',
      score: 0,
    },
    away: {
      name: away,
      abbr: away.includes('Chicago') ? 'CHI' : 'AWAY',
      score: 0,
    },
  });
};
const info = (home: string, away: string, coverage = games) =>
  nflWatchInfo(
    gameState(home, away),
    coverage,
    location,
    'https://www.nfl.com/ways-to-watch/by-week/week-6',
    checkedAt
  );

describe('Chicago NFL watch guide', () => {
  it('reads real coverage records split across page payload chunks', () => {
    expect(games).toHaveLength(14);
    expect(games.find((g) => g.home === 'Atlanta Falcons')).toMatchObject({
      networks: ['FOX'],
      streams: ['FOX One'],
      dmaCodes: expect.arrayContaining(['602']),
    });
    expect(parseNflGuide('<html>no data</html>')).toEqual([]);
  });
  it('confirms the regional Bears game is on Chicago FOX OTA', () => {
    expect(info('Atlanta Falcons', 'Chicago Bears')).toMatchObject({
      ota: 'yes',
      location: 'Chicago 60640',
      channels: ['FOX 32 · WFLD 32.1'],
      streams: ['FOX One'],
    });
  });
  it('rules out a conflicting FOX game and offers out-of-market Sunday Ticket', () => {
    expect(info('Cleveland Browns', 'Baltimore Ravens')).toMatchObject({
      ota: 'no',
      streams: ['NFL Sunday Ticket'],
    });
  });
  it('keeps an incomplete CBS assignment unconfirmed instead of claiming no', () => {
    expect(info('New England Patriots', 'New York Jets').ota).toBe('unknown');
  });
  it('requires an exact matchup and start time; future or failed maps stay unknown', () => {
    const s = gameState('Atlanta Falcons', 'Chicago Bears');
    s.startTime = '2025-10-18T17:00:00Z';
    expect(nflWatchInfo(s, games, location, 'guide', checkedAt).ota).toBe(
      'unknown'
    );
    expect(info('Atlanta Falcons', 'Chicago Bears', []).ota).toBe('unknown');
    const missing: NflCoverage[] = games.map((g) => ({
      ...g,
      hasMap: false,
      dmaCodes: [],
    }));
    expect(info('Atlanta Falcons', 'Chicago Bears', missing).ota).toBe(
      'unknown'
    );
    expect(
      info(
        'Cleveland Browns',
        'Baltimore Ravens',
        games.map((g) =>
          g.home === 'Cleveland Browns'
            ? { ...g, hasMap: false, dmaCodes: [] }
            : g
        )
      ).ota
    ).toBe('unknown');
  });
  it('shows NBC OTA and Peacock; a Prime game requires streaming in Chicago', () => {
    expect(info('Green Bay Packers', 'Dallas Cowboys')).toMatchObject({
      ota: 'yes',
      channels: expect.arrayContaining(['NBC 5 · WMAQ 5.1']),
      streams: ['Peacock'],
    });
    expect(info('Denver Broncos', 'Seattle Seahawks')).toMatchObject({
      ota: 'no',
      streams: ['Prime Video'],
    });
  });
  it('does not add Sunday Ticket to postseason games', () => {
    expect(
      info(
        'Cleveland Browns',
        'Baltimore Ravens',
        games.map((g) => ({ ...g, regularSeason: false }))
      ).streams
    ).toEqual([]);
  });
  it('caches and coalesces guide requests, refreshes maps, and retries failures without losing scores', async () => {
    let clock = new Date(checkedAt);
    const fetchPage = vi.fn().mockResolvedValue(html);
    const guide = new NflWatchGuide(location, fetchPage, () => clock);
    const states = [gameState('Atlanta Falcons', 'Chicago Bears')];
    await Promise.all([guide.enrich(states, 6, 2), guide.enrich(states, 6, 2)]);
    await guide.enrich(states, 6, 2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(states[0]!.watch?.ota).toBe('yes');
    clock = new Date(clock.getTime() + 3600_001);
    fetchPage.mockRejectedValueOnce(new Error('offline'));
    await guide.enrich(states, 6, 2);
    expect(states[0]!.watch?.ota).toBe('unknown');
    expect(states[0]!.status).toBe('pre');
    await guide.enrich(states, 6, 2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    clock = new Date(clock.getTime() + 300_001);
    await guide.enrich(states, 6, 2);
    expect(states[0]!.watch?.ota).toBe('yes');
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
  it('provider polling enriches saved states without introducing a second score fetch', async () => {
    const board = fixture<EspnScoreboard>('espn/nfl-20261004-pre.json');
    const fetcher = vi.fn().mockResolvedValue(board);
    const guide = new NflWatchGuide(
      location,
      async () => html,
      () => new Date(checkedAt)
    );
    const provider = new EspnProvider(fetcher, [], guide);
    const states = await provider.getStates([
      {
        id: 'espn:nfl:401872970',
        sport: 'nfl',
        league: 'nfl',
        startTime: '2026-10-04T17:00:00Z',
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(states.get('espn:nfl:401872970')?.watch).toMatchObject({
      location: 'Chicago 60640',
      ota: 'unknown',
    });
  });
});
