import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import type { Db } from './db/client.js';
import { basePath } from './util/url.js';

export function createApp(_db: Db) {
  const app = new Hono();

  // So "/bets/" resolves to the "/bets" root instead of 404ing.
  app.use(trimTrailingSlash());

  // All routes hang off the configured base path ('' = root).
  const r = basePath ? app.basePath(basePath) : app;

  // Liveness probe; stays open without auth.
  r.get('/healthz', (c) => c.text('ok'));

  return app;
}
