// Normalize a base path: '' (root), or '/meet' (leading slash, no trailing).
function normalizeBasePath(value) {
  if (!value) return '';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

const config = {
  // Port the Hono server listens on inside the container.
  port: process.env.PORT || 3002,
  // Sub-path the app is served under, e.g. "/meet" when Apache proxies a path
  // on the main domain. Empty = served at the domain root. Affects every
  // generated URL (links, forms, /static, redirects) and route registration.
  basePath: normalizeBasePath(process.env.BASE_PATH || ''),
  mongodb: {
    // Provided via env in production (same convention as webhook-server).
    connectionString:
      process.env.MONGODB_CONNSTRING || 'mongodb://localhost:27017',
    // Env-driven so a dev run can point at a scratch database and never
    // scribble on real events.
    database: process.env.MONGODB_DATABASE || 'scheduler',
  },
  // Timezone offered as the default when creating an event. Every slot in an
  // event is a wall-clock time in that event's own timezone.
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/Chicago',
  // Cookies are Secure by default. MUST be false for plain-http local dev, or
  // the browser accepts Set-Cookie and then silently never sends it back.
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  // Absolute origin this app is reached at, e.g. "https://djperron.com".
  // Required for correct share links: the Apache vhost in front of us does not
  // set ProxyPreserveHost, so the Host header we see is localhost:3002.
  publicOrigin: (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, ''),
  // Appended to static asset URLs to bust caches on deploy. Bump when you
  // change grid.js or styles.css.
  assetVersion: process.env.ASSET_VERSION || '7',
};
module.exports = config;
