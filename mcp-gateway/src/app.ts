import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { oauthRoutes, requireBearer } from './auth/oauth.js';
import type { OAuthStore } from './auth/oauthStore.js';
import { FailureLimiter } from './auth/rateLimit.js';
import type { BackendPool } from './mcp/backends.js';
import { createGatewayServer } from './mcp/gateway.js';
import { basePath } from './util/url.js';

export interface AppOptions {
  appToken: string;
  /** Absolute origin, e.g. https://djperron.com (OAuth needs absolute URLs). */
  publicOrigin: string;
  store: OAuthStore;
  pool: BackendPool;
}

export function createApp(opts: AppOptions) {
  const app = new Hono();

  // So "/mcp/" resolves to the "/mcp" endpoint instead of 404ing.
  app.use(trimTrailingSlash());

  // All routes hang off the configured base path ('' = root).
  const r = basePath ? app.basePath(basePath) : app;

  // Liveness probe; stays open without auth. Lists backends left out of the
  // last discovery so a broken app shows up here.
  r.get('/healthz', async (c) => {
    const { tools, errors } = await opts.pool.discover();
    return c.json({ ok: true, tools: tools.length, errors });
  });

  const auth = {
    issuer: `${opts.publicOrigin}${basePath}`,
    appToken: opts.appToken,
    store: opts.store,
    limiter: new FailureLimiter(),
  };
  r.route('/', oauthRoutes(auth));

  // Remote MCP (Streamable HTTP) at the base path itself, stateless: a fresh
  // server per request and plain JSON responses (no long-lived streams
  // through Apache).
  r.all('/', requireBearer(auth), async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = await createGatewayServer(opts.pool);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}
