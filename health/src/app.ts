import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { safeEqual } from './auth/secrets.js';
import type { HealthStore } from './db/store.js';
import { createMcpServer } from './mcp/server.js';

export interface AppOptions {
  /** Bearer token for /mcp (the gateway). */
  appToken: string;
  /** '' (root) or '/health'. */
  basePath: string;
}

/** `Authorization: Bearer <HEALTH_APP_TOKEN>`; OAuth lives in mcp-gateway. */
const requireToken =
  (token: string): MiddlewareHandler =>
  async (c, next) => {
    const m = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i);
    if (token && m?.[1] && safeEqual(m[1].trim(), token)) return next();
    return c.json({ error: 'unauthorized' }, 401);
  };

export function createApp(store: HealthStore, opts: AppOptions) {
  const app = new Hono();
  app.use(trimTrailingSlash());
  const r = opts.basePath ? app.basePath(opts.basePath) : app;

  // Liveness probe; stays open without auth.
  r.get('/healthz', (c) => c.text('ok'));

  // MCP (Streamable HTTP), stateless: a fresh server per request and plain
  // JSON responses. Reached through mcp-gateway; there is no other API.
  r.all('/mcp', requireToken(opts.appToken), async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(store);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}
