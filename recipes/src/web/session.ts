import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { safeEqual } from '../auth/secrets.js';

// Browser session for the web page: log in once with the password
// (RECIPES_PASSWORD; compose sets it to MCP_APP_TOKEN), get a signed httpOnly cookie holding the login time. The
// signing key is derived from the password, so changing it logs every
// browser out.

const COOKIE = 'recipes_session';
export const SESSION_DAYS = 30;

export interface SessionConfig {
  password: string;
  /** Cookie path (the app's base path, or "/"). */
  path: string;
  /** Secure cookies need https; off only for plain-http local runs. */
  secure: boolean;
  now?: () => Date;
}

const key = (password: string) =>
  createHmac('sha256', password)
    .update('recipes web session')
    .digest('base64url');

export function passwordMatches(
  cfg: SessionConfig,
  candidate: unknown
): boolean {
  return typeof candidate === 'string' && safeEqual(candidate, cfg.password);
}

export async function startSession(c: Context, cfg: SessionConfig) {
  const now = (cfg.now ?? (() => new Date()))();
  await setSignedCookie(c, COOKIE, String(now.getTime()), key(cfg.password), {
    httpOnly: true,
    secure: cfg.secure,
    sameSite: 'Lax',
    path: cfg.path,
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export async function hasSession(
  c: Context,
  cfg: SessionConfig
): Promise<boolean> {
  const v = await getSignedCookie(c, key(cfg.password), COOKIE);
  if (!v) return false;
  const issued = Number(v);
  const now = (cfg.now ?? (() => new Date()))().getTime();
  return (
    Number.isFinite(issued) && now - issued < SESSION_DAYS * 24 * 3600 * 1000
  );
}
