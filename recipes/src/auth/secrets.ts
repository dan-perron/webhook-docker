import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, base64url. */
export const randomToken = () => randomBytes(32).toString('base64url');

export const sha256 = (s: string) =>
  createHash('sha256').update(s).digest('base64url');

/** Constant-time string comparison (hashes first so lengths match). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** PKCE S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return safeEqual(sha256(verifier), challenge);
}
