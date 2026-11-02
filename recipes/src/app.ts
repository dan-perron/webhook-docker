import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { FailureLimiter } from './auth/rateLimit.js';
import { safeEqual } from './auth/secrets.js';
import { createMcpServer } from './mcp/server.js';
import type { Services } from './services.js';
import { basePath } from './util/url.js';
import { webRoutes } from './web/routes.js';

export interface AppOptions {
  /** Password for the web page. */
  password: string;
  /** Bearer token for /mcp (the gateway, scripts). */
  appToken: string;
  /** Secure cookies need https; off only for plain-http local runs. */
  cookieSecure: boolean;
  now?: () => Date;
}

/** `Authorization: Bearer <RECIPES_APP_TOKEN>`; OAuth lives in mcp-gateway. */
const requireToken =
  (token: string): MiddlewareHandler =>
  async (c, next) => {
    const m = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i);
    if (token && m?.[1] && safeEqual(m[1].trim(), token)) return next();
    return c.json({ error: 'unauthorized' }, 401);
  };

export function createApp(services: Services, opts: AppOptions) {
  const app = new Hono();

  // So "/recipes/" resolves to the "/recipes" root instead of 404ing.
  app.use(trimTrailingSlash());

  // All routes hang off the configured base path ('' = root).
  const r = basePath ? app.basePath(basePath) : app;

  // Liveness probe; stays open without auth.
  r.get('/healthz', (c) => c.text('ok'));

  // MCP (Streamable HTTP), stateless: a fresh server per request and plain
  // JSON responses. Reached through mcp-gateway.
  r.all('/mcp', requireToken(opts.appToken), async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(services);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  r.route(
    '/',
    webRoutes(services, {
      session: {
        password: opts.password,
        path: basePath || '/',
        secure: opts.cookieSecure,
        now: opts.now,
      },
      limiter: new FailureLimiter(),
    })
  );

  return app;
}
