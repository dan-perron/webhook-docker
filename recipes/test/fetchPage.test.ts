import { describe, expect, it } from 'vitest';
import {
  FetchRefused,
  fetchPage,
  isPrivateAddress,
} from '../src/import/fetchPage.js';

describe('isPrivateAddress', () => {
  it.each([
    ['10.0.0.5', true],
    ['127.0.0.1', true],
    ['192.168.1.20', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['151.101.1.1', false],
    ['::1', true],
    ['fd12::1', true],
    ['fe80::1', true],
    ['::ffff:192.168.1.1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700::1111', false],
  ])('%s -> %s', (ip, priv) => {
    expect(isPrivateAddress(ip)).toBe(priv);
  });
});

const publicDns = async () => ['93.184.215.14'];

describe('fetchPage', () => {
  it('refuses non-http(s), credentials and private hosts', async () => {
    const f = (u: string, resolve = publicDns) =>
      fetchPage(u, { resolve, fetch: async () => new Response('x') });
    await expect(f('file:///etc/passwd')).rejects.toThrow(FetchRefused);
    await expect(f('https://u:p@example.com/')).rejects.toThrow('credentials');
    await expect(f('http://192.168.1.10/')).rejects.toThrow(
      'inside the home network'
    );
    await expect(
      f('https://sneaky.example/', async () => ['8.8.8.8', '10.0.0.1'])
    ).rejects.toThrow('inside the home network');
  });

  it('re-checks every redirect hop', async () => {
    const hosts: Record<string, string[]> = {
      'good.example': ['93.184.215.14'],
      'internal.example': ['10.1.2.3'],
    };
    const fetch = (async (u: URL) =>
      u.hostname === 'good.example'
        ? new Response(null, {
            status: 302,
            headers: { location: 'http://internal.example/admin' },
          })
        : new Response('secret')) as unknown as typeof globalThis.fetch;
    await expect(
      fetchPage('https://good.example/r', {
        fetch,
        resolve: async (h) => hosts[h] ?? [],
      })
    ).rejects.toThrow('inside the home network');
  });

  it('follows public redirects and returns the final URL', async () => {
    const fetch = (async (u: URL) =>
      u.pathname === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response(
            '<html>ok</html>'
          )) as unknown as typeof globalThis.fetch;
    const page = await fetchPage('https://a.example/old', {
      fetch,
      resolve: publicDns,
    });
    expect(page).toEqual({
      html: '<html>ok</html>',
      url: 'https://a.example/new',
    });
  });

  it('explains a site that blocks automated fetches', async () => {
    const fetch = (async () =>
      new Response('no', {
        status: 403,
      })) as unknown as typeof globalThis.fetch;
    await expect(
      fetchPage('https://blocked.example/', { fetch, resolve: publicDns })
    ).rejects.toThrow('blocks automated fetches');
  });
});
