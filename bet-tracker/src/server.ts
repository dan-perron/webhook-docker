import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { appConfig } from './config.js';
import { openDb } from './db/client.js';

if (!appConfig.auth.appToken) {
  console.error('APP_TOKEN must be set.');
  process.exit(1);
}

const db = openDb(appConfig.databasePath);
const app = createApp(db);

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(`bet-tracker listening on http://localhost:${info.port}`);
});
