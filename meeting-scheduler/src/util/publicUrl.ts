import type { Context } from 'hono';
import { appConfig } from '../config.js';
import { basePath } from './url.js';

/**
 * Absolute, shareable URL for a path.
 *
 * NEVER build one of these from `c.req.url`. The main Apache vhost on `signs`
 * does not set `ProxyPreserveHost`, so the Host header this app sees is
 * `localhost:3002` — the share box would hand people a link that only works on
 * the server itself.
 *
 * Three layers, most trustworthy first:
 *   1. PUBLIC_ORIGIN, set in compose. Deterministic, no header trust.
 *   2. X-Forwarded-Host, which mod_proxy adds by default. Covers a deploy
 *      where nobody remembered to set PUBLIC_ORIGIN.
 *   3. The request's own origin — right in local dev, wrong behind that proxy,
 *      which is exactly why layers 1 and 2 exist.
 *
 * The page also corrects the field from `window.location` on load, so a browser
 * always shows the truth even if all three are wrong.
 */
export function absoluteUrl(c: Context, path: string): string {
  return origin(c) + basePath + path;
}

function origin(c: Context): string {
  if (appConfig.publicOrigin) return appConfig.publicOrigin;

  const forwardedHost = c.req.header('x-forwarded-host');
  if (forwardedHost) {
    // Apache adds X-Forwarded-Host but not X-Forwarded-Proto; anything sitting
    // in front of us in practice terminates TLS, so https is the right guess.
    const proto = c.req.header('x-forwarded-proto') || 'https';
    return `${proto}://${forwardedHost.split(',')[0].trim()}`;
  }

  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}
