import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { clientKey } from '../auth/oauth.js';
import type { FailureLimiter } from '../auth/rateLimit.js';
import type { Services } from '../mcp/server.js';
import { basePath, home, url } from '../util/url.js';
import { SPORTS, type Sport } from '../domain/types.js';
import type { ScheduleGame } from '../scores/service.js';
import { localDate } from '../util/date.js';
import {
  Content,
  Layout,
  LoginPage,
  Shell,
  Summary,
  loadDashboard,
  type Tab,
} from './page.js';
import {
  BrowseContent,
  BrowseHeader,
  ScoresContent,
  ScoresSummary,
  TeamsContent,
  TeamsHeader,
  type BrowsePage,
  type ScoresPage,
  type TeamsPage,
} from './scores.js';
import { validTimeZone } from './daily.js';
import {
  hasSession,
  startSession,
  tokenMatches,
  type SessionConfig,
} from './session.js';

export interface WebConfig {
  session: SessionConfig;
  limiter: FailureLimiter;
  timeZone: string;
  /** Seconds between SSE heartbeats (keeps proxies from closing idle streams). */
  heartbeatSeconds?: number;
  now?: () => Date;
}

/** The viewer's zone, from the cookie public/app.js sets (validated). */
const TZ_COOKIE = 'tz';

const isSport = (x: unknown): x is Sport =>
  typeof x === 'string' && (SPORTS as readonly string[]).includes(x);

const tabOf = (q: string | undefined): Tab =>
  q === 'settled' ? 'settled' : 'open';

