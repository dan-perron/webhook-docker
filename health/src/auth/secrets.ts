import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (hashes first so lengths match). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
