import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { appConfig } from './config.js';
import { openDb } from './db/client.js';
import { createProviders } from './gamestate/registry.js';
import { Tracker } from './tracker/tracker.js';

if (!appConfig.auth.appToken) {
  console.error('APP_TOKEN must be set.');
  process.exit(1);
}

const db = openDb(appConfig.databasePath);
const tracker = new Tracker(db, createProviders(), {
  params: appConfig.models,
  polling: appConfig.polling,
});
const app = createApp(db);

// The tracker decides per event when a poll is due; tick often and cheaply.
const TICK_MS = 5_000;
async function tick() {
  try {
    const r = await tracker.tick();
    for (const e of r.errors) console.warn(`tracker: ${e}`);
  } catch (e) {
    console.error('tracker tick failed', e);
  }
}
setInterval(tick, TICK_MS);
void tick();

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(`bet-tracker listening on http://localhost:${info.port}`);
});
