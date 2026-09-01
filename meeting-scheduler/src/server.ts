import { serve } from '@hono/node-server';
import { app } from './app.js';
import { appConfig } from './config.js';
import { ensureIndexes } from './db/connection.js';

await ensureIndexes();

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(
    `meeting-scheduler listening on http://localhost:${info.port}${appConfig.basePath}`
  );
});
