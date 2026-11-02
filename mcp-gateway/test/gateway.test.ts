import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { OAuthStore } from '../src/auth/oauthStore.js';
import { BackendPool, type Backend } from '../src/mcp/backends.js';
import { testDb } from './helpers/mongo.js';

const TOKEN = 'gateway-token';

/** A stand-alone app with a stateless MCP endpoint, like bet-tracker's. */
function fakeBackend(
  name: string,
  token: string,
  register: (s: McpServer) => void,
  instructions: string
) {
  const app = new Hono();
  let calls = 0;
  app.all('/mcp', async (c) => {
    if (c.req.header('authorization') !== `Bearer ${token}`)
      return c.json({ error: 'unauthorized' }, 401);
    calls++;
    const server = new McpServer({ name, version: '1' }, { instructions });
    register(server);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  return { app, calls: () => calls };
}

const bets = fakeBackend(
  'bets',
  'bets-token',
  (s) => {
    s.registerTool(
      'list_bets',
      { description: 'List bets', inputSchema: { status: z.string() } },
      async ({ status }) => ({
        content: [{ type: 'text', text: `bets:${status}` }],
      })
    );
    s.registerTool('shared_name', { description: 'bets copy' }, async () => ({
      content: [{ type: 'text', text: 'from bets' }],
    }));
  },
  'Bet instructions.'
);
const recipes = fakeBackend(
  'recipes',
  'recipes-token',
  (s) => {
    s.registerTool(
      'add_recipe',
      { description: 'Add a recipe', inputSchema: { title: z.string() } },
      async ({ title }) => ({
        content: [{ type: 'text', text: `added ${title}` }],
      })
    );
    s.registerTool(
      'shared_name',
      { description: 'recipes copy' },
      async () => ({ content: [{ type: 'text', text: 'from recipes' }] })
    );
  },
  'Recipe instructions.'
);

const up = new Set(['bets', 'recipes']);
const fakeFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const host = new URL(req.url).hostname;
  if (!up.has(host)) throw new TypeError('fetch failed');
  const app = host === 'bets' ? bets.app : recipes.app;
  return app.fetch(req);
};

const BACKENDS: Backend[] = [
  { name: 'bets', url: 'http://bets/mcp', token: 'bets-token' },
  { name: 'recipes', url: 'http://recipes/mcp', token: 'recipes-token' },
];

let db: Db;
beforeAll(async () => {
  db = await testDb();
});

function gateway(now = () => 0) {
  const logs: string[] = [];
  const pool = new BackendPool(BACKENDS, {
    cacheSeconds: 60,
    fetch: fakeFetch,
    now,
    log: (m) => logs.push(m),
  });
  const app = createApp({
    appToken: TOKEN,
    publicOrigin: 'https://djperron.com',
    store: new OAuthStore(db, { redirectAllowlist: [] }),
    pool,
  });
  let id = 0;
  const rpc = async (method: string, params: unknown = {}) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((await res.json()) as any).result;
  };
  return { app, pool, rpc, logs };
}

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe('gateway', () => {
  it('merges instructions from every backend', async () => {
    const { rpc } = gateway();
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    expect(init.serverInfo.name).toBe('djperron');
    expect(init.instructions).toContain('## bets\nBet instructions.');
    expect(init.instructions).toContain('## recipes\nRecipe instructions.');
  });

  it('lists every tool once; a clash keeps the first backend and is logged', async () => {
    const { rpc, logs } = gateway();
    const { tools } = await rpc('tools/list');
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'add_recipe',
      'list_bets',
      'shared_name',
    ]);
    const shared = tools.find(
      (t: { name: string }) => t.name === 'shared_name'
    );
    expect(shared.description).toBe('bets copy');
    expect(logs.join('\n')).toContain(
      'recipes: tool shared_name already provided by bets'
    );
    // Input schemas pass through untouched.
    const add = tools.find((t: { name: string }) => t.name === 'add_recipe');
    expect(add.inputSchema.properties.title.type).toBe('string');
  });

  it('routes calls to the owning backend with its token', async () => {
    const { rpc } = gateway();
    expect(
      text(
        await rpc('tools/call', {
          name: 'list_bets',
          arguments: { status: 'open' },
        })
      )
    ).toBe('bets:open');
    expect(
      text(
        await rpc('tools/call', {
          name: 'add_recipe',
          arguments: { title: 'Chili' },
        })
      )
    ).toBe('added Chili');
  });

  it('caches discovery between requests', async () => {
    const { rpc } = gateway();
    await rpc('tools/list');
    const before = bets.calls();
    await rpc('tools/list');
    expect(bets.calls()).toBe(before);
  });

  it('leaves out a backend that is down; the rest keep working', async () => {
    up.delete('bets');
    try {
      const { rpc, app } = gateway();
      const { tools } = await rpc('tools/list');
      expect(tools.map((t: { name: string }) => t.name).sort()).toEqual([
        'add_recipe',
        'shared_name',
      ]);
      const unknown = await rpc('tools/call', {
        name: 'list_bets',
        arguments: { status: 'open' },
      });
      expect(unknown.isError).toBe(true);
      const health = await (await app.request('/mcp/healthz')).json();
      expect(health.errors[0]).toContain('bets: unreachable');
    } finally {
      up.add('bets');
    }
  });

  it('a backend failing mid-call returns a tool error, not a crash', async () => {
    const { rpc } = gateway();
    await rpc('tools/list');
    up.delete('recipes');
    try {
      const r = await rpc('tools/call', {
        name: 'add_recipe',
        arguments: { title: 'x' },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('The recipes app did not answer');
    } finally {
      up.add('recipes');
    }
  });

  it('a tool that appears later is found by re-discovering', async () => {
    let t = 0;
    up.delete('recipes');
    const { rpc } = gateway(() => t);
    try {
      await rpc('tools/list');
    } finally {
      up.add('recipes');
    }
    t = 1000; // still inside the cache window
    const r = await rpc('tools/call', {
      name: 'add_recipe',
      arguments: { title: 'Soup' },
    });
    expect(text(r)).toBe('added Soup');
  });
});
