import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/client.js';
import { scoreAlerts, watches } from '../src/db/schema.js';
import { createProviders } from '../src/gamestate/registry.js';
import type { GameState } from '../src/gamestate/types.js';
import { detectAlerts, inQuietHours, scoreline } from '../src/scores/alerts.js';
import { NtfyNotifier, type PostJson } from '../src/scores/ntfy.js';
import { parseTeams, type ScoreService } from '../src/scores/service.js';
import { Tracker } from '../src/tracker/tracker.js';
import { fakeFetcher, SEED_ROUTES } from './helpers/fixtures.js';
import {
  recordingNotifier,
  scoreService,
  type Sent,
} from './helpers/scores.js';
import { PARAMS, state } from './helpers/states.js';

const nfl = (over: Parameters<typeof state>[1] = {}) =>
  state('nfl', {
    home: { name: 'Chicago Bears', abbr: 'CHI', score: 0 },
    away: { name: 'New York Jets', abbr: 'NYJ', score: 0 },
    detail: '8:00 - 2nd',
    fractionRemaining: 0.6,
    ...over,
  });
const scores = (g: GameState, home: number, away: number): GameState => ({
  ...g,
  home: { ...g.home, score: home },
  away: { ...g.away, score: away },
});

describe('detectAlerts', () => {
  it('records the leader but never alerts on a first fetch', () => {
    const r = detectAlerts(null, scores(nfl(), 7, 3), null);
    expect(r).toEqual({ alerts: [], lastLeader: 'home' });
  });

  it('alerts when a game starts', () => {
    const r = detectAlerts(nfl({ status: 'pre' }), nfl(), null);
    expect(r.alerts.map((a) => a.kind)).toEqual(['start']);
    expect(r.alerts[0]!.title).toBe(
      '🏈 Started: New York Jets @ Chicago Bears'
    );
  });

  it('a lead change goes through ties: 7-3, 10-10, 10-13', () => {
    const tied = detectAlerts(
      scores(nfl(), 7, 3),
      scores(nfl(), 10, 10),
      'home'
    );
    expect(tied).toEqual({ alerts: [], lastLeader: 'home' });
    const flipped = detectAlerts(
      scores(nfl(), 10, 10),
      scores(nfl(), 10, 13),
      'home'
    );
    expect(flipped.lastLeader).toBe('away');
    expect(flipped.alerts).toEqual([
      {
        kind: 'lead',
        key: 'lead:13-10',
        title: '🏈 Lead change: New York Jets 13–10',
        body: 'New York Jets @ Chicago Bears · 8:00 - 2nd',
      },
    ]);
  });

  it('taking the first lead is not a lead change', () => {
    const r = detectAlerts(scores(nfl(), 0, 0), scores(nfl(), 0, 7), null);
    expect(r).toEqual({ alerts: [], lastLeader: 'away' });
  });

  it('close late: NFL within 8 with 1/8 left; not within 9', () => {
    const late = nfl({ fractionRemaining: 0.125, detail: '7:30 - 4th' });
    const close = detectAlerts(late, scores(late, 21, 14), 'home');
    expect(close.alerts.map((a) => a.key)).toEqual(['close']);
    expect(close.alerts[0]!.title).toBe('🏈 Close late: Chicago Bears 21–14');
    expect(detectAlerts(late, scores(late, 23, 14), 'home').alerts).toEqual([]);
    // Not late yet: 1/8 + a bit left.
    const early = nfl({ fractionRemaining: 0.13 });
    expect(detectAlerts(early, scores(early, 21, 14), 'home').alerts).toEqual(
      []
    );
  });

  it('close late: MLB from the top of the 8th (2/9 left), within 2', () => {
    const top8 = state('mlb', { fractionRemaining: 2 / 9 });
    expect(
      detectAlerts(top8, scores(top8, 2, 1), 'home').alerts.map((a) => a.kind)
    ).toEqual(['close']);
  });

  it('final, with the winner first', () => {
    const live = scores(nfl(), 20, 24);
    const final = { ...live, status: 'final' as const, detail: 'Final' };
    const r = detectAlerts(live, final, 'away');
    expect(r.alerts).toEqual([
      {
        kind: 'final',
        key: 'final',
        title: '🏈 Final: New York Jets 24–20',
        body: 'New York Jets @ Chicago Bears · Final',
      },
    ]);
    // Already final: nothing more.
    expect(detectAlerts(final, final, 'away').alerts).toEqual([]);
  });

  it('postponed games say so', () => {
    const r = detectAlerts(
      nfl({ status: 'pre' }),
      nfl({ status: 'final', cancelled: true, detail: 'Postponed' }),
      null
    );
    expect(r.alerts[0]!.title).toBe(
      '🏈 Postponed: New York Jets @ Chicago Bears'
    );
  });

  it('fights only alert start and final', () => {
    const fight = state('mma', { status: 'pre' });
    const r = detectAlerts(fight, { ...fight, status: 'in' }, null);
    expect(r.alerts.map((a) => a.kind)).toEqual(['start']);
    expect(r.lastLeader).toBeNull();
  });

  it('scoreline: leader first, or tied', () => {
    expect(scoreline(scores(nfl(), 3, 3))).toBe('Tied 3–3');
  });
});

