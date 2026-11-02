// Normalize a base path: '' (root), or '/recipes' (leading slash, no trailing).
function normalizeBasePath(value) {
  if (!value) return '';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

const config = {
  // Port the Hono server listens on inside the container.
  port: process.env.PORT || 3004,
  // Sub-path the app is served under, e.g. "/recipes" behind Apache.
  basePath: normalizeBasePath(process.env.BASE_PATH || ''),
  // Absolute origin (no trailing slash), for links in MCP results.
  publicOrigin: (process.env.PUBLIC_ORIGIN || 'http://localhost:3004').replace(
    /\/+$/,
    ''
  ),
  mongo: {
    uri: process.env.MONGODB_CONNSTRING || 'mongodb://localhost:27017',
    database: process.env.MONGODB_DATABASE || 'recipes',
  },
  timezone: process.env.TZ || 'America/Chicago',
  auth: {
    // Web page login (compose passes MCP_APP_TOKEN).
    password: process.env.RECIPES_PASSWORD || '',
    // Bearer token for /mcp (the gateway uses it).
    appToken: process.env.RECIPES_APP_TOKEN || '',
    // Secure cookies need https; false only to test over plain http.
    cookieSecure: process.env.COOKIE_SECURE !== 'false',
  },
  recommend: {
    // Prior for a member's unrated recipes: their mean rating, pulled toward
    // `neutral` as if they had `priorWeight` extra ratings of it.
    neutral: 3.5,
    priorWeight: 3,
    // Any eater rating a recipe at or below this vetoes it.
    vetoAt: 2,
    // Subtracted per star of disagreement (max - min across eaters).
    spreadPenalty: 0.25,
    // Made recently: minus `recencyPenalty` stars x e^(-days / recencyDays).
    recencyPenalty: 2,
    recencyDays: 21,
    // Added when no eater has rated it yet, so new recipes come up.
    newBonus: 0.3,
  },
};
module.exports = config;
