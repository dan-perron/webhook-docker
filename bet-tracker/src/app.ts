import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { oauthRoutes, requireBearer } from './auth/oauth.js';
import { DEFAULT_REDIRECT_ALLOWLIST, OAuthStore } from './auth/oauthStore.js';
import { FailureLimiter } from './auth/rateLimit.js';
import { createMcpServer, type Services } from './mcp/server.js';
import { basePath } from './util/url.js';

export interface AppOptions {
  appToken: string;
  /** Absolute origin, e.g. https://djperron.com (OAuth needs absolute URLs). */
  publicOrigin: string;
  extraRedirectUris?: string[];
  now?: () => Date;
}

export function createApp(services: Services, opts: AppOptions) {
  const app = new Hono();

  // So "/bets/" resolves to the "/bets" root instead of 404ing.
  app.use(trimTrailingSlash());

  // All routes hang off the configured base path ('' = root).
  const r = basePath ? app.basePath(basePath) : app;

  // Liveness probe; stays open without auth.
  r.get('/healthz', (c) => c.text('ok'));

  const auth = {
    issuer: `${opts.publicOrigin}${basePath}`,
    appToken: opts.appToken,
    store: new OAuthStore(services.db, {
      redirectAllowlist: [
        ...DEFAULT_REDIRECT_ALLOWLIST,
        ...(opts.extraRedirectUris ?? []),
      ],
      now: opts.now,
    }),
    limiter: new FailureLimiter(),
  };
  r.route('/', oauthRoutes(auth));

  // Remote MCP (Streamable HTTP), stateless: a fresh server per request and
  // plain JSON responses (no long-lived streams through Apache).
  r.all('/mcp', requireBearer(auth), async (c) => {
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

  return app;
}
