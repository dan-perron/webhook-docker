import { readFileSync } from 'node:fs';
import type { Db } from 'mongodb';
import { createApp } from '../../src/app.js';
import { createServices } from '../../src/services.js';
import { appConfig } from '../../src/config.js';

export const TOKEN = 'recipes-token';
export const PASSWORD = 'family-password';
export const NOW = new Date('2026-10-26T18:00:00Z'); // 1 pm in Chicago

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}.html`, import.meta.url), 'utf8');

/** Pages served by the fake fetcher, by URL. */
export const PAGES: Record<string, string> = {
  'https://www.budgetbytes.com/one-pot-creamy-cajun-chicken-pasta/':
    fixture('budgetbytes'),
  'https://www.bbcgoodfood.com/recipes/easy-chicken-curry':
    fixture('bbcgoodfood'),
  'https://example.com/no-recipe': '<html><body>Just a blog</body></html>',
};

const fakeFetch = (async (u: URL | string) => {
  const html = PAGES[String(u)];
  return html
    ? new Response(html, { headers: { 'content-type': 'text/html' } })
    : new Response('missing', { status: 404 });
}) as unknown as typeof fetch;

export async function setup(db: Db) {
  const services = createServices(db, {
    recommend: appConfig.recommend,
    appUrl: 'https://djperron.com/recipes',
    timeZone: 'America/Chicago',
    now: () => NOW,
    fetch: fakeFetch,
    resolve: async () => ['93.184.215.14'],
  });
  await services.store.ensureIndexes();
  const app = createApp(services, {
    password: PASSWORD,
    appToken: TOKEN,
    cookieSecure: false,
    now: () => NOW,
  });
  return { app, services, store: services.store };
}

/** Call one MCP tool over HTTP like the gateway does; returns parsed text. */
export function mcpClient(app: ReturnType<typeof createApp>) {
  let id = 0;
  const rpc = async (method: string, params: unknown, token = TOKEN) =>
    app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc('tools/call', { name, arguments: args });
    const body = (await res.json()) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    const text = body.result.content[0]!.text;
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain-text error
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { isError: !!body.result.isError, text, data: data as any };
  };
  return { rpc, call };
}
