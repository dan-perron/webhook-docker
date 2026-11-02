import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { DEFAULT_REDIRECT_ALLOWLIST, OAuthStore } from './auth/oauthStore.js';
import { appConfig } from './config.js';
import { connectDb } from './db.js';
import { BackendPool } from './mcp/backends.js';

if (!appConfig.auth.appToken) {
  console.error('MCP_APP_TOKEN must be set.');
  process.exit(1);
}
if (!appConfig.backends.length) {
  console.warn('MCP_BACKENDS is empty; the gateway will have no tools.');
}

const { db } = await connectDb(appConfig.mongo.uri, appConfig.mongo.database);
const store = new OAuthStore(db, {
  redirectAllowlist: [
    ...DEFAULT_REDIRECT_ALLOWLIST,
    ...appConfig.auth.extraRedirectUris,
  ],
});
await store.ensureIndexes();

const pool = new BackendPool(appConfig.backends, {
  cacheSeconds: appConfig.discoveryCacheSeconds,
});
const app = createApp({
  appToken: appConfig.auth.appToken,
  publicOrigin: appConfig.publicOrigin,
  store,
  pool,
});

serve({ fetch: app.fetch, port: appConfig.port }, (info) => {
  console.log(
    `mcp-gateway listening on http://localhost:${info.port}${appConfig.basePath} (backends: ${appConfig.backends.map((b) => b.name).join(', ') || 'none'})`
  );
});
