// Normalize a base path: '' (root), or '/health' (leading slash, no trailing).
function normalizeBasePath(value) {
  if (!value) return '';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

const config = {
  // Port the Hono server listens on inside the container.
  port: process.env.PORT || 3007,
  // Sub-path the app is served under, e.g. "/health".
  basePath: normalizeBasePath(process.env.BASE_PATH || ''),
  mongo: {
    uri: process.env.MONGODB_CONNSTRING || 'mongodb://localhost:27017',
    database: process.env.MONGODB_DATABASE || 'health',
  },
  timezone: process.env.TZ || 'America/Chicago',
  auth: {
    // Bearer token for /mcp (mcp-gateway).
    appToken: process.env.HEALTH_APP_TOKEN || '',
  },
  // Longest date range health_report will scan.
  maxRangeDays: 366,
};
module.exports = config;
