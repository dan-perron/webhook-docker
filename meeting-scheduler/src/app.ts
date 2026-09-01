import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { serveStatic } from '@hono/node-server/serve-static';
import { basePath } from './util/url.js';
import { home } from './routes/home.js';
import { event } from './routes/event.js';

export const app = new Hono();

// So "/meet/" resolves to the "/meet" root instead of 404ing.
app.use(trimTrailingSlash());

// All routes hang off the configured base path ('' = root). `c.req.path` stays
// the full path, so the static rewrite strips the prefix too.
const r = basePath ? app.basePath(basePath) : app;

// Liveness probe used by deploy.sh.
r.get('/healthz', (c) => c.text('ok'));

// Static assets served from ./public at <base>/static/*.
r.use(
  '/static/*',
  serveStatic({
    root: './public',
    rewriteRequestPath: (path) =>
      path.replace(new RegExp(`^${basePath}/static`), ''),
  })
);

r.route('/', home);
r.route('/', event);
