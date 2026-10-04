import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/client.js';
import { createProviders } from '../src/gamestate/registry.js';
import { matchLegs } from '../src/matching/service.js';
import type { Services } from '../src/mcp/server.js';
import { seededRng } from '../src/models/stats.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { loadSeed } from '../src/seed/load.js';
import { Tracker } from '../src/tracker/tracker.js';
import type { LiveView } from '../src/tracker/views.js';
import {
  legStatusLine,
  signedUsd,
  situationText,
  tone,
} from '../src/web/format.js';
import type { LegView } from '../src/tracker/views.js';
import { fakeFetcher, SEED_ROUTES } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

const TOKEN = 'web-token';
const ROUTES = {
  'baseball/mlb/summary?event=401907990':
    'espn/summary-mlb-401907990-live.json',
  'baseball/mlb/scoreboard?dates=20261003': 'espn/mlb-20261003-top8.json',
  'statsapi.mlb.com/api/v1/schedule?sportId=1&gamePks=':
    'mlb/schedule-20261003.json',
  ...SEED_ROUTES,
};

describe('format', () => {
  it.each([
    ['open', 0.7, 'good', '✅'],
    ['open', 0.69, 'warn', '⚠️'],
    ['open', 0.3, 'warn', '⚠️'],
    ['open', 0.29, 'bad', '❌'],
    ['won', 0, 'won', '🏆'],
    ['lost', 1, 'lost', '✖'],
    ['void', null, 'push', '⊘'],
    ['open', null, 'idle', '…'],
  ] as const)('%s at %s -> %s', (status, p, t, icon) => {
    expect(tone(status, p)).toMatchObject({ tone: t, icon });
  });

  const live = (situation: LiveView['situation']): LiveView => ({
    status: 'in',
    detail: '',
    score: '',
    home: { name: 'Houston Cougars', abbr: 'HOU', score: 27 },
    away: { name: 'UCF Knights', abbr: 'UCF', score: 17 },
    situation,
    providerWinProb: null,
    fetchedAt: '',
  });

  it('describes situations in one line', () => {
    expect(
      situationText(
        live({
          kind: 'football',
          possession: 'away',
          down: 4,
          distance: 6,
          yardsToGoal: 71,
          text: '4th & 6 at UCF 29',
        })
      )
    ).toBe('UCF ball · 4th & 6 at UCF 29');
    expect(
      situationText(
        live({
          kind: 'baseball',
          inning: 8,
          half: 'top',
          outs: 1,
          first: true,
          second: false,
          third: true,
          scheduledInnings: 9,
          extraInningRunner: false,
        })
      )
    ).toBe('Top 8th · 1 out · on 1st, 3rd');
    expect(situationText(live({ kind: 'soccer', minute: 67, period: 2 }))).toBe(
      "67'"
    );
    expect(situationText({ ...live(null), status: 'final' })).toBeNull();
  });

  it('a game that has not started is "Not started", not "in trouble"', () => {
    expect(tone('open', 0.2, false)).toMatchObject({
      tone: 'idle',
      icon: '🕒',
    });
    expect(tone('open', 0.2, true)).toMatchObject({ tone: 'bad' });
    expect(tone('won', 1, false)).toMatchObject({ tone: 'won' });
  });

  it('status line: no duplicate inning, no fake fight score', () => {
    const leg = (l: Partial<LiveView>) =>
      ({
        match: { status: 'matched' },
        live: { ...live(null), ...l },
      }) as unknown as LegView;
    expect(
      legStatusLine(
        leg({
          score: 'SD 2 @ MIL 2',
          detail: 'Bot 3rd, 2 out',
          situation: {
            kind: 'baseball',
            inning: 3,
            half: 'bottom',
            outs: 2,
            first: true,
            second: true,
            third: true,
            scheduledInnings: 9,
            extraInningRunner: false,
          },
        })
      )
    ).toBe('SD 2 @ MIL 2');
    expect(
      legStatusLine(leg({ status: 'final', score: '', detail: 'Final' }))
    ).toBe('Final');
    expect(
      legStatusLine(
        leg({ status: 'in', score: 'UCF 17 @ HOU 27', detail: '1:08 - 4th' })
      )
    ).toBe('UCF 17 @ HOU 27 · 1:08 - 4th');
  });

  it('signs money with a true minus', () => {
    expect(signedUsd(11.41)).toBe('+$11.41');
    expect(signedUsd(-0.39)).toBe('−$0.39');
  });
});

