import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { appConfig } from './config.js';
import { connectDb } from './db.js';
import { createServices } from './services.js';

if (!appConfig.auth.password || !appConfig.auth.appToken) {
  console.error('RECIPES_PASSWORD and RECIPES_APP_TOKEN must be set.');
  process.exit(1);
}

const { db } = await connectDb(appConfig.mongo.uri, appConfig.mongo.database);
const services = createServices(db, {
  recommend: appConfig.recommend,
  appUrl: `${appConfig.publicOrigin}${appConfig.basePath}`,
  timeZone: appConfig.timezone,
});
await services.store.ensureIndexes();

const app = createApp(services, {
  password: appConfig.auth.password,
  appToken: appConfig.auth.appToken,
  cookieSecure: appConfig.auth.cookieSecure,
});

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(
    `recipes listening on http://localhost:${info.port}${appConfig.basePath}`
  );
});
