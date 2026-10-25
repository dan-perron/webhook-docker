import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameScore } from '../src/web/game.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/client.js';
import { legs, predictionSnapshots } from '../src/db/schema.js';
import { createProviders } from '../src/gamestate/registry.js';
import { matchLegs } from '../src/matching/service.js';
import type { Services } from '../src/mcp/server.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { loadSeed } from '../src/seed/load.js';
import { Tracker } from '../src/tracker/tracker.js';
import { betViews, type BetView, type LiveView } from '../src/tracker/views.js';
import {
  BetCard,
  loadDashboard,
  openBetSection,
  sortOpenBets,
} from '../src/web/page.js';
import {
  legStatusLine,
  signedUsd,
  timeLabel,
  situationText,
  tone,
} from '../src/web/format.js';
import type { LegView } from '../src/tracker/views.js';
import { fakeFetcher, SEED_ROUTES } from './helpers/fixtures.js';
import { scoreService } from './helpers/scores.js';
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
    startTime: '2026-10-04T18:45:00.000Z',
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

  it('time labels: time today, weekday this week, date beyond', () => {
    const now = new Date('2026-10-03T19:40:00.000Z');
    const tz = 'America/Chicago';
    expect(timeLabel('2026-10-03T23:00:00.000Z', 'start', tz, now)).toBe(
      '6:00 PM'
    );
    expect(timeLabel('2026-10-04T18:45:00.000Z', 'start', tz, now)).toBe(
      'Sun 1:45 PM'
    );
    expect(timeLabel('2026-10-12T00:15:00.000Z', 'start', tz, now)).toBe(
      'Oct 11, 7:15 PM'
    );
    expect(
      timeLabel('2026-10-04T18:45:00.000Z', 'start', 'Europe/Lisbon', now)
    ).toBe('Sun 7:45 PM');
    expect(timeLabel('2026-10-04T01:44:00.000Z', 'time', tz, now)).toBe(
      '8:44 PM'
    );
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
    const tracker = new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
      now: () => new Date('2026-10-03T19:40:00.000Z'),
    });
    services = {
      db,
      providers,
      tracker,
      scores: scoreService(db, providers, tracker, {
        now: () => new Date('2026-10-03T19:40:00.000Z'),
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
      now: () => new Date('2026-10-03T19:40:00.000Z'),
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
    const settings = await app.request('/settings');
    expect(settings.status).toBe(302);
    expect(settings.headers.get('location')).toBe('/login');
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
    expect(html).toContain('Open stake');
    expect(html).toContain('Exposure');
    expect(html).toContain('San Diego Padres @ Milwaukee Brewers');
    expect(html).toContain('Chicago White Sox ML');
    // Live MLB situation from the recording: top 8th, 1 out
    expect(html).toContain('Top 8th · 1 out · bases empty');
    // Boost and payout
    expect(html).toContain('+128 → +160 (25% profit boost)');
    expect(html).toContain('Total return if won</span><strong>$26.00');
    expect(html).toContain('Touchdown Tally token used');
    // Pregame legs (Rams, Sunday) are "Not started", and the quota is unknown.
    expect(html).toContain('Starts <time');
    expect(html).toContain('Odds API quota not checked yet');
    // Pregame legs show the start time as a localizable <time>, Chicago
    // fallback text: Portugal v Norway 18:45Z = Sun 1:45 PM CDT; Rams 17:00Z.
    expect(html).toContain(
      'Starts <time datetime="2026-10-04T18:45:00.000Z" data-fmt="start">Sun 1:45 PM</time>'
    );
    expect(html).toContain(
      'Starts <time datetime="2026-10-04T17:00:00.000Z" data-fmt="start">Sun 12:00 PM</time>'
    );
    expect(html).not.toContain('Scheduled');
    expect(html).toContain('data-freshness=');
    expect(html.indexOf('id="bet-')).toBeLessThan(
      html.indexOf('id="exposure-details"')
    );
    expect(html).toMatch(
      /<details class="ticket-details" id="bet-details-\d+">/
    );
    expect(html).toContain('Est. win');
    // Fights show no score.
    expect(html).not.toMatch(/Roman Kopylov 0/);
  });

  it('orders tickets by active games, ignoring completed parlay legs', () => {
    const base = betViews(services.db).find(
      (b) => b.status === 'open' && b.legs[0]?.live
    )!;
    const leg = base.legs[0]!;
    const make = (
      id: number,
      status: 'in' | 'pre' | 'final',
      start: string
    ): BetView => ({
      ...base,
      id,
      legs: [
        {
          ...leg,
          status: 'open',
          live: { ...leg.live!, status, startTime: start },
        },
      ],
    });
    const live = make(1, 'in', '2026-10-03T18:00:00Z');
    const next = make(2, 'pre', '2026-10-04T17:00:00Z');
    const later = make(3, 'pre', '2026-10-05T17:00:00Z');
    later.legs.unshift({ ...live.legs[0]!, status: 'won' });
    const pending = {
      ...make(4, 'pre', ''),
      legs: [{ ...leg, status: 'open' as const, live: null }],
    };
    const input = [pending, later, next, live];
    expect(openBetSection(later)).toBe('Upcoming');
    expect(sortOpenBets(input).map((b) => b.id)).toEqual([1, 2, 3, 4]);
    expect(input.map((b) => b.id)).toEqual([4, 3, 2, 1]);
  });

  it('shows a same-game parlay score once while retaining both selections', async () => {
    const base = betViews(services.db).find(
      (b) => b.status === 'open' && b.legs[0]?.live
    )!;
    const first = base.legs[0]!;
    const b: BetView = {
      ...base,
      legs: [first, { ...first, id: 999, selection: 'Under 8.5' }],
      now: { ...base.now, source: 'book_implied' },
    };
    const html = await BetCard({
      b,
      d: loadDashboard(services, 'open', 'America/Chicago'),
    }).toString();
    expect(html.match(/class="scoreboard"/g)).toHaveLength(1);
    expect(html).toContain(first.selection);
    expect(html).toContain('Under 8.5');
    expect(html).toContain('Book implied');
    expect(html).toContain('0 of 2 legs won');
  });

  it('shares one scoreboard across opposing tickets on the same game', async () => {
    const cookie = cookieOf(await login());
    const html = await (await app.request('/', { headers: { cookie } })).text();
    const group = html.match(
      /<div class="bet-group"[^>]*>(.*?)<\/article><\/div>/s
    )?.[1];
    expect(group).toBeDefined();
    expect(group!.match(/class="scoreboard"/g)).toHaveLength(1);
    expect(group!.match(/<article id="bet-/g)).toHaveLength(2);
    expect(group).toContain('Chicago White Sox ML');
    expect(group).toContain('Cleveland Guardians ML');
  });

  it('keeps a single selection once, preserves custom labels, and avoids repeated status', async () => {
    const d = loadDashboard(services, 'open', 'America/Chicago');
    const base = d.bets.find(
      (b) =>
        b.legs.length === 1 && b.legs[0]?.live?.situation?.kind === 'baseball'
    )!;
    const single = { ...base, label: base.legs[0]!.selection };
    const render = async (b: BetView) =>
      (await BetCard({ b, d }).toString()).split(
        '<details class="ticket-details"'
      )[0]!;
    const html = await render(single);
    expect(html.split(single.label)).toHaveLength(2);
    const custom = await render({ ...single, label: 'My Sunday pick' });
    expect(custom).toContain('My Sunday pick');
    expect(custom).toContain(single.label);
    const settled = await render({
      ...single,
      status: 'won',
      now: { ...single.now, ev: 12 },
      legs: [{ ...single.legs[0]!, status: 'won' }],
    });
    expect(settled.match(/>Won</g)).toHaveLength(1);
    // Baseball's inning/outs belong on one line, with stale-data protection retained.
    expect(html.match(/Top 8th/g)).toHaveLength(1);
    expect(html).toContain('data-stale-only="true"');
  });

  it("shows today's result in the header and groups settled bets by day", async () => {
    const cookie = cookieOf(await login());
    const open = await (await app.request('/', { headers: { cookie } })).text();
    // Recording settles Minnesota ML (+$24) and two losers (-$10 each) today.
    expect(open).toMatch(/Today · 1W 2L · 3 settled/);
    const settled = await (
      await app.request('/?tab=settled', { headers: { cookie } })
    ).text();
    expect(settled).toContain('<h2>Today</h2>');
    expect(settled).toContain('1W 2L · staked $30.00 · returned $34.00');
    // A settled card leads with its gain or loss.
    expect(settled).toMatch(
      /<div class="big pos">\+\$24\.00<\/div><div class="sub">Won<\/div>/
    );
    expect(open).toContain('data-settled-today="4"');
    // An invalid tz cookie falls back instead of failing.
    const odd = await app.request('/?tab=settled', {
      headers: { cookie: `${cookie}; tz=Not/AZone` },
    });
    expect(odd.status).toBe(200);
  });

  it('renders the settled tab', async () => {
    const cookie = cookieOf(await login());
    const html = await (
      await app.request('/?tab=settled', { headers: { cookie } })
    ).text();
    expect(html).toContain('Minnesota ML');
    expect(html).toContain('Won');
    expect(html).not.toContain('Exposure');
    expect(html).not.toContain('Calibration');
    expect(html).not.toContain('class="reliability"');
    expect(html).toContain('href="/settings"');
  });

  it('settings: calibration table and one reliability chart per sport', async () => {
    const cookie = cookieOf(await login());
    const empty = await (
      await app.request('/settings', { headers: { cookie } })
    ).text();
    expect(empty).toContain('No settled legs with logged predictions yet.');
    expect(empty).toContain('<title>Settings</title>');
    expect(empty).toContain('href="/settings" aria-current="page"');
    expect(empty).not.toContain('data-events=');

    const legIds = services.db
      .select({ id: legs.id, betId: legs.betId })
      .from(legs)
      .limit(2)
      .all();
    services.db
      .insert(predictionSnapshots)
      .values([
        {
          betId: legIds[0]!.betId,
          legId: legIds[0]!.id,
          sport: 'mlb',
          market: 'moneyline',
          takenAt: '2026-10-03T19:00:00Z',
          gameStatus: 'pre',
          probability: 0.6,
          outcome: 1,
        },
        {
          betId: legIds[1]!.betId,
          legId: legIds[1]!.id,
          sport: 'ncaaf',
          market: 'spread',
          takenAt: '2026-10-03T19:00:00Z',
          gameStatus: 'pre',
          probability: 0.3,
          outcome: 0,
        },
      ])
      .run();
    const html = await (
      await app.request('/settings', { headers: { cookie } })
    ).text();
    expect(html).toContain('<h2>Calibration</h2>');
    expect(html).toContain('Overall Brier score');
    expect(html).toContain(
      '<details class="analysis" id="calibration-metrics">'
    );
    expect(html.match(/too little data to judge yet/g)).toHaveLength(1);
    // All: (0.16 + 0.09) / 2 = 0.125
    expect(html).toContain('<td>All sports</td><td>2</td><td>0.125</td>');
    expect(html.match(/class="reliability"/g)).toHaveLength(2);
    expect(html).toContain(
      'data-tip="60%–70% predicted (avg 60%): won 100% of 1 legs'
    );
  });

  it('includes current open EV once in both headlines, excluding settled tickets', async () => {
    const cookie = cookieOf(await login());
    const openCents = betViews(services.db)
      .filter((b) => b.status === 'open')
      .reduce((cents, b) => cents + Math.round(b.now.ev * 100), 0);
    for (const path of ['/', '/scores']) {
      const html = await (
        await app.request(path, { headers: { cookie } })
      ).text();
      expect(html).toContain('Today + EV');
      expect(html).toContain('data-settled-today="4"');
      expect(html).toContain(`data-open-ev="${openCents / 100}"`);
      expect(html).toContain(
        `data-total-estimate="${(400 + openCents) / 100}"`
      );
      expect(html).toContain('title="Settled today: +$4.00 · Open EV:');
      expect(html.match(/id="bet-headline"/g)).toHaveLength(1);
    }
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
    expect(payload.summary).toContain('Open stake');
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
  describe('scores', () => {
    const form = (cookie: string, path: string, f: Record<string, string>) =>
      app.request(path, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(f).toString(),
      });

    it('needs a session', async () => {
      expect((await app.request('/scores')).status).toBe(302);
      expect(
        (await app.request('/scores/watch', { method: 'POST' })).status
      ).toBe(302);
    });

    it('shows bet games with a view switch, live stream and star buttons', async () => {
      const cookie = cookieOf(await login());
      const html = await (
        await app.request('/scores', { headers: { cookie } })
      ).text();
      expect(html).toContain('aria-label="Main navigation"');
      expect(html).toContain('data-events="/scores/events"');
      // CWS @ CLE is live: score and linked tickets make a bet badge redundant.
      expect(html).toContain('Chicago White Sox');
      expect(html).not.toContain('>bet<');
      expect(html).toContain('☆');
      expect(html).toContain('Push off');
      expect(html).not.toContain('NTFY_URL');
      expect(html).toContain('<title>Today</title>');
      expect(html).toContain('class="game-bets"');
      expect(html).toContain('aria-label="View Chicago White Sox ML ticket"');
      expect(html).toContain('data-sport-filter="all" aria-pressed="true"');
      expect(html).toMatch(/href="\/#bet-\d+"/);
      // The bets page links back.
      const bets = await (
        await app.request('/', { headers: { cookie } })
      ).text();
      expect(bets).toContain('href="/scores"');
    });

    it('shows watched finals openly and compresses settled bets to the daily total', async () => {
      const settled = betViews(services.db).find((b) => b.status === 'won')!;
      const leg = settled.legs[0]!;
      await services.scores.watchGame({
        sport: leg.sport,
        date: leg.eventDate,
        eventId: leg.match.eventId!,
      });
      const cookie = cookieOf(await login());
      const html = await (
        await app.request('/scores', { headers: { cookie } })
      ).text();
      expect(html).toContain('Completed today (1)');
      expect(html).toContain('Minnesota Golden Gophers');
      expect(html).not.toContain('id="final-games"');
      expect(html).not.toContain(`aria-label="View ${settled.label} ticket"`);
      expect(html).toContain('data-settled-today="4"');
      expect(html).toContain('Today + EV');
      const completed = html
        .split('Completed today (1)')[1]!
        .split('</section>')[0]!;
      expect(completed).not.toContain('class="game-bets"');
    });

    it('refreshes Today at local midnight without waiting for a tracker change', async () => {
      let clock = new Date('2026-10-04T04:59:50Z');
      services = {
        ...services,
        scores: scoreService(
          services.db,
          services.providers,
          services.tracker,
          { now: () => clock }
        ),
      };
      app = createApp(services, {
        appToken: TOKEN,
        publicOrigin: 'https://djperron.com',
        now: () => clock,
      });
      const settled = betViews(services.db).find((b) => b.status === 'won')!;
      const leg = settled.legs[0]!;
      await services.scores.watchGame({
        sport: leg.sport,
        date: leg.eventDate,
        eventId: leg.match.eventId!,
      });
      const cookie = cookieOf(await login());
      const controller = new AbortController();
      vi.useFakeTimers();
      const res = await app.request('/scores/events', {
        headers: { cookie },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const next = async () => {
        let data = '';
        const decoder = new TextDecoder();
        while (!data.includes('\n\n'))
          data += decoder.decode((await reader.read()).value);
        return JSON.parse(data.split('data: ')[1]!.split('\n')[0]!);
      };
      try {
        const before = await next();
        expect(before.content).toContain('Completed today (1)');
        const openEV = before.summary.match(/data-open-ev="([^"]+)"/)![1];
        expect(before.summary).toContain('data-settled-today="4"');
        clock = new Date('2026-10-04T05:00:10Z');
        await vi.advanceTimersByTimeAsync(20000);
        const update = await next();
        expect(update.content).not.toContain('Completed today');
        expect(update.summary).toContain('data-settled-today="0"');
        expect(update.summary).toContain(`data-open-ev="${openEV}"`);
        expect(update.summary).toContain(`data-total-estimate="${openEV}"`);
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('browse -> star -> unstar', async () => {
      const cookie = cookieOf(await login());
      const browse = await (
        await app.request('/scores/browse?sport=nfl&date=2026-10-04', {
          headers: { cookie },
        })
      ).text();
      expect(browse).toContain('Indianapolis Colts @ Washington Commanders');
      expect(browse).not.toContain('data-events=');
      const id = 'espn:nfl:401872965'; // no bet on it
      const back = '/scores/browse?sport=nfl&date=2026-10-04';
      const res = await form(cookie, '/scores/watch', {
        eventId: id,
        sport: 'nfl',
        date: '2026-10-04',
        back,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(back);
      expect(services.scores.board().upcoming.map((g) => g.eventId)).toContain(
        id
      );
      // An off-site "back" is ignored.
      const off = await form(cookie, '/scores/unwatch', {
        eventId: id,
        back: '//evil.example',
      });
      expect(off.headers.get('location')).toBe('/scores');
      expect(
        services.scores.board().upcoming.map((g) => g.eventId)
      ).not.toContain(id);
    });

    it('follows a team, or asks which one', async () => {
      const cookie = cookieOf(await login());
      const amb = await (
        await form(cookie, '/scores/follow', { sport: 'nfl', team: 'New York' })
      ).text();
      expect(amb).toContain('Which team?');
      expect(amb).toContain('value="New York Jets"');
      const ok = await (
        await form(cookie, '/scores/follow', { sport: 'nfl', team: 'Bears' })
      ).text();
      expect(ok).toContain('Following Chicago Bears: 1 game this week.');
      expect(services.scores.listFollows().map((f) => f.team)).toEqual([
        'Chicago Bears',
      ]);
    });
  });
});

describe('watch details on shared scoreboards', () => {
  const live: LiveView = {
    sport: 'nfl',
    status: 'pre',
    detail: '',
    score: '',
    home: { name: 'Falcons', abbr: 'ATL', score: 0 },
    away: { name: 'Bears', abbr: 'CHI', score: 0 },
    situation: null,
    providerWinProb: null,
    startTime: '2026-10-18T17:00:00Z',
    fetchedAt: '2026-10-13T19:00:00Z',
    broadcasts: [{ name: 'FOX', scope: 'regional' }],
    watch: {
      location: 'Chicago 60640',
      ota: 'yes',
      channels: ['FOX 32 · WFLD 32.1'],
      streams: ['FOX One'],
      note: 'Listed for your TV market.',
      source: 'https://www.nfl.com/ways-to-watch',
      checkedAt: '2026-10-13T19:00:00Z',
    },
  };
  const render = (l = live, now = new Date('2026-10-13T19:30:00Z')) =>
    GameScore({
      live: l,
      now,
      timeZone: 'America/Chicago',
      watchId: 'watch-test',
    }).toString();
  it('shows one collapsed watch row with local station, subscription option, source and stable keyboard target', async () => {
    const html = await render();
    expect(html).toContain('Watch: FOX');
    expect(html).toContain('OTA in Chicago 60640');
    expect(html).toContain('FOX 32 · WFLD 32.1');
    expect(html).toContain('FOX One');
    expect(html).toContain('subscription required');
    expect(html).toContain('id="watch-test-toggle"');
    expect(html).not.toContain(' open');
  });
  it('downgrades stale coverage instead of claiming you can watch', async () => {
    const html = await render(live, new Date('2026-10-13T22:00:00Z'));
    expect(html).toContain('Local coverage unconfirmed');
    expect(html).not.toContain('OTA in Chicago');
    expect(html).not.toContain('FOX One');
  });
  it('keeps completed games concise and handles missing broadcast data', async () => {
    expect(await render({ ...live, status: 'final' })).not.toContain(
      'watch-details'
    );
    const html = await render({
      ...live,
      watch: undefined,
      broadcasts: undefined,
    });
    expect(html).toContain('TV / stream not listed');
    expect(html).toContain('Local coverage unconfirmed');
  });
});
