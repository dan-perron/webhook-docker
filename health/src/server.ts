import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { appConfig } from './config.js';
import { connectDb } from './db.js';
import { HealthStore } from './db/store.js';

if (!appConfig.auth.appToken) {
  console.error('HEALTH_APP_TOKEN must be set.');
  process.exit(1);
}

const { db } = await connectDb(appConfig.mongo.uri, appConfig.mongo.database);
const store = new HealthStore(db, {
  timeZone: appConfig.timezone,
  maxRangeDays: appConfig.maxRangeDays,
});
await store.ensureIndexes();

const app = createApp(store, {
  appToken: appConfig.auth.appToken,
  basePath: appConfig.basePath,
});

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(
    `health listening on http://localhost:${info.port}${appConfig.basePath}`
  );
});