describe('inQuietHours', () => {
  const at = (iso: string) => new Date(iso);
  const tz = 'America/Chicago';
  it('wraps midnight', () => {
    // 02:00 and 23:30 CDT inside 23:00-08:00; noon outside.
    expect(inQuietHours('23:00-08:00', at('2026-10-04T07:00:00Z'), tz)).toBe(
      true
    );
    expect(inQuietHours('23:00-08:00', at('2026-10-05T04:30:00Z'), tz)).toBe(
      true
    );
    expect(inQuietHours('23:00-08:00', at('2026-10-04T17:00:00Z'), tz)).toBe(
      false
    );
    // The end is exclusive: 08:00 CDT is not quiet.
    expect(inQuietHours('23:00-08:00', at('2026-10-04T13:00:00Z'), tz)).toBe(
      false
    );
  });
  it('ignores empty or malformed specs', () => {
    expect(inQuietHours('', at('2026-10-04T07:00:00Z'), tz)).toBe(false);
    expect(inQuietHours('late-early', at('2026-10-04T07:00:00Z'), tz)).toBe(
      false
    );
  });
});

describe('NtfyNotifier', () => {
  it('publishes JSON to the server root with the topic, and auth', async () => {
    const calls: Parameters<PostJson>[] = [];
    const n = new NtfyNotifier(
      'https://ntfy.example.com/sub/scores-x',
      'tk',
      (...a) => {
        calls.push(a);
        return Promise.resolve({ ok: true, status: 200 });
      }
    );
    expect(n.configured).toBe(true);
    await n.send({ kind: 'close', title: 'T', body: 'B', click: 'https://c' });
    expect(calls).toEqual([
      [
        'https://ntfy.example.com/sub/',
        {
          topic: 'scores-x',
          title: 'T',
          message: 'B',
          priority: 4,
          click: 'https://c',
        },
        { Authorization: 'Bearer tk' },
      ],
    ]);
  });

  it('is off without a URL and throws on HTTP errors', async () => {
    expect(new NtfyNotifier('').configured).toBe(false);
    const n = new NtfyNotifier('https://ntfy.sh/t', '', async () => ({
      ok: false,
      status: 403,
    }));
    await expect(
      n.send({ kind: 'final', title: 'T', body: 'B' })
    ).rejects.toThrow('ntfy -> 403');
  });
});

it('parseTeams', () => {
  expect(parseTeams('Packers @ Bears')).toEqual(['Packers', 'Bears']);
  expect(parseTeams('Portugal v Norway')).toEqual(['Portugal', 'Norway']);
  expect(parseTeams('Jets vs. Bears')).toEqual(['Jets', 'Bears']);
  expect(parseTeams('Bears')).toEqual(['Bears']);
});

