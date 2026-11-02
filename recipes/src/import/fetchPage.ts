import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Fetch a recipe page for import. Only public http(s) hosts: every hop of a
// redirect is resolved and refused if it points at a private, loopback or
// link-local address (this runs inside the home network).

export class FetchRefused extends Error {}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
// An honest user agent: bot protection that spots a fake browser one (e.g.
// Budget Bytes) blocks it, while some sites (Allrecipes) block us either way.
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; RecipeBox/1.0; +https://djperron.com/recipes)',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.8',
};

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]!);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff')
  );
}

type Resolver = (host: string) => Promise<string[]>;
const dnsResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((a) => a.address);

async function checkUrl(raw: string, resolve: Resolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchRefused(`Not a URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new FetchRefused('Only http(s) links can be imported.');
  if (u.username || u.password)
    throw new FetchRefused('Links with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (!addrs.length) throw new FetchRefused(`Can't find the site ${host}.`);
  if (addrs.some(isPrivateAddress))
    throw new FetchRefused('That link points inside the home network.');
  return u;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break; // JSON-LD is in the <head>; a truncated page is fine.
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GET a public page's HTML; returns it with the final URL after redirects. */
export async function fetchPage(
  raw: string,
  opts: { fetch?: typeof fetch; resolve?: Resolver } = {}
): Promise<{ html: string; url: string }> {
  const doFetch = opts.fetch ?? fetch;
  const resolve = opts.resolve ?? dnsResolver;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await checkUrl(current, resolve);
    let res: Response;
    try {
      res = await doFetch(u, { headers: HEADERS, redirect: 'manual', signal });
    } catch (e) {
      throw new FetchRefused(
        `Couldn't load ${u.hostname}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new FetchRefused('Redirect without a location.');
      current = new URL(next, u).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 429)
      throw new FetchRefused(
        `${u.hostname} refused the request (${res.status}); it blocks automated fetches. Open the page and enter the recipe by hand (or have Claude read the page and add it).`
      );
    if (!res.ok)
      throw new FetchRefused(`${u.hostname} answered ${res.status}.`);
    return { html: await readCapped(res), url: u.toString() };
  }
  throw new FetchRefused('Too many redirects.');
}
