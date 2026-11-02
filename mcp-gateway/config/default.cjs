// Normalize a base path: '' (root), or '/mcp' (leading slash, no trailing).
function normalizeBasePath(value) {
  if (!value) return '';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

/**
 * Backends from MCP_BACKENDS: comma-separated `name=url`, e.g.
 * "bets=http://bet-tracker:3003/bets/mcp,recipes=http://recipes:3004/recipes/mcp".
 * Each backend's bearer token comes from MCP_TOKEN_<NAME> (upper-cased).
 */
function backends(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf('=');
      if (i < 1)
        throw new Error(`MCP_BACKENDS entry "${entry}" is not name=url`);
      const name = entry.slice(0, i).trim();
      return {
        name,
        url: entry.slice(i + 1).trim(),
        token: process.env[`MCP_TOKEN_${name.toUpperCase()}`] || '',
      };
    });
}

const config = {
  // Port the Hono server listens on inside the container.
  port: process.env.PORT || 3005,
  // Sub-path the gateway is served under. The MCP endpoint is the base path
  // itself (https://djperron.com/mcp).
  basePath: normalizeBasePath(process.env.BASE_PATH || '/mcp'),
  // Absolute origin (no trailing slash); OAuth metadata needs absolute URLs.
  publicOrigin: (process.env.PUBLIC_ORIGIN || 'http://localhost:3005').replace(
    /\/+$/,
    ''
  ),
  mongo: {
    uri: process.env.MONGODB_CONNSTRING || 'mongodb://localhost:27017',
    database: process.env.MONGODB_DATABASE || 'mcp',
  },
  auth: {
    // Static bearer token (Claude Code, scripts) and the OAuth consent
    // password. The server refuses to start without one.
    appToken: process.env.MCP_APP_TOKEN || '',
    // Extra exact OAuth redirect URIs to accept (comma-separated). Claude's
    // connector callbacks and loopback URIs are always allowed.
    extraRedirectUris: (process.env.OAUTH_EXTRA_REDIRECT_URIS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  backends: backends(process.env.MCP_BACKENDS),
  // How long the merged tool list and instructions are reused (seconds).
  discoveryCacheSeconds: 60,
};
module.exports = config;
