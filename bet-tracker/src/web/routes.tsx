import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { clientKey } from '../auth/oauth.js';
import type { FailureLimiter } from '../auth/rateLimit.js';
import type { Services } from '../mcp/server.js';
import { basePath, home, url } from '../util/url.js';
import {
  Content,
  Layout,
  LoginPage,
  Summary,
  loadDashboard,
  type Tab,
} from './page.js';
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
}

const tabOf = (q: string | undefined): Tab =>
  q === 'settled' ? 'settled' : 'open';

export function webRoutes(s: Services, cfg: WebConfig): Hono {
  const r = new Hono();

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
    const d = loadDashboard(s, tabOf(c.req.query('tab')), cfg.timeZone);
    return c.html(<Layout d={d} />);
  });

  r.get('/events', requireSession, (c) => {
    const tab = tabOf(c.req.query('tab'));
    const res = streamSSE(c, async (stream) => {
      let closed = false;
      const render = async () => {
        const d = loadDashboard(s, tab, cfg.timeZone);
        return JSON.stringify({
          summary: (await (<Summary d={d} />).toString()) as string,
          content: (await (<Content d={d} />).toString()) as string,
        });
      };
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
  });

  return r;
}
