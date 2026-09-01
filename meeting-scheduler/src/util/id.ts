import { randomBytes } from 'node:crypto';

// Crockford-ish base32 minus the characters people misread aloud (I, L, O, U).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 8 chars ≈ 40 bits. The event URL is the only access control, so make it unguessable. */
export function newSlug(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** 128 bits of opaque token. Stored in a cookie, looked up server-side. */
export function newToken(): string {
  return randomBytes(16).toString('hex');
}
