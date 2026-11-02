import { createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  DEFAULT_REDIRECT_ALLOWLIST,
  isAllowedRedirect,
  OAuthStore,
} from '../src/auth/oauthStore.js';
import { BackendPool } from '../src/mcp/backends.js';
import { testDb } from './helpers/mongo.js';

const ORIGIN = 'https://djperron.com';
const ISSUER = `${ORIGIN}/mcp`;
const TOKEN = 'app-token-for-tests';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let db: Db;
let app: ReturnType<typeof createApp>;
// Real time, not a fixed date: Mongo's TTL monitor purges by wall clock.
let clock: Date;

beforeAll(async () => {
  db = await testDb();
});

beforeEach(async () => {
  clock = new Date();
  const store = new OAuthStore(db, {
    redirectAllowlist: DEFAULT_REDIRECT_ALLOWLIST,
    now: () => clock,
  });
  await store.ensureIndexes();
  app = createApp({
    appToken: TOKEN,
    publicOrigin: ORIGIN,
    store,
    pool: new BackendPool([], { cacheSeconds: 60 }),
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
  const res = await app.request('/mcp/oauth/register', {
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
  scope: 'mcp',
});

async function authorize(clientId: string, token = TOKEN) {
  return app.request(
    '/mcp/oauth/authorize',
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
    '/mcp/oauth/token',
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
      await app.request('/mcp/.well-known/oauth-protected-resource')
    ).json();
    expect(pr).toMatchObject({
      resource: ISSUER,
      authorization_servers: [ISSUER],
    });
    const as = await (
      await app.request('/mcp/.well-known/oauth-authorization-server')
    ).json();
    expect(as).toMatchObject({
      issuer: ISSUER,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(
      await (await app.request('/mcp/.well-known/openid-configuration')).json()
    ).toEqual(as);
  });
});

describe('/mcp auth', () => {
  it('401 points at the resource metadata', async () => {
    const res = await mcpInit();
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`
    );
    const bad = await mcpInit('nope');
    expect(bad.headers.get('www-authenticate')).toContain(
      'error="invalid_token"'
    );
  });

  it('accepts MCP_APP_TOKEN as a bearer token', async () => {
    const res = await mcpInit(TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe('djperron');
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
    expect(isAllowedRedirect(uri, DEFAULT_REDIRECT_ALLOWLIST)).toBe(ok);
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
      `/mcp/oauth/authorize?${new URLSearchParams(authorizeParams(client.client_id))}`
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Connect Claude');

    const res = await authorize(client.client_id);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CALLBACK);
    expect(loc.searchParams.get('state')).toBe('xyz');
    expect(loc.searchParams.get('iss')).toBe(ISSUER);

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
    const refresh = () =>
      app.request(
        '/mcp/oauth/token',
        form({
          grant_type: 'refresh_token',
          refresh_token: t.refresh_token,
          client_id: client.client_id,
        })
      );
    const t2 = (await (await refresh()).json()) as { access_token: string };
    expect((await mcpInit(t2.access_token)).status).toBe(200);
    expect((await refresh()).status).toBe(400);
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

  it('two concurrent exchanges of one code issue tokens only once', async () => {
    const { body: client } = await register();
    const code = await codeFor(client.client_id);
    const results = await Promise.all([
      exchange(client.client_id, code),
      exchange(client.client_id, code),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
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
      '/mcp/oauth/authorize',
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
    const res = await app.request(`/mcp/oauth/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('requires S256 PKCE', async () => {
    const { body: client } = await register();
    const q = new URLSearchParams({
      ...authorizeParams(client.client_id),
      code_challenge_method: 'plain',
    });
    expect((await app.request(`/mcp/oauth/authorize?${q}`)).status).toBe(400);
  });
});
