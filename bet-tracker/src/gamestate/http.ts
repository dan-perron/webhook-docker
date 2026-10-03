import type { Fetcher } from './types.js';

/** GET a JSON document with a timeout. Throws on non-2xx. */
export const fetchJson: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bet-tracker (personal use)' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET ${new URL(url).pathname} -> ${res.status}`);
  }
  return res.json();
};