export function webRoutes(s: Services, cfg: WebConfig): Hono {
  const r = new Hono();
  const viewerZone = (c: Context) =>
    validTimeZone(getCookie(c, TZ_COOKIE), cfg.timeZone);

  // CSS/JS from ./public at <base>/static/*.
  r.use(
    '/static/*',
    serveStatic({
      root: './public',
      rewriteRequestPath: (p) =>
        p.replace(new RegExp(`^${basePath}/static`), ''),
    })
  );

  r.get('/login', (c) => c.html(<LoginPage />));
  r.post('/login', async (c) => {
    const key = clientKey(c);
    if (cfg.limiter.blocked(key)) {
      return c.html(
        <LoginPage error="Too many attempts. Try again later." />,
        429
      );
    }
    const body = await c.req.parseBody();
    if (!tokenMatches(cfg.session, body.app_token)) {
      cfg.limiter.fail(key);
      return c.html(<LoginPage error="Wrong app token." />, 401);
    }
    cfg.limiter.reset(key);
    await startSession(c, cfg.session);
    return c.redirect(home);
  });

  const requireSession: MiddlewareHandler = async (c, next) => {
    if (await hasSession(c, cfg.session)) return next();
    return c.redirect(url('/login'));
  };

  r.get('/', requireSession, (c) => {
    const d = loadDashboard(
      s,
      tabOf(c.req.query('tab')),
      viewerZone(c),
      cfg.now?.()
    );
    return c.html(<Layout d={d} />);
  });

  /**
   * Re-rendered #summary/#content over SSE on every tracker change (and
   * heartbeats so proxies keep the idle stream open).
   */
  const live = (c: Context, render: () => Promise<string>) => {
    const res = streamSSE(c, async (stream) => {
      let closed = false;
      const send = async () => {
        if (closed) return;
        await stream.writeSSE({ event: 'update', data: await render() });
      };
      const onChange = () => {
        void send().catch(() => undefined);
      };
      s.tracker.on('change', onChange);
      const heartbeat = setInterval(
        () => {
          if (!closed) void stream.write(': ping\n\n').catch(() => undefined);
        },
        (cfg.heartbeatSeconds ?? 20) * 1000
      );
      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeat);
        s.tracker.off('change', onChange);
      });
      await send();
      // Hold the stream open until the client goes away.
      while (!closed) await stream.sleep(60_000);
    });
    // Stop proxies (Apache mod_deflate) from buffering the stream. Set on the
    // response: streamSSE overwrites Cache-Control set on the context.
    res.headers.set('Cache-Control', 'no-cache, no-transform');
    res.headers.set('X-Accel-Buffering', 'no');
    return res;
  };
  // JSX renders to a string (or a promise of one, for async components).
  type Rendered = { toString(): unknown };
  const html = async (summary: Rendered, content: Rendered) =>
    JSON.stringify({
      summary: (await summary.toString()) as string,
      content: (await content.toString()) as string,
    });

  r.get('/events', requireSession, (c) => {
    const tab = tabOf(c.req.query('tab'));
    return live(c, () => {
      const d = loadDashboard(s, tab, viewerZone(c), cfg.now?.());
      return html(<Summary d={d} />, <Content d={d} />);
    });
  });

  // --- Scores ----------------------------------------------------------------

  const scoresPage = (c: Context): ScoresPage => ({
    board: s.scores.board(),
    timeZone: viewerZone(c),
    now: cfg.now?.() ?? new Date(),
  });
  const today = (c: Context) =>
    localDate((cfg.now?.() ?? new Date()).toISOString(), viewerZone(c));
  /** Back to a Scores page named by the form (never off-site). */
  const back = (c: Context, to: unknown) =>
    c.redirect(
      typeof to === 'string' && /^\/scores(\/|\?|$)/.test(to)
        ? url(to)
        : url('/scores')
    );

  r.get('/scores', requireSession, (c) => {
    const p = scoresPage(c);
    return c.html(
      <Shell
        title="Scores"
        events={url('/scores/events')}
        timeZone={p.timeZone}
        summary={<ScoresSummary p={p} />}
        content={<ScoresContent p={p} />}
      />
    );
  });

  r.get('/scores/events', requireSession, (c) =>
    live(c, () => {
      const p = scoresPage(c);
      return html(<ScoresSummary p={p} />, <ScoresContent p={p} />);
    })
  );

  r.get('/scores/browse', requireSession, async (c) => {
    const q = c.req.query('sport');
    const sport: Sport = isSport(q) ? q : 'nfl';
    const d = c.req.query('date');
    const t = today(c);
    const date = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : t;
    let games: ScheduleGame[] = [];
    let error: string | undefined;
    try {
      games = await s.scores.schedule(sport, date);
    } catch (e) {
      error = `Couldn't load the schedule: ${(e as Error).message}`;
    }
    const p: BrowsePage = {
      sport,
      date,
      today: t,
      games,
      error,
      timeZone: viewerZone(c),
      now: cfg.now?.() ?? new Date(),
    };
    return c.html(
      <Shell
        title="Add games"
        timeZone={p.timeZone}
        summary={<BrowseHeader p={p} />}
        content={<BrowseContent p={p} />}
      />
    );
  });

  const teamsPage = (c: Context, extra: Partial<TeamsPage> = {}) =>
    c.html(
      <Shell
        title="Teams"
        timeZone={viewerZone(c)}
        summary={<TeamsHeader />}
        content={
          <TeamsContent p={{ follows: s.scores.listFollows(), ...extra }} />
        }
      />
    );

  r.get('/scores/teams', requireSession, (c) => teamsPage(c));

  r.post('/scores/follow', requireSession, async (c) => {
    const body = await c.req.parseBody();
    const sport = body.sport;
    const team = typeof body.team === 'string' ? body.team.trim() : '';
    if (!isSport(sport) || !team) return teamsPage(c);
    try {
      const res = await s.scores.followTeam(sport, team);
      if (res.status === 'followed') {
        const n = res.games.length;
        return teamsPage(c, {
          notice: {
            ok: true,
            text: `Following ${res.follow.team}: ${n} game${n === 1 ? '' : 's'} this week.`,
          },
        });
      }
      if (res.status === 'ambiguous') {
        return teamsPage(c, { candidates: { sport, names: res.candidates } });
      }
      return teamsPage(c, {
        notice: {
          ok: false,
          text: `No ${sport.toUpperCase()} team matching "${team}" found in upcoming games or the league's teams.`,
        },
        ...(res.near.length ? { candidates: { sport, names: res.near } } : {}),
      });
    } catch (e) {
      return teamsPage(c, {
        notice: { ok: false, text: (e as Error).message },
      });
    }
  });

  r.post('/scores/unfollow', requireSession, async (c) => {
    const body = await c.req.parseBody();
    try {
      s.scores.unfollowTeam(Number(body.followId));
    } catch {
      // Already gone.
    }
    return c.redirect(url('/scores/teams'));
  });

  r.post('/scores/watch', requireSession, async (c) => {
    const body = await c.req.parseBody();
    const { sport, date, eventId } = body;
    if (isSport(sport) && typeof eventId === 'string') {
      await s.scores.watchGame({
        sport,
        eventId,
        date: typeof date === 'string' ? date : undefined,
      });
    }
    return back(c, body.back);
  });

  r.post('/scores/unwatch', requireSession, async (c) => {
    const body = await c.req.parseBody();
    try {
      s.scores.unwatchGame(String(body.eventId));
    } catch {
      // Already gone.
    }
    return back(c, body.back);
  });

  r.post('/scores/alerts', requireSession, async (c) => {
    const body = await c.req.parseBody();
    const on = body.on === '1';
    try {
      if (body.followId)
        s.scores.setAlerts({ followId: Number(body.followId) }, on);
      else s.scores.setAlerts({ eventId: String(body.eventId) }, on);
    } catch {
      // Not watched any more.
    }
    return back(c, body.back);
  });

  return r;
}