describe('web page', () => {
  let app: ReturnType<typeof createApp>;
  let services: Services;

  beforeEach(async () => {
    const db = openDb(':memory:');
    loadSeed(db);
    const providers = createProviders(fakeFetcher(ROUTES).fetcher);
    await matchLegs(db, providers);
    services = {
      db,
      providers,
      tracker: new Tracker(db, providers, {
        params: { ...PARAMS, mlb: { simulations: 1000 } },
        polling: { liveSeconds: 30, scheduledSeconds: 600 },
        now: () => new Date('2026-10-03T19:40:00.000Z'),
        rng: seededRng(3),
      }),
      odds: new OddsApiClient(db, {
        apiKey: '',
        baseUrl: 'x',
        regions: 'us',
        cacheSeconds: 60,
      }),
      confirmAboveCost: 3,
    };
    await services.tracker.tick();
    app = createApp(services, {
      appToken: TOKEN,
      publicOrigin: 'https://djperron.com',
    });
  });

  const login = async () => {
    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ app_token: TOKEN }).toString(),
    });
    return res;
  };
  const cookieOf = (res: Response) =>
    res.headers.get('set-cookie')!.split(';')[0]!;

  it('redirects to login without a session', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect((await app.request('/events')).status).toBe(302);
  });

  it('login sets a secure, httpOnly, lax cookie; wrong token is refused', async () => {
    const bad = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'app_token=nope',
    });
    expect(bad.status).toBe(401);
    const res = await login();
    expect(res.status).toBe(302);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('renders the open tab: totals, exposure, cards with live state', async () => {
    const cookie = cookieOf(await login());
    const html = await (await app.request('/', { headers: { cookie } })).text();
    expect(html).toContain('Staked');
    expect(html).toContain('Exposure');
    expect(html).toContain('San Diego Padres @ Milwaukee Brewers');
    expect(html).toContain('Chicago White Sox ML');
    // Live MLB situation from the recording: top 8th, 1 out
    expect(html).toContain('Top 8th · 1 out · bases empty');
    // Boost and payout
    expect(html).toContain('+128 → +160 (25% profit boost)');
    expect(html).toContain('$10.00 → $26.00');
    expect(html).toContain('Touchdown Tally token used');
    // Pregame legs (Rams, Sunday) are "Not started", and the quota is unknown.
    expect(html).toContain('Not started');
    expect(html).toContain('Odds API quota not checked yet');
    // Fights show no score.
    expect(html).not.toMatch(/Roman Kopylov 0/);
  });

  it('renders the settled tab', async () => {
    const cookie = cookieOf(await login());
    const html = await (
      await app.request('/?tab=settled', { headers: { cookie } })
    ).text();
    expect(html).toContain('Minnesota ML');
    expect(html).toContain('🏆');
    expect(html).not.toContain('Exposure');
  });

  it('serves static assets without a session', async () => {
    const res = await app.request('/static/styles.css');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('prefers-color-scheme: dark');
  });

  it('streams an update on connect and on every tracker change', async () => {
    const cookie = cookieOf(await login());
    const controller = new AbortController();
    const res = await app.request('/events', {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const nextEvent = async () => {
      let buf = '';
      while (!buf.includes('\n\n'))
        buf += dec.decode((await reader.read()).value);
      return buf;
    };
    const first = await nextEvent();
    expect(first).toContain('event: update');
    const payload = JSON.parse(first.split('data: ')[1]!.split('\n')[0]!);
    expect(payload.summary).toContain('EV now');
    expect(payload.content).toContain('Open (');

    services.tracker.emit('change', {
      polled: [],
      evaluatedEvents: [],
      changedBets: [],
      errors: [],
    });
    expect(await nextEvent()).toContain('event: update');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect(services.tracker.listenerCount('change')).toBe(0);
  });
});
