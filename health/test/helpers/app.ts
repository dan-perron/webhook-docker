import type { Db } from 'mongodb';
import { createApp } from '../../src/app.js';
import { HealthStore } from '../../src/db/store.js';

export const TOKEN = 'health-token';

/** A settable clock; starts Saturday 2026-11-07, noon in Chicago. */
export function clock(iso = '2026-11-07T18:00:00Z') {
  const c = { at: new Date(iso), set: (s: string) => (c.at = new Date(s)) };
  return c;
}

export async function setup(db: Db, c = clock()) {
  const store = new HealthStore(db, {
    timeZone: 'America/Chicago',
    maxRangeDays: 366,
    now: () => c.at,
  });
  await store.ensureIndexes();
  const app = createApp(store, { appToken: TOKEN, basePath: '' });
  return { app, store, clock: c };
}

type App = ReturnType<typeof createApp>;

/** Call MCP tools over HTTP like the gateway does; returns parsed text. */
export function mcpClient(app: App) {
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
      // plain-text result or error
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { isError: !!body.result.isError, text, data: data as any };
  };
  /** call, throwing on a tool error. */
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name}: ${r.text}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return r.data as any;
  };
  return { rpc, call, ok };
}
