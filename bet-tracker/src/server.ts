import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { appConfig } from './config.js';
import { openDb } from './db/client.js';
import { createServices } from './services.js';

if (!appConfig.auth.appToken) {
  console.error('APP_TOKEN must be set.');
  process.exit(1);
}

const db = openDb(appConfig.databasePath);
const services = createServices(db);
const { tracker, scores } = services;
const app = createApp(services, {
  appToken: appConfig.auth.appToken,
  publicOrigin: appConfig.publicOrigin,
  extraRedirectUris: appConfig.auth.extraRedirectUris,
  timeZone: appConfig.timezone,
});

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
// Apply the current models to stored state right away (e.g. after a deploy).
const boot = tracker.reevaluateAll();
console.log(`re-evaluated ${boot.evaluatedEvents.length} events at startup`);
setInterval(tick, TICK_MS);
void tick();

// Add followed teams' upcoming games to Scores.
async function discover() {
  try {
    const r = await scores.discover();
    for (const e of r.errors) console.warn(`scores: ${e}`);
  } catch (e) {
    console.error('scores discovery failed', e);
  }
}
setInterval(discover, appConfig.scores.discoverMinutes * 60_000);
void discover();
if (!scores.pushConfigured) console.log('scores: NTFY_URL not set; push off');

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(`bet-tracker listening on http://localhost:${info.port}`);
});
