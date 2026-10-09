import { describe, expect, it } from 'vitest';
import { legInputSchema } from '../src/domain/betInput.js';
import { parseScoreboard } from '../src/gamestate/espn.js';
import { createProviders } from '../src/gamestate/registry.js';
import type { GameState } from '../src/gamestate/types.js';
import { detectAlerts } from '../src/scores/alerts.js';
import { liveView } from '../src/tracker/views.js';
import { situationText } from '../src/web/format.js';
import { fakeFetcher, fixture } from './helpers/fixtures.js';
import { state } from './helpers/states.js';

// Scores-only sports: men's college basketball, college hockey, women's
// college volleyball. Real (trimmed) ESPN scoreboards.

const byId = (states: GameState[], id: string) =>
  states.find((s) => s.eventId.endsWith(`:${id}`))!;

describe('ESPN score-only sports', () => {
  it('volleyball: score is sets won; sets carry their points', () => {
    const states = parseScoreboard(
      'ncaawvb',
      fixture('espn/ncaawvb-20261009-live.json')
    );
    const s = byId(states, '401887185');
    // Memphis @ UAB, end of the 2nd set: 25-22 Memphis, 27-25 UAB.
    expect(s).toMatchObject({
      status: 'in',
      home: { name: 'UAB Blazers', score: 1 },
      away: { name: 'Memphis Tigers', score: 1 },
      situation: {
        kind: 'volleyball',
        set: 2,
        sets: [
          { home: 22, away: 25 },
          { home: 27, away: 25 },
        ],
      },
    });
    // Each side needs two more sets of three: 2/3 left.
    expect(s.fractionRemaining).toBeCloseTo(2 / 3);
    expect(
      situationText(liveView({ stateJson: JSON.stringify(s) } as never)!)
    ).toBe('25–22, 25–27');
  });

  it('volleyball final: Wisconsin swept Illinois, 35-33 first set', () => {
    const s = byId(
      parseScoreboard('ncaawvb', fixture('espn/ncaawvb-20251115-final.json')),
      '401780857'
    );
    expect(s).toMatchObject({
      status: 'final',
      winner: 'away',
      away: { name: 'Wisconsin Badgers', score: 3 },
      home: { score: 0 },
      fractionRemaining: 0,
    });
  });

  it("men's basketball: two halves, final", () => {
    const s = byId(
      parseScoreboard('ncaab', fixture('espn/ncaab-20251115-final.json')),
      '401812788'
    );
    expect(s).toMatchObject({
      status: 'final',
      winner: 'home',
      home: { name: 'UConn Huskies', score: 86 },
      away: { name: 'BYU Cougars', score: 84 },
    });
  });

  it('lists the full Division I board and finds Wisconsin hockey', async () => {
    const { fetcher, requested } = fakeFetcher({
      'hockey/mens-college-hockey/scoreboard?dates=20261009':
        'espn/ncaamh-20261009-pre.json',
    });
    const espn = createProviders(fetcher).forSport('ncaamh');
    const events = await espn.listEvents('ncaamh', '2026-10-09');
    const wis = events.find((e) => e.away.name === 'Wisconsin Badgers')!;
    expect(wis).toMatchObject({
      id: 'espn:ncaamh:401904655',
      league: 'mens-college-hockey',
      home: { name: 'Minnesota State Mavericks' },
    });
    expect(wis.away.aliases).toContain('Wisconsin');
    expect(requested[0]).toContain('&limit=500');

    await createProviders(fetcher)
      .forSport('ncaab')
      .listEvents('ncaab', '2026-11-15');
    expect(requested.at(-1)).toContain(
      'basketball/mens-college-basketball/scoreboard?dates=20261116&groups=50&limit=500'
    );
  });
});

describe('score-only sports', () => {
  it("can't be bet on", () => {
    const leg = (sport: string) =>
      legInputSchema.safeParse({
        sport,
        eventDate: '2026-11-15',
        participants: ['Wisconsin', 'Marquette'],
        market: 'moneyline',
        selection: { kind: 'team', team: 'Wisconsin' },
        price: -150,
      });
    expect(leg('ncaab').success).toBe(false);
    expect(leg('ncaaf').success).toBe(true);
  });

  it('volleyball alerts a fifth set once, and lead changes by sets', () => {
    const vb = (set: number, home: number, away: number) =>
      state('ncaawvb', {
        homeScore: home,
        awayScore: away,
        detail: `${set}th Set`,
        situation: { kind: 'volleyball', set, sets: [] },
      });
    expect(detectAlerts(vb(4, 2, 1), vb(5, 2, 2), 'home').alerts).toEqual([
      {
        kind: 'close',
        key: 'close',
        title: '🏐 Fifth set: Away @ Home',
        body: '5th Set',
      },
    ]);
    expect(
      detectAlerts(vb(3, 1, 1), vb(4, 1, 2), 'home').alerts.map((a) => a.kind)
    ).toEqual(['lead']);
  });

  it('college hockey: close late is a one-goal game, last 10 minutes', () => {
    const late = state('ncaamh', { fractionRemaining: 1 / 6 });
    expect(
      detectAlerts(
        late,
        {
          ...late,
          home: { ...late.home, score: 2 },
          away: { ...late.away, score: 1 },
        },
        'home'
      ).alerts.map((a) => a.kind)
    ).toEqual(['close']);
  });
});
