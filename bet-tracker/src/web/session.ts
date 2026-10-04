import { createHmac } from 'node:crypto';
import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { safeEqual } from '../auth/secrets.js';

// Browser session for the web page: log in once with APP_TOKEN, get a signed
// httpOnly cookie holding the login time. The signing key is derived from
// APP_TOKEN, so rotating the token logs every browser out.

const COOKIE = 'bets_session';
export const SESSION_DAYS = 30;

export interface SessionConfig {
  appToken: string;
  /** Cookie path (the app's base path, or "/"). */
  path: string;
  /** Secure cookies need https; off only for plain-http local runs. */
  secure: boolean;
  now?: () => Date;
}

const key = (appToken: string) =>
  createHmac('sha256', appToken)
    .update('bet-tracker web session')
    .digest('base64url');

export function tokenMatches(cfg: SessionConfig, candidate: unknown): boolean {
  return typeof candidate === 'string' && safeEqual(candidate, cfg.appToken);
}

export async function startSession(c: Context, cfg: SessionConfig) {
  const now = (cfg.now ?? (() => new Date()))();
  await setSignedCookie(c, COOKIE, String(now.getTime()), key(cfg.appToken), {
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
  const v = await getSignedCookie(c, key(cfg.appToken), COOKIE);
  if (!v) return false;
  const issued = Number(v);
  const now = (cfg.now ?? (() => new Date()))().getTime();
  return (
    Number.isFinite(issued) && now - issued < SESSION_DAYS * 24 * 3600 * 1000
  );
}