// --- ScoreService against recorded schedules --------------------------------

// Sat 10/3 2:40 PM CDT: CWS @ CLE live (3-0, top 8th); NFL Sunday ahead.
const NOW = new Date('2026-10-03T19:40:00.000Z');

describe('ScoreService', () => {
  let db: Db;
  let clock: Date;
  let tracker: Tracker;
  let svc: ScoreService;
  let sent: Sent[];
  let requested: string[];
  let routes: Record<string, string>;

  const setup = (quietHours = '') => {
    db = openDb(':memory:');
    routes = {
      'statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=':
        'mlb/schedule-20261003.json',
      ...SEED_ROUTES,
    };
    const fake = fakeFetcher(routes);
    requested = fake.requested;
    const providers = createProviders(fake.fetcher);
    clock = NOW;
    tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => clock,
    });
    const rec = recordingNotifier(true);
    sent = rec.sent;
    svc = scoreService(db, providers, tracker, {
      now: () => clock,
      notifier: rec.notifier,
      quietHours,
    });
  };
  beforeEach(() => setup());

  it('follows a team by nickname and adds its games this week', async () => {
    const r = await svc.followTeam('nfl', 'Bears');
    expect(r.status).toBe('followed');
    if (r.status !== 'followed') return;
    expect(r.follow.team).toBe('Chicago Bears');
    expect(r.games.map((g) => g.label)).toEqual([
      'New York Jets @ Chicago Bears',
    ]);
    const b = svc.board();
    expect(b.upcoming.map((g) => [g.label, g.watched, g.followed])).toEqual([
      ['New York Jets @ Chicago Bears', true, true],
    ]);
    expect(b.follows).toEqual([
      {
        id: r.follow.id,
        sport: 'nfl',
        icon: '🏈',
        team: 'Chicago Bears',
        alerts: true,
      },
    ]);
  });

  it('resolves a team on a bye week from later games, adding none yet', async () => {
    clock = new Date('2026-09-25T17:00:00.000Z'); // Bears play 10/4: 9 days out
    const r = await svc.followTeam('nfl', 'Bears');
    expect(r).toMatchObject({
      status: 'followed',
      follow: { team: 'Chicago Bears' },
      games: [],
    });
    expect(svc.board().upcoming).toEqual([]);
    // Within the week, discovery adds it.
    clock = NOW;
    await svc.discover();
    expect(svc.board().upcoming.map((g) => g.label)).toEqual([
      'New York Jets @ Chicago Bears',
    ]);
  });

  it('never guesses between teams', async () => {
    expect(await svc.followTeam('nfl', 'New York')).toEqual({
      status: 'ambiguous',
      candidates: expect.arrayContaining(['New York Jets', 'New York Giants']),
    });
    const none = await svc.followTeam('nfl', 'Raptors');
    expect(none.status).toBe('not_found');
    expect(svc.listFollows()).toEqual([]);
  });

  it('unstarring a followed game hides it; discovery does not re-add it', async () => {
    await svc.followTeam('nfl', 'Bears');
    const [game] = svc.board().upcoming;
    svc.unwatchGame(game!.eventId);
    expect(svc.board().upcoming).toEqual([]);
    await svc.discover();
    expect(svc.board().upcoming).toEqual([]);
    // Starring it again brings it back.
    await svc.watchGame({
      sport: 'nfl',
      date: '2026-10-04',
      eventId: game!.eventId,
    });
    expect(svc.board().upcoming.map((g) => g.eventId)).toEqual([game!.eventId]);
  });

  it('unfollowing drops the auto-added games', async () => {
    const r = await svc.followTeam('nfl', 'Bears');
    if (r.status !== 'followed') throw new Error(r.status);
    svc.unfollowTeam(r.follow.id);
    expect(svc.board()).toMatchObject({ upcoming: [], follows: [] });
  });

  it('watches a single game by teams; an ambiguous name returns choices', async () => {
    const r = await svc.watchGame({
      sport: 'nfl',
      date: '2026-10-04',
      teams: 'Rams @ Eagles',
    });
    expect(r).toMatchObject({
      status: 'watching',
      game: {
        label: 'Los Angeles Rams @ Philadelphia Eagles',
        watched: true,
        alerts: true,
      },
    });
    const choice = await svc.watchGame({
      sport: 'nfl',
      date: '2026-10-04',
      teams: 'New York',
    });
    expect(choice.status).toBe('needs_choice');
    if (choice.status === 'needs_choice')
      expect(choice.candidates.map((c) => c.label).sort()).toEqual([
        'Arizona Cardinals @ New York Giants',
        'New York Jets @ Chicago Bears',
      ]);
    const sched = await svc.schedule('nfl', '2026-10-04');
    expect(sched.filter((g) => g.watched).map((g) => g.label)).toEqual([
      'Los Angeles Rams @ Philadelphia Eagles',
    ]);
  });

  const watchCwsCle = async () => {
    const r = await svc.watchGame({
      sport: 'mlb',
      date: '2026-10-03',
      teams: 'White Sox',
    });
    if (r.status !== 'watching') throw new Error(r.status);
    return r.game;
  };

  it('polls a watched game without fetching any lines (bets only)', async () => {
    const g = await watchCwsCle();
    expect(g.live).toMatchObject({
      status: 'in',
      away: { name: 'Chicago White Sox', score: 3 },
      home: { name: 'Cleveland Guardians', score: 0 },
    });
    expect(g.leader).toBe('away');
    expect(requested.some((u) => u.includes('site.api.espn.com'))).toBe(false);
    expect(svc.board().live.map((c) => c.eventId)).toEqual([g.eventId]);
  });

  it('pushes the final once, and keeps it on the board', async () => {
    const g = await watchCwsCle();
    expect(sent).toEqual([]); // added mid-game: no alert for what already happened
    routes['statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks='] =
      'mlb/schedule-849829-gameover.json';
    clock = new Date(NOW.getTime() + 60_000);
    await tracker.tick();
    await svc.flush();
    expect(sent).toEqual([
      {
        kind: 'final',
        title: '⚾ Final: Chicago White Sox 3–0',
        body: expect.stringContaining(
          'Chicago White Sox @ Cleveland Guardians'
        ),
      },
    ]);
    const rows = db.select().from(scoreAlerts).all();
    expect(rows.map((r) => [r.key, r.delivery])).toEqual([['final', 'sent']]);
    clock = new Date(NOW.getTime() + 120_000);
    await tracker.tick();
    await svc.flush();
    expect(sent).toHaveLength(1);
    const b = svc.board();
    expect(b.final.map((c) => c.eventId)).toEqual([g.eventId]);
    expect(b.alerts.map((a) => a.title)).toEqual([
      '⚾ Final: Chicago White Sox 3–0',
    ]);
  });

  it('logs but does not push in quiet hours, or with alerts off', async () => {
    setup('00:00-23:59');
    const g = await watchCwsCle();
    routes['statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks='] =
      'mlb/schedule-849829-gameover.json';
    clock = new Date(NOW.getTime() + 60_000);
    await tracker.tick();
    await svc.flush();
    expect(sent).toEqual([]);
    expect(
      db
        .select()
        .from(scoreAlerts)
        .all()
        .map((r) => r.delivery)
    ).toEqual(['quiet']);

    setup();
    const g2 = await watchCwsCle();
    svc.setAlerts({ eventId: g2.eventId }, false);
    routes['statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks='] =
      'mlb/schedule-849829-gameover.json';
    clock = new Date(NOW.getTime() + 60_000);
    await tracker.tick();
    await svc.flush();
    expect(db.select().from(scoreAlerts).all()).toEqual([]);
    expect(g.eventId).toBe(g2.eventId);
    expect(
      db.select().from(watches).where(eq(watches.eventId, g2.eventId)).get()
        ?.alerts
    ).toBe(false);
  });
});
