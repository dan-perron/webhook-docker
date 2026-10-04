// Normalize a base path: '' (root), or '/bets' (leading slash, no trailing).
function normalizeBasePath(value) {
  if (!value) return '';
  const trimmed = String(value).replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const config = {
  // Port the Hono server listens on inside the container.
  port: process.env.PORT || 3003,
  // Sub-path the app is served under, e.g. "/bets" when Apache proxies a path
  // on the main domain. Empty = served at the domain root.
  basePath: normalizeBasePath(process.env.BASE_PATH || ''),
  // Absolute origin (no trailing slash). OAuth metadata for the remote MCP
  // endpoint must advertise absolute URLs.
  publicOrigin: (process.env.PUBLIC_ORIGIN || 'http://localhost:3003').replace(
    /\/+$/,
    ''
  ),
  // SQLite file. Lives on a named volume in production.
  databasePath: process.env.DATABASE_PATH || './data/bet-tracker.sqlite',
  timezone: process.env.TZ || 'America/Chicago',
  auth: {
    // Bearer token for the HTTP API/MCP and the password for the web login.
    // Empty disables the server (it refuses to start without one outside tests).
    appToken: process.env.APP_TOKEN || '',
    // Extra exact OAuth redirect URIs to accept (comma-separated). Claude's
    // connector callbacks and loopback URIs are always allowed.
    extraRedirectUris: (process.env.OAUTH_EXTRA_REDIRECT_URIS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  oddsApi: {
    // Never logged. Empty disables odds calls (check_odds returns an error).
    apiKey: process.env.ODDS_API_KEY || '',
    baseUrl: 'https://api.the-odds-api.com/v4',
    // Odds responses are cached this long (seconds).
    cacheSeconds: 60,
    // check_odds calls costing more than this many requests need confirm: true.
    confirmAboveCost: 3,
    // Take one odds snapshot per event shortly before start to set the prior.
    pregameSnapshot: process.env.PREGAME_SNAPSHOT !== 'false',
    // How long before scheduled start the pregame snapshot is taken (minutes).
    pregameSnapshotLeadMinutes: 20,
    regions: 'us',
  },
  polling: {
    // Seconds between game-state polls for events with an open bet.
    liveSeconds: 30,
    scheduledSeconds: 600,
  },
  models: {
    // Std dev (points) of the final scoring margin over a full game.
    football: {
      // sigmaRange bounds the per-game σ fitted to the moneyline.
      nfl: {
        marginSigma: envNumber('NFL_MARGIN_SIGMA', 13.5),
        totalSigma: 13,
        sigmaRange: [10, 16],
      },
      ncaaf: {
        marginSigma: envNumber('NCAAF_MARGIN_SIGMA', 15),
        totalSigma: 14,
        sigmaRange: [11, 20],
      },
    },
    mlb: { simulations: 10000 },
  },
};
module.exports = config;
