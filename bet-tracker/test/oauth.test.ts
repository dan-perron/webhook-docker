import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { isAllowedRedirect } from '../src/auth/oauthStore.js';
import { openDb } from '../src/db/client.js';
import { createProviders } from '../src/gamestate/registry.js';
import type { Services } from '../src/mcp/server.js';
import { OddsApiClient } from '../src/odds/oddsApi.js';
import { Tracker } from '../src/tracker/tracker.js';
import { fakeFetcher } from './helpers/fixtures.js';
import { PARAMS } from './helpers/states.js';

const ORIGIN = 'https://djperron.com';
const TOKEN = 'app-token-for-tests';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let app: ReturnType<typeof createApp>;
let clock: Date;

beforeEach(() => {
  const db = openDb(':memory:');
  const providers = createProviders(fakeFetcher({}).fetcher);
  clock = new Date('2026-10-03T21:00:00.000Z');
  const services: Services = {
    db,
    providers,
    tracker: new Tracker(db, providers, {
      params: PARAMS,
      polling: { liveSeconds: 30, scheduledSeconds: 600 },
    }),
    odds: new OddsApiClient(db, {
      apiKey: '',
      baseUrl: 'x',
      regions: 'us',
      cacheSeconds: 60,
    }),
    confirmAboveCost: 3,
  };
  app = createApp(services, {
    appToken: TOKEN,
    publicOrigin: ORIGIN,
    now: () => clock,
  });
});

const form = (data: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(data).toString(),
});

const mcpInit = (auth?: string) =>
  app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    }),
  });

async function register(redirect = CALLBACK) {
  const res = await app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  });
  return {
    res,
    body: (await res.json()) as { client_id: string; error?: string },
  };
}

const authorizeParams = (clientId: string) => ({
  client_id: clientId,
  redirect_uri: CALLBACK,
  response_type: 'code',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  state: 'xyz',
  scope: 'bets',
});

async function authorize(clientId: string, token = TOKEN) {
  return app.request(
    '/oauth/authorize',
    form({ ...authorizeParams(clientId), app_token: token, decision: 'allow' })
  );
}

async function codeFor(clientId: string) {
  const res = await authorize(clientId);
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!).searchParams.get('code')!;
}

const exchange = (clientId: string, code: string, verifier = VERIFIER) =>
  app.request(
    '/oauth/token',
    form({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: verifier,
    })
  );

describe('metadata', () => {
  it('advertises the protected resource and authorization server', async () => {
    const pr = await (
      await app.request('/.well-known/oauth-protected-resource')
    ).json();
    expect(pr).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
    });
    const as = await (
      await app.request('/.well-known/oauth-authorization-server')
    ).json();
    expect(as).toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(
      await (await app.request('/.well-known/openid-configuration')).json()
    ).toEqual(as);
  });
});

describe('/mcp auth', () => {
  it('401 points at the resource metadata', async () => {
    const res = await mcpInit();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
    );
    const bad = await mcpInit('nope');
    expect(bad.headers.get('www-authenticate')).toContain(
      'error="invalid_token"'
    );
  });

  it('accepts APP_TOKEN as a bearer token', async () => {
    const res = await mcpInit(TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe('bet-tracker');
  });
});

describe('redirect allowlist', () => {
  it.each([
    [CALLBACK, true],
    ['https://claude.com/api/mcp/auth_callback', true],
    ['http://localhost:51234/callback', true],
    ['http://127.0.0.1:8080/cb', true],
    ['https://evil.example/callback', false],
    ['https://claude.ai.evil.example/api/mcp/auth_callback', false],
    ['http://user:pw@localhost/cb', false],
    ['not a url', false],
  ])('%s -> %s', (uri, ok) => {
    expect(
      isAllowedRedirect(uri, [
        CALLBACK,
        'https://claude.com/api/mcp/auth_callback',
      ])
    ).toBe(ok);
  });

  it('registration rejects other redirect URIs', async () => {
    const { res, body } = await register('https://evil.example/cb');
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
  });
});

describe('authorization code + PKCE flow', () => {
  it('end to end: register, consent, exchange, call MCP, refresh', async () => {
    const { body: client } = await register();
    const page = await app.request(
      `/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id))}`
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connect Claude');

    const res = await authorize(client.client_id);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('iss')).toBe(ORIGIN);

    const tok = await exchange(client.client_id, loc.searchParams.get('code')!);
    expect(tok.status).toBe(200);
    expect(tok.headers.get('cache-control')).toBe('no-store');
    const t = (await tok.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(t.expires_in).toBe(3600);
    expect((await mcpInit(t.access_token)).status).toBe(200);

    // Refresh rotates: the old refresh token stops working.
    const r1 = await app.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.client_id,
      })
    );
    const t2 = (await r1.json()) as { access_token: string };
    expect((await mcpInit(t2.access_token)).status).toBe(200);
    const again = await app.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.client_id,
      })
    );
    expect(again.status).toBe(400);
  });

  it('access tokens expire after an hour', async () => {
    const { body: client } = await register();
    const t = (await (
      await exchange(client.client_id, await codeFor(client.client_id))
    ).json()) as { access_token: string };
    clock = new Date(clock.getTime() + 3601_000);
    expect((await mcpInit(t.access_token)).status).toBe(401);
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { body: client } = await register();
    const res = await exchange(
      client.client_id,
      await codeFor(client.client_id),
      'b'.repeat(64)
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'invalid_grant'
    );
  });

  it('a replayed code fails and revokes tokens already issued from it', async () => {
    const { body: client } = await register();
    const code = await codeFor(client.client_id);
    const t = (await (await exchange(client.client_id, code)).json()) as {
      access_token: string;
    };
    expect((await exchange(client.client_id, code)).status).toBe(400);
    expect((await mcpInit(t.access_token)).status).toBe(401);
  });

  it('codes expire after 5 minutes', async () => {
    const { body: client } = await register();
    const code = await codeFor(client.client_id);
    clock = new Date(clock.getTime() + 301_000);
    expect((await exchange(client.client_id, code)).status).toBe(400);
  });

  it('wrong app token is refused, then rate limited after 10 tries', async () => {
    const { body: client } = await register();
    for (let i = 0; i < 10; i++)
      expect((await authorize(client.client_id, 'wrong')).status).toBe(401);
    expect((await authorize(client.client_id, TOKEN)).status).toBe(429);
  });

  it('deny redirects back with access_denied', async () => {
    const { body: client } = await register();
    const res = await app.request(
      '/oauth/authorize',
      form({ ...authorizeParams(client.client_id), decision: 'deny' })
    );
    expect(
      new URL(res.headers.get('location')!).searchParams.get('error')
    ).toBe('access_denied');
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const { body: client } = await register();
    const q = new URLSearchParams({
      ...authorizeParams(client.client_id),
      redirect_uri: 'https://evil.example/cb',
    });
    const res = await app.request(`/oauth/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('requires S256 PKCE', async () => {
    const { body: client } = await register();
    const q = new URLSearchParams({
      ...authorizeParams(client.client_id),
      code_challenge_method: 'plain',
    });
    expect((await app.request(`/oauth/authorize?${q}`)).status).toBe(400);
  });
});
